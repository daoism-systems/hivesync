import { WakuConfig } from '../types';
import { Transport } from './transport';
import { logger } from '../utils/logger';

// `@waku/sdk` is ESM-only and its type exports don't resolve cleanly under the
// CommonJS build. Since the module is loaded dynamically at runtime, we keep the
// node/encoder/decoder loosely typed here rather than coupling to its d.ts.
type WakuNodeLike = any;
type DecodedMessage = { payload?: Uint8Array };

/**
 * `@waku/sdk` is shipped as ESM-only. This project compiles to CommonJS, so a
 * top-level `import`/`require` of it fails at runtime. We load it lazily with a
 * dynamic `import()`, which works from CJS, and cache the module.
 */
type WakuSdk = typeof import('@waku/sdk');
let sdkPromise: Promise<WakuSdk> | null = null;
function loadSdk(): Promise<WakuSdk> {
  if (!sdkPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    sdkPromise = new Function('return import("@waku/sdk")')() as Promise<WakuSdk>;
  }
  return sdkPromise;
}

// Relay mode needs @waku/relay (createRelayNode), @waku/utils (createRoutingInfo)
// and @multiformats/multiaddr (to dial the hub). All ESM-only; loaded lazily.
let relayPromise: Promise<any> | null = null;
function loadRelay(): Promise<any> {
  if (!relayPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    relayPromise = new Function('return import("@waku/relay")')() as Promise<any>;
  }
  return relayPromise;
}
let utilsPromise: Promise<any> | null = null;
function loadUtils(): Promise<any> {
  if (!utilsPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    utilsPromise = new Function('return import("@waku/utils")')() as Promise<any>;
  }
  return utilsPromise;
}
let maPromise: Promise<any> | null = null;
function loadMultiaddr(): Promise<any> {
  if (!maPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    maPromise = new Function('return import("@multiformats/multiaddr")')() as Promise<any>;
  }
  return maPromise;
}
let wsPromise: Promise<any> | null = null;
function loadWebSockets(): Promise<any> {
  if (!wsPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    wsPromise = new Function('return import("@libp2p/websockets")')() as Promise<any>;
  }
  return wsPromise;
}
let wsFilterPromise: Promise<any> | null = null;
function loadWebSocketFilters(): Promise<any> {
  if (!wsFilterPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    wsFilterPromise = new Function('return import("@libp2p/websockets/filters")')() as Promise<any>;
  }
  return wsFilterPromise;
}
let cryptoKeysPromise: Promise<any> | null = null;
function loadCryptoKeys(): Promise<any> {
  if (!cryptoKeysPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    cryptoKeysPromise = new Function('return import("@libp2p/crypto/keys")')() as Promise<any>;
  }
  return cryptoKeysPromise;
}

/**
 * Load a persisted libp2p private key from `path`, or generate one and save it
 * (0600). Returns undefined if no path is configured. A stable key means a
 * stable peerId across restarts — essential for a relay hub whose multiaddr is
 * baked into spoke configs.
 */
async function loadOrCreatePeerKey(path?: string): Promise<any | undefined> {
  if (!path) return undefined;
  const fs = await import('fs');
  const keys = await loadCryptoKeys();
  if (fs.existsSync(path)) {
    return keys.privateKeyFromProtobuf(new Uint8Array(fs.readFileSync(path)));
  }
  const key = await keys.generateKeyPair('Ed25519');
  fs.writeFileSync(path, Buffer.from(keys.privateKeyToProtobuf(key)), { mode: 0o600 });
  logger.info(`Generated persistent peer key at ${path} (peerId is now stable across restarts)`);
  return key;
}

/**
 * Multiaddr fragments identifying nodes of fleets we must NOT peer with.
 *
 * The public infrastructure runs two SEPARATE fleets — sandbox
 * (*.waku.sandbox.status.im) and test (*.waku.test.statusim.net) — and they are
 * DISJOINT relay meshes: a message LightPushed into one is never seen by the
 * other's Filter/Store nodes. Bootstrapping from both (which the SDK's
 * defaultBootstrap does) splits agents across meshes at random, producing the
 * "A sends fine, B never receives" one-way comms we kept chasing. All HiveSync
 * traffic lives on the sandbox fleet (verified via scripts/store-census.ts:
 * sandbox store had every agent's messages, test store had zero), so we pin
 * every discovery path to sandbox and filter test-fleet nodes out everywhere.
 */
const FOREIGN_FLEET_RE = /waku\.test\.|test\.statusim\.net/;

/** Keep only multiaddrs that are not on a foreign (non-sandbox) fleet. */
function dropForeignFleet(addrs: string[]): string[] {
  return addrs.filter((a) => !FOREIGN_FLEET_RE.test(a));
}

