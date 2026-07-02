/**
 * Fleet health probe — connects like the HiveSync daemon (light node, system-DNS
 * enrTree resolution) and verifies ALL THREE light protocols against the public
 * fleet: LightPush (send), Filter (subscribe), Store (query). Prints per-peer
 * protocol support so "No peers available to query" stops being a mystery.
 */
const contentTopic = '/hivesync/1/agents/proto';
const clusterId = 1;
const numShardsInCluster = 8;

const loadSdk = () => new Function('return import("@waku/sdk")')() as Promise<any>;
const loadDisco = () => new Function('return import("@waku/discovery")')() as Promise<any>;

function log(...a: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(...a);
}

async function resolveViaSystemDns(maxPeers = 8): Promise<string[]> {
  const dns = await import('dns/promises');
  const { DnsNodeDiscovery, enrTree } = await loadDisco();
  const sysResolver = {
    resolveTXT: async (domain: string): Promise<string[]> => {
      const recs = await dns.resolveTxt(domain);
      return recs.map((chunks) => chunks.join(''));
    },
  };
  const disco = new (DnsNodeDiscovery as any)(sysResolver);
  const found = new Set<string>();
  for await (const peer of disco.getNextPeer([enrTree.SANDBOX, enrTree.TEST])) {
    const mas = ((peer as any).peerInfo?.multiaddrs ?? []).map((m: any) => m.toString());
    for (const ma of mas) if (/\/wss?(\/|$)/.test(ma)) found.add(ma);
    if (found.size >= maxPeers) break;
  }
  return [...found];
}

async function main(): Promise<void> {
  const sdk = await loadSdk();
  const { createLightNode, waitForRemotePeer, Protocols } = sdk;

  log('=== 1. enrTree resolution (system DNS) ===');
  const seeds = await resolveViaSystemDns();
  log(`resolved ${seeds.length} fleet seed(s):`);
  for (const s of seeds) log(`  ${s}`);
  if (!seeds.length) {
    log('FATAL: system DNS resolved 0 fleet nodes');
    process.exit(1);
  }

  log('\n=== 2. connect (like the daemon) ===');
  const node = await createLightNode({
    defaultBootstrap: true,
    bootstrapPeers: seeds,
    networkConfig: { clusterId, numShardsInCluster },
    numPeersToUse: 5,
  });
  await node.start();
  log(`our peerId: ${node.peerId.toString()}`);
  await waitForRemotePeer(node, [Protocols.LightPush, Protocols.Filter, Protocols.Store], 30000)
    .then(() => log('waitForRemotePeer: OK (all three protocols seen)'))
    .catch(() => log('waitForRemotePeer: TIMED OUT (partial connectivity)'));

  // settle
  await new Promise((r) => setTimeout(r, 5000));

  log('\n=== 3. per-peer protocol support ===');
  const CODECS = {
    lightpush: ['/vac/waku/lightpush/3.0.0', '/vac/waku/lightpush/2.0.0-beta1'],
    filter: ['/vac/waku/filter-subscribe/2.0.0-beta1'],
    store: ['/vac/waku/store-query/3.0.0', '/vac/waku/store/2.0.0-beta4'],
  };
  const peerIds = await node.libp2p.getPeers();
  log(`connected peers: ${peerIds.length}`);
  const support: Record<string, number> = { lightpush: 0, filter: 0, store: 0 };
  for (const pid of peerIds) {
    try {
      const p = await node.libp2p.peerStore.get(pid);
      const protos: string[] = p.protocols ?? [];
      const flags = Object.entries(CODECS)
        .map(([k, codecs]) => {
          const has = codecs.some((c) => protos.includes(c));
          if (has) support[k]++;
          return `${k}:${has ? 'Y' : 'n'}`;
        })
        .join(' ');
      log(`  ${pid.toString().slice(-8)}  ${flags}`);
    } catch {
      log(`  ${pid.toString().slice(-8)}  (peerStore miss)`);
    }
  }
  log(`summary: lightpush=${support.lightpush} filter=${support.filter} store=${support.store}`);

  log('\n=== 4. real LightPush publish ===');
  const encoder = node.createEncoder({ contentTopic });
  try {
    const res = await node.lightPush.send(encoder, {
      payload: new TextEncoder().encode(JSON.stringify({ probe: 'fleet-diag', at: 'now' })),
    });
    log(`lightpush: successes=${res.successes?.length ?? 0} failures=${res.failures?.length ?? 0}`);
    for (const f of res.failures ?? []) log(`  failure: ${f.error} (peer ${f.peerId ?? '?'})`);
  } catch (e) {
    log(`lightpush THREW: ${(e as Error).message}`);
  }

  log('\n=== 5. real Store query (last 2h) ===');
  const decoder = node.createDecoder({ contentTopic });
  let stored = 0;
  try {
    await node.store.queryWithOrderedCallback([decoder], () => void stored++, {
      timeStart: new Date(Date.now() - 2 * 3600 * 1000),
    });
    log(`store: query OK, ${stored} message(s) on ${contentTopic} in last 2h`);
  } catch (e) {
    log(`store THREW: ${(e as Error).message}`);
  }

  log('\n=== VERDICT ===');
  log(`seeds=${seeds.length} peers=${peerIds.length} store-capable=${support.store}`);
  await node.stop();
  process.exit(0);
}

main().catch((e) => {
  log('probe failed:', e);
  process.exit(1);
});