/**
 * Resolve the public Waku fleet's enrTree to dialable WSS multiaddrs using the
 * *system* DNS resolver (node:dns), bypassing the SDK's default DNS-over-HTTPS
 * discovery path.
 *
 * The SDK discovers fleet nodes by resolving enrTree TXT records over DoH
 * (cloudflare-dns.com / dns.google). Some networks — CI sandboxes, restrictive
 * corporate egress, anything spawned without open outbound HTTPS — block those
 * DoH endpoints while plain system DNS still resolves the very same records. In
 * that case defaultBootstrap finds 0 peers and every LightPush reports
 * "delivered to 0 peers". Resolving the same enrTree over the OS resolver and
 * pinning the results as static bootstrap peers sidesteps the block.
 *
 * Returns [] on any failure (no records, library shape change, timeout) so the
 * caller can fall back to the SDK's built-in discovery unchanged.
 */
async function resolveBootstrapViaSystemDns(maxPeers = 5, timeoutMs = 8000): Promise<string[]> {
  const collect = async (): Promise<string[]> => {
    const dns = await import('dns/promises');
    // @waku/discovery is ESM-only (no `require` export). tsc would downlevel a
    // bare `import()` to require() under module:commonjs and break it, so force
    // a native dynamic import via Function — same trick as loadSdk() above.
    const { DnsNodeDiscovery, enrTree } = (await new Function(
      'return import("@waku/discovery")'
    )()) as typeof import('@waku/discovery');
    // DnsNodeDiscovery only needs a client exposing resolveTXT(domain) => string[].
    const sysResolver = {
      resolveTXT: async (domain: string): Promise<string[]> => {
        const recs = await dns.resolveTxt(domain);
        return recs.map((chunks) => chunks.join(''));
      },
    };
    const disco = new (DnsNodeDiscovery as any)(sysResolver);
    // Sandbox ONLY — never mix fleets (see FOREIGN_FLEET_RE above).
    const trees = [enrTree.SANDBOX];
    const found = new Set<string>();
    for await (const peer of disco.getNextPeer(trees)) {
      let mas: string[] = [];
      try {
        mas = ((peer as any).peerInfo?.multiaddrs ?? []).map((m: any) => m.toString());
      } catch {
        /* malformed ENR — skip */
      }
      // Light nodes dial out over websockets, so we only want ws/wss addrs.
      for (const ma of mas) if (/\/wss?(\/|$)/.test(ma)) found.add(ma);
      if (found.size >= maxPeers) break;
    }
    return [...found];
  };
  // Cap total time so a hung/slow resolver can't stall node startup.
  const collected = collect().catch((e) => {
    logger.debug('system-DNS bootstrap resolution failed:', e);
    return [] as string[];
  });
  const timed = new Promise<string[]>((res) => setTimeout(() => res([]), timeoutMs));
  return Promise.race([collected, timed]);
}

/**
 * Load previously cached service-node multiaddrs (peers that proved useful in a
 * past run). Returns [] if the file is missing or unreadable — the cache is a
 * best-effort accelerator, never a hard dependency.
 */
export function loadPeerCache(cachePath?: string): string[] {
  if (!cachePath) return [];
  try {
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(cachePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    // Only keep dialable ws/wss multiaddrs that carry a /p2p/ id, and drop any
    // foreign-fleet nodes an older (fleet-mixing) build may have cached.
    return dropForeignFleet(
      parsed.filter(
        (m: unknown): m is string =>
          typeof m === 'string' && /\/wss?(\/|$)/.test(m) && m.includes('/p2p/')
      )
    );
  } catch (e) {
    logger.debug('peer cache read failed:', e);
    return [];
  }
}

/**
 * Persist up to `max` proven service-node multiaddrs, most-recent first. Writes
 * atomically-ish (best effort) and never throws — a failed cache write must not
 * disrupt messaging.
 */
export function savePeerCache(cachePath: string | undefined, addrs: string[], max: number): void {
  if (!cachePath || addrs.length === 0) return;
  try {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const deduped = [...new Set(addrs)].slice(0, max);
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(deduped, null, 2), { mode: 0o600 });
  } catch (e) {
    logger.debug('peer cache write failed:', e);
  }
}

/** The peerId of a multiaddr (the part after `/p2p/`), or the whole string. */
function peerIdOf(multiaddr: string): string {
  return multiaddr.split('/p2p/')[1] || multiaddr;
}

/**
 * Merge two multiaddr lists, `primary` first, dropping any `extra` entry whose
 * peerId already appears in `primary` (the same node reached via a second
 * address is redundant for bootstrap).
 */
export function mergeByPeerId(primary: string[], extra: string[]): string[] {
  const seen = new Set(primary.map(peerIdOf));
  const merged = [...primary];
  for (const addr of extra) {
    if (!seen.has(peerIdOf(addr))) {
      seen.add(peerIdOf(addr));
      merged.push(addr);
    }
  }
  return merged;
}

export type RawMessageHandler = (payload: Uint8Array) => void;

/**
 * Thin wrapper over a Waku **light node**: connect, publish bytes to the
 * configured content topic, and subscribe to receive bytes.
 *
 * WHY A LIGHT NODE (and not a Relay node):
 * HiveSync agents run on VPSs behind NAT / cloud proxies and are NOT reachable
 * from the outside. A Relay node has to graft itself into the GossipSub mesh,
 * which (a) needs inbound reachability to be useful and (b) fragments into
 * disjoint meshes when only 2-3 of our own nodes are involved. That is the
 * "messages never arrive" failure we hit.
 *
 * A light node instead dials *out* to the public Waku Network's service nodes
 * and uses request/response protocols over those outbound streams:
 *   - LightPush (send): a service node publishes our message into the mesh.
 *   - Filter   (recv): a service node pushes matching messages back to us.
 *   - Store    (recv): poll a service node for anything Filter missed.
 * All three work through outbound connections, so NAT is a non-issue and the
 * well-connected fleet provides the mesh backbone. This is the model Waku
 * designed for resource-restricted / non-reachable nodes, and the one the
 * original HiveSync prototype used successfully.
 *
 * All HiveSync-level concerns (framing, identity, encryption, routing) live
 * above this layer.
 */
export class WakuTransport implements Transport {
  private node: WakuNodeLike | null = null;
  private encoder: any = null;
  private decoder: any = null;
  private readonly config: WakuConfig;
  private handler: RawMessageHandler | null = null;
  private started = false;
  private storePollTimer: NodeJS.Timeout | null = null;
  private filterHealthTimer: NodeJS.Timeout | null = null;
  private redialTimer: NodeJS.Timeout | null = null;
  private peerCacheTimer: NodeJS.Timeout | null = null;
  private lastStoreQueryTime: Date | null = null;
  private storePolling = false;
  private relayUnsub: (() => void) | null = null;
  // Serializes + paces outbound LightPush so bursts don't trip fleet rate limits.
  private sendChain: Promise<void> = Promise.resolve();
  private lastSendAt = 0;
  /** Track peers that recently rejected a LightPush so we blacklist them. */
  private rejectedPeers: Map<string, number> = new Map();

  constructor(config: WakuConfig) {
    this.config = config;
  }

  private get isRelay(): boolean {
    return this.config.mode === 'relay';
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Multiaddrs other agents can dial to reach this node (useful for a hub). */
  getDialableMultiaddrs(): string[] {
    try {
      return (this.node?.libp2p.getMultiaddrs() ?? []).map((m: any) => m.toString());
    } catch {
      return [];
    }
  }

  pubsubTopic(): string | undefined {
    return (this.decoder as any)?.pubsubTopic;
  }

  async start(peerWaitTimeoutMs = 30000): Promise<void> {
    if (this.isRelay) return this.startRelay(peerWaitTimeoutMs);
    return this.startLight(peerWaitTimeoutMs);
  }

  /**
   * Relay mode: run a GossipSub relay node. The hub sets listenAddresses and
   * (typically) no directPeers; spokes set directPeers=[hub multiaddr]. Once
   * connected and subscribed to the same content topic, all nodes form one
   * mesh and the hub relays between spokes — no LightPush, no public fleet.
   */
  private async startRelay(peerWaitTimeoutMs: number): Promise<void> {
    const [relayMod, utils] = await Promise.all([loadRelay(), loadUtils()]);
    const { createRelayNode } = relayMod;
    const { createRoutingInfo } = utils;

    const networkConfig = {
      clusterId: this.config.clusterId,
      numShardsInCluster: this.config.numShardsInCluster,
    };
    const routingInfo = createRoutingInfo(networkConfig, {
      contentTopic: this.config.contentTopic,
    });

    // Pure private mesh by default (no public fleet): connectivity comes from
    // listenAddresses (hub) + directPeers (spokes dial the hub). Set
    // bootstrapNodes to also peer with extra relay nodes if desired.
    const useBootstrap = !!this.config.bootstrapNodes?.length;
    const libp2p: any = {
      addresses: { listen: this.config.listenAddresses ?? [] },
      // Allow plain (non-TLS) ws multiaddrs so a Node hub can listen on /ws
      // and Node spokes can dial it. Without this the SDK restricts to wss.
      filterMultiaddrs: false,
    };

    // Stable peerId across restarts (so the hub's multiaddr never changes).
    const peerKey = await loadOrCreatePeerKey(this.config.peerKeyPath);
    if (peerKey) libp2p.privateKey = peerKey;

    // WSS: to listen on a `/tls/ws` address we must hand the websockets
    // transport an https server (cert + key). Override the SDK's default
    // transport with one configured for TLS.
    if (this.config.tls) {
      const fs = await import('fs');
      const [{ webSockets }, { all }] = await Promise.all([
        loadWebSockets(),
        loadWebSocketFilters(),
      ]);
      const https = {
        cert: fs.readFileSync(this.config.tls.certPath),
        key: fs.readFileSync(this.config.tls.keyPath),
      };
      libp2p.transports = [webSockets({ filter: all, https })];
      logger.info('Relay hub listening over secure WebSocket (wss)');
    }

    this.node = await createRelayNode({
      defaultBootstrap: false,
      bootstrapPeers: useBootstrap ? this.config.bootstrapNodes : undefined,
      networkConfig,
      routingInfos: [routingInfo],
      libp2p,
    } as any);

    await this.node.start();

    this.encoder = this.node.createEncoder({ contentTopic: this.config.contentTopic });
    this.decoder = this.node.createDecoder({ contentTopic: this.config.contentTopic });

    // Dial the hub / configured peers, then keep redialing so a dropped link to
    // the hub self-heals (the mesh depends on this connection staying up).
    await this.dialDirectPeers();
    this.redialTimer = setInterval(() => void this.dialDirectPeers(), 20000);
    this.redialTimer.unref?.();

    // Best-effort wait for at least one relay peer (the hub).
    const deadline = Date.now() + peerWaitTimeoutMs;
    while (Date.now() < deadline && (await this.getPeerCount()) === 0) {
      await delay(1000);
    }

    this.started = true;
    logger.info(`Waku relay node started (peerId ${this.node.peerId.toString()})`);
    const addrs = this.getDialableMultiaddrs();
    if (addrs.length) {
      logger.info(`Relay listening — dialable as:\n  ${addrs.join('\n  ')}`);
    }
    logger.info(`Relay peers connected: ${await this.getPeerCount()}`);
  }

  /** Dial every configured directPeer; idempotent and safe to call repeatedly. */
  private async dialDirectPeers(): Promise<void> {
    const peers = this.config.directPeers ?? [];
    if (!peers.length || !this.node) return;
    const ma = await loadMultiaddr();
    for (const addr of peers) {
      try {
        await this.node.libp2p.dial(ma.multiaddr(addr));
      } catch (err) {
        logger.warn(`Relay dial failed for ${addr}: ${(err as Error).message}`);
      }
    }
  }

  private async startLight(peerWaitTimeoutMs: number): Promise<void> {
    // The SDK logs the REAL LightPush failure reason (e.g. "v3 status code 505:
    // No relay peers available") only through its `debug` logger, and our
    // publish() otherwise sees a bare "Remote peer rejected". Set
    // HIVESYNC_WAKU_DEBUG=1 to surface those lines — invaluable for diagnosing
    // why sending fails on a given host. Must be enabled before the SDK loads.
    if (process.env.HIVESYNC_WAKU_DEBUG && !process.env.DEBUG) {
      process.env.DEBUG = 'waku:*light-push*,waku:*sdk:light-push*,waku:*peer-manager*';
    }
    const sdk = await loadSdk();
    const { createLightNode, waitForRemotePeer, Protocols } = sdk;

    const networkConfig = {
      clusterId: this.config.clusterId,
      numShardsInCluster: this.config.numShardsInCluster,
    };

    const useDefaultBootstrap =
      !this.config.bootstrapNodes || this.config.bootstrapNodes.length === 0;

    // Static bootstrap seeds. If the operator pinned bootstrapNodes, use exactly
    // those. Otherwise proactively resolve the public fleet's enrTree over the
    // SYSTEM resolver and pin the results — keeps the node connectable where the
    // SDK's DNS-over-HTTPS discovery is blocked but plain DNS still works. This
    // is additive: defaultBootstrap (DoH + peer-exchange + peer-cache) still runs
    // below, so healthy networks are unaffected; the seeds are a fallback path.
    let bootstrapPeers = this.config.bootstrapNodes;
    if (useDefaultBootstrap) {
      const sysPeers = await resolveBootstrapViaSystemDns();
      if (sysPeers.length) {
        logger.info(
          `Pinned ${sysPeers.length} fleet bootstrap peer(s) via system DNS (DoH-independent)`
        );
        bootstrapPeers = sysPeers;
      }
      // Re-seed peers that proved useful in a past run. On hosts where discovery
      // is flaky this is often the difference between landing on a working peer
      // set and timing out at 0 peers. Cached peers come first (known-good), then
      // any fresh enrTree seeds, deduped by peerId so the same node via two
      // addresses isn't dialed twice.
      const cached = loadPeerCache(this.config.peerCachePath);
      if (cached.length) {
        bootstrapPeers = mergeByPeerId(cached, bootstrapPeers ?? []);
        logger.info(`Re-seeded ${cached.length} proven peer(s) from cache`);
      }
      // First-run warm cache: persist the resolved enrTree seeds right away so
      // even the very next restart has a known-dialable fallback set, before the
      // periodic snapshot has had a chance to run.
      if (!cached.length && bootstrapPeers && bootstrapPeers.length) {
        savePeerCache(this.config.peerCachePath, bootstrapPeers, this.config.peerCacheSize ?? 20);
      }
    }

    // A light node connects OUT to the public fleet; it does not need to listen
    // for inbound dials. defaultBootstrap discovers The Waku Network service
    // nodes via DNS discovery + the static bootstrap list.
    //
    // numPeersToUse: the SDK defaults to 1 — every LightPush goes to a SINGLE
    // service node. If that node can't relay our shard (status 505 NO_PEERS) or
    // its stream is reset (common from NAT'd / proxied VPSs), the whole publish
    // fails. Fanning out to several peers in parallel means the message is sent
    // as long as ANY one of them accepts it — the single most effective fix for
    // "LightPush delivered to 0 peers" on the public fleet.
    // numPeersToUse is honored at runtime (WakuNode -> PeerManager) but is not
    // in the SDK's CreateNodeOptions d.ts, hence the cast.
    const peerKey = await loadOrCreatePeerKey(this.config.peerKeyPath);
    // Keep defaultBootstrap's peer-exchange + peer-cache discovery, but replace
    // its DNS discovery: the SDK resolves BOTH fleet enrTrees (sandbox + test)
    // over DoH, which splits agents across two disjoint meshes (see
    // FOREIGN_FLEET_RE). We disable it and inject a sandbox-only wakuDnsDiscovery
    // instead, so hosts where DoH works still get DNS discovery — fleet-pinned.
    let sandboxDnsDiscovery: unknown[] = [];
    try {
      const { wakuDnsDiscovery, enrTree } = (await new Function(
        'return import("@waku/discovery")'
      )()) as typeof import('@waku/discovery');
      sandboxDnsDiscovery = [wakuDnsDiscovery([enrTree.SANDBOX])];
    } catch (e) {
      logger.debug('sandbox DNS discovery unavailable:', e);
    }
    this.node = await createLightNode({
      defaultBootstrap: useDefaultBootstrap,
      discovery: { dns: false, peerExchange: true, peerCache: true },
      bootstrapPeers: bootstrapPeers && bootstrapPeers.length ? bootstrapPeers : undefined,
      networkConfig,
      numPeersToUse: this.config.lightPushPeers ?? 3,
      libp2p: {
        ...(peerKey ? { privateKey: peerKey } : {}),
        ...(sandboxDnsDiscovery.length ? { peerDiscovery: sandboxDnsDiscovery } : {}),
      },
    } as any);

    await this.node.start();

    // Wait for peers that speak the protocols we actually use. We don't hard
    // fail if only some are available — a partial set (e.g. Filter but not yet
    // LightPush) is still useful, and the bridge resends until delivery.
    await waitForRemotePeer(
      this.node,
      [Protocols.LightPush, Protocols.Filter, Protocols.Store],
      peerWaitTimeoutMs
    ).catch(() => {
      logger.warn('Timed out waiting for Waku peers — continuing, will retry on use');
    });

    // Accumulate more peers before allowing sends to start.  The first peer
    // often arrives quickly, but the initial sync/announce burst (37+ msgs)
    // will overwhelm a single peer and trigger rate-limiting.  Waiting for
    // `lightPushPeers` connections spreads the burst across the pool.
    const targetPeers = this.config.lightPushPeers ?? 3;
    const peerDeadline = Date.now() + 10000;
    while (Date.now() < peerDeadline) {
      try {
        const count = (await this.node.libp2p.getPeers()).filter(
          (p: any) => p.protocols?.has(Protocols.LightPush) ?? true
        ).length;
        if (count >= targetPeers) break;
      } catch { /* ignore */ }
      await delay(500);
    }

    // The node derives the pubsub topic/shard from its networkConfig + content topic.
    this.encoder = this.node.createEncoder({ contentTopic: this.config.contentTopic });
    this.decoder = this.node.createDecoder({ contentTopic: this.config.contentTopic });

    this.started = true;
    logger.info(`Waku light node connected (peerId ${this.node.peerId.toString()})`);
    logger.info(
      `Protocols — LightPush: ${!!this.node.lightPush}, Filter: ${!!this.node.filter}, Store: ${!!this.node.store}`
    );

    this.startPeerCachePersistence();
    this.startReconnectWatchdog();
  }

  /**
   * Light-mode connectivity watchdog. A light node leans on the public fleet,
   * and the system-DNS enrTree seeds are applied only ONCE at startup. If the
   * node later drops to 0 peers (fleet churn, a transient network blip), nothing
   * re-seeds it — it stays dark until the process restarts. This periodically
   * checks the peer count and, when it hits 0, re-dials the proven peer cache
   * plus freshly re-resolved enrTree seeds. Live recovery, no restart needed.
   */
  private startReconnectWatchdog(): void {
    this.redialTimer = setInterval(() => void this.reseedIfIsolated(), 20000);
    this.redialTimer.unref?.();
  }

  private async reseedIfIsolated(): Promise<void> {
    if (!this.started || !this.node) return;
    let count = 0;
    try {
      count = (await this.node.libp2p.getPeers()).length;
    } catch {
      return;
    }
    if (count > 0) return; // at least one peer — the SDK's peer manager tops up the rest

    logger.warn('Light node at 0 peers — re-seeding from peer cache + enrTree');
    const candidates = new Set<string>(loadPeerCache(this.config.peerCachePath));
    const fresh = await resolveBootstrapViaSystemDns().catch(() => [] as string[]);
    for (const a of fresh) candidates.add(a);
    if (!candidates.size) return;

    const ma = await loadMultiaddr();
    let dialed = 0;
    for (const addr of candidates) {
      try {
        await this.node.libp2p.dial(ma.multiaddr(addr));
        dialed++;
      } catch (e) {
        logger.debug(`re-seed dial failed for ${addr}: ${(e as Error).message}`);
      }
    }
    if (dialed) logger.info(`Re-seed dialed ${dialed} peer(s) after 0-peer drop`);
  }

  /**
   * Periodically snapshot the dialable multiaddrs of currently-connected service
   * nodes and persist them, so a later start can re-seed a known-good peer set
   * instead of relying solely on (flaky) discovery. Best-effort, never throws.
   */
  private startPeerCachePersistence(): void {
    if (!this.config.peerCachePath) return;
    // One snapshot soon after connect, then refresh on an interval.
    setTimeout(() => this.snapshotPeersToCache(), 10000).unref?.();
    this.peerCacheTimer = setInterval(() => this.snapshotPeersToCache(), 60000);
    this.peerCacheTimer.unref?.();
  }

  /** Persist the dialable multiaddrs of currently-connected service nodes. */
  private snapshotPeersToCache(): void {
    if (!this.config.peerCachePath || !this.node) return;
    try {
      const conns = (this.node.libp2p.getConnections?.() ?? []) as any[];
      const addrs: string[] = [];
      for (const c of conns) {
        const ma = c?.remoteAddr?.toString?.();
        if (!ma || !/\/wss?(\/|$)/.test(ma)) continue; // light nodes dial ws/wss only
        const peerId = c?.remotePeer?.toString?.();
        addrs.push(ma.includes('/p2p/') || !peerId ? ma : `${ma}/p2p/${peerId}`);
      }
      // Never persist foreign-fleet peers (peer exchange can still surface them).
      const sameFleet = dropForeignFleet(addrs);
      if (sameFleet.length) {
        savePeerCache(this.config.peerCachePath, sameFleet, this.config.peerCacheSize ?? 20);
      }
    } catch (e) {
      logger.debug('peer cache snapshot failed:', e);
    }
  }

  async subscribe(handler: RawMessageHandler): Promise<void> {
    this.handler = handler;

    if (this.isRelay) {
      if (!this.node?.relay || !this.decoder) throw new Error('Waku transport not started');
      // Receive straight off the GossipSub mesh — no Filter/Store needed.
      this.relayUnsub = this.node.relay.subscribeWithUnsubscribe([this.decoder], (msg: DecodedMessage) => {
        if (msg.payload && msg.payload.length > 0 && this.handler) this.handler(msg.payload);
      });
      logger.info(`Relay subscribed to ${this.config.contentTopic}`);
      return;
    }

    if (!this.node?.filter || !this.decoder) {
      throw new Error('Waku transport not started');
    }

    // Primary RECEIVE path: Filter. A service node subscribes to the mesh on
    // our behalf and pushes matching messages down our outbound stream.
    await this.filterSubscribe();

    // Safety net: poll Store for anything Filter dropped (subscriptions can be
    // evicted by the service node, especially across reconnects). Cheap and
    // de-duplicated upstream by message id in the bridge.
    if (this.node?.store) {
      this.startStorePolling();
    }

    // Filter subscriptions are not forever — periodically re-subscribe so a
    // silently-dropped subscription self-heals without a restart.
    this.startFilterHealth();
  }

  /** (Re)establish the Filter subscription. Safe to call repeatedly. */
  private async filterSubscribe(): Promise<number> {
    if (!this.node?.filter || !this.decoder || !this.handler) return 0;
    try {
      const result = await this.node.filter.subscribe(this.decoder, (msg: DecodedMessage) => {
        if (msg.payload && msg.payload.length > 0 && this.handler) {
          this.handler(msg.payload);
        }
      });

      if (result?.error) {
        logger.warn(`Waku filter subscribe failed: ${result.error}`);
        return 0;
      }
      const successes = result?.results?.successes?.length ?? 0;
      const failures = result?.results?.failures?.length ?? 0;
      if (successes > 0) {
        logger.info(`Filter subscribed to ${this.config.contentTopic} (${successes} peer(s))`);
      } else if (failures > 0) {
        logger.warn('Filter subscribe: no peer accepted the subscription (Store fallback active)');
      }
      return successes;
    } catch (err) {
      logger.warn(`Filter subscribe error: ${(err as Error).message}`);
      return 0;
    }
  }

  private startFilterHealth(): void {
    if (this.filterHealthTimer) return;
    // Re-subscribe every 20s. js-waku de-dupes identical subscriptions, so this
    // is a no-op when healthy and a recovery when the subscription was dropped.
    this.filterHealthTimer = setInterval(() => void this.filterSubscribe(), 20000);
    this.filterHealthTimer.unref?.();
  }

  /**
   * Poll the Waku Store protocol every 5 seconds for messages on our content
   * topic since the last query — a backstop for whatever Filter misses.
   */
  private startStorePolling(): void {
    if (this.storePollTimer) return;
    // Start the cursor in the past so the first poll BACKFILLS messages that
    // arrived while we were down (the bridge + DB dedupe re-ingested ones).
    const backfillMs = (this.config.storeBackfillHours ?? 24) * 3600 * 1000;
    this.lastStoreQueryTime = new Date(Date.now() - backfillMs);
    this.storePollTimer = setInterval(() => void this.pollStore(), 5000);
    this.storePollTimer.unref?.();
    logger.info('Started Store polling backstop for message retrieval');
  }

  private async pollStore(): Promise<void> {
    if (this.storePolling || !this.node?.store || !this.decoder || !this.handler) return;
    this.storePolling = true;
    const queryStart = new Date();
    try {
      const queryOpts: any = { paginationLimit: 50, paginationForward: true };
      if (this.lastStoreQueryTime) {
        queryOpts.timeStart = this.lastStoreQueryTime;
      }
      await this.node.store.queryWithOrderedCallback(
        [this.decoder],
        (msg: DecodedMessage) => {
          if (msg.payload && msg.payload.length > 0 && this.handler) {
            this.handler(msg.payload);
          }
        },
        queryOpts
      );
      // Advance the window only after a successful query so a failed poll
      // doesn't create a gap.
      this.lastStoreQueryTime = queryStart;
    } catch (error) {
      logger.warn(`Store polling error: ${(error as Error).message}`);
    } finally {
      this.storePolling = false;
    }
  }

  /**
   * Publish bytes via LightPush. The public fleet has peers that reject pushes
   * (e.g. RLN rate limiting), so a partial success (>=1 peer) counts as sent;
   * we only retry/back off when every peer rejects.
   */
  async publish(payload: Uint8Array, retries = 5): Promise<void> {
    if (this.isRelay) {
      if (!this.node?.relay || !this.encoder) throw new Error('Waku transport not started');
      // Publish into the mesh; the hub forwards to the other spokes. We don't
      // hard-fail on a transient empty result — the bridge resends.
      try {
        const res: any = await this.node.relay.send(this.encoder, { payload });
        if ((res?.successes?.length ?? 0) === 0 && (res?.failures?.length ?? 0) > 0) {
          logger.warn(`Relay send reached 0 mesh peers: ${JSON.stringify(res.failures)}`);
        }
      } catch (err) {
        const msg = (err as Error).message;
        // Expected and harmless while no spokes are connected yet (e.g. a hub
        // waiting for its first peer) — don't spam warnings; the bridge resends.
        if (msg.includes('NoPeersSubscribedToTopic')) {
          logger.debug(`Relay send skipped: no mesh peers yet (${msg})`);
        } else {
          logger.warn(`Relay send error: ${msg}`);
        }
      }
      return;
    }

    if (!this.node?.lightPush || !this.encoder) {
      // Fresh connections sometimes take a moment to discover LightPush peers.
      // Wait with backoff instead of immediately failing.
      let waited = 0;
      while (!this.node?.lightPush && waited < 15000) {
        await delay(1000);
        waited += 1000;
      }
      if (!this.node?.lightPush || !this.encoder) {
        throw new Error('Waku transport not started');
      }
    }

    // PACING: serialize LightPush sends and space them out. A burst (e.g. the
    // outbox draining 37 queued Obsidian updates, each ×retries) hammers the
    // public fleet's service nodes and trips their per-source rate limiting —
    // which comes back as "Remote peer rejected" and looks like a hard failure.
    // The proven-working light-node code is identical to this; what changed is
    // the traffic shape, so we smooth it. Gap is configurable (sendGapMs).
    const gap = this.config.sendGapMs ?? 300;
    const run = this.sendChain.then(async () => {
      const since = Date.now() - this.lastSendAt;
      if (since < gap) await delay(gap - since);
      try {
        await this.lightPushWithRetries(payload, retries);
      } finally {
        this.lastSendAt = Date.now();
      }
    });
    // Keep the chain alive even if this send threw.
    this.sendChain = run.catch(() => undefined);
    return run;
  }

  /** LightPush with retry/back-off + peer rotation (hang up on rejections). */
  private async lightPushWithRetries(payload: Uint8Array, retries: number): Promise<void> {
    // Clear stale entries (> 60s old) from the reject list.
    const staleCutoff = Date.now() - 60000;
    for (const [pid, ts] of this.rejectedPeers) {
      if (ts < staleCutoff) this.rejectedPeers.delete(pid);
    }

    let lastFailures = 'unknown error';
    for (let attempt = 1; attempt <= retries; attempt++) {
      let result: any;
      try {
        result = await this.node.lightPush.send(this.encoder, { payload });
      } catch (error) {
        lastFailures = (error as Error).message;
        result = { successes: [] };
      }
      if ((result.successes?.length ?? 0) > 0) {
        return;
      }
      if (result.failures?.length) {
        lastFailures = JSON.stringify(result.failures);
        for (const f of result.failures) {
          if (f?.peerId) {
            this.rejectedPeers.set(f.peerId, Date.now());
            if (this.node?.libp2p) {
              try { await this.node.libp2p.hangUp(f.peerId); } catch { /* best effort */ }
            }
          }
        }
      }
      logger.warn(`LightPush attempt ${attempt}/${retries} delivered to 0 peers: ${lastFailures}`);
      const backoff = attempt < 3 ? 1500 * attempt : 4000;
      await delay(backoff);
    }

    // Don't crash — push failures are a transient network condition, not fatal.
    // The bridge resends, and the peer can still reach us via Filter/Store.
    logger.warn(`LightPush failed after ${retries} attempts (will be retried): ${lastFailures}`);
  }

  async getPeerCount(): Promise<number> {
    if (!this.node) return 0;
    try {
      const peers = await this.node.libp2p.getPeers();
      return peers.length;
    } catch {
      return 0;
    }
  }

  peerId(): string | undefined {
    return this.node?.peerId.toString();
  }

  async stop(): Promise<void> {
    if (this.peerCacheTimer) {
      clearInterval(this.peerCacheTimer);
      this.peerCacheTimer = null;
    }
    // Final snapshot before shutdown so the freshest peer set is cached.
    this.snapshotPeersToCache();
    if (this.storePollTimer) {
      clearInterval(this.storePollTimer);
      this.storePollTimer = null;
    }
    if (this.filterHealthTimer) {
      clearInterval(this.filterHealthTimer);
      this.filterHealthTimer = null;
    }
    if (this.redialTimer) {
      clearInterval(this.redialTimer);
      this.redialTimer = null;
    }
    if (this.peerCacheTimer) {
      clearInterval(this.peerCacheTimer);
      this.peerCacheTimer = null;
    }
    if (this.relayUnsub) {
      try {
        this.relayUnsub();
      } catch {
        /* ignore */
      }
      this.relayUnsub = null;
    }
    if (this.node) {
      try {
        await this.node.stop();
      } catch (error) {
        logger.warn('Error stopping Waku node:', error);
      }
      this.node = null;
    }
    this.encoder = null;
    this.decoder = null;
    this.handler = null;
    this.started = false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
