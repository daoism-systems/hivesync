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
type WakuRelayMod = typeof import('@waku/relay');
type WakuUtilsMod = typeof import('@waku/utils');
let sdkPromise: Promise<WakuSdk> | null = null;
let relayModPromise: Promise<WakuRelayMod> | null = null;
let utilsModPromise: Promise<WakuUtilsMod> | null = null;

function loadSdk(): Promise<WakuSdk> {
  if (!sdkPromise) {
    sdkPromise = (new Function('return import("@waku/sdk")')() as Promise<WakuSdk>);
  }
  return sdkPromise;
}

function loadRelayMod(): Promise<WakuRelayMod> {
  if (!relayModPromise) {
    relayModPromise = (new Function('return import("@waku/relay")')() as Promise<WakuRelayMod>);
  }
  return relayModPromise;
}

function loadUtilsMod(): Promise<WakuUtilsMod> {
  if (!utilsModPromise) {
    utilsModPromise = (new Function('return import("@waku/utils")')() as Promise<WakuUtilsMod>);
  }
  return utilsModPromise;
}

export type RawMessageHandler = (payload: Uint8Array) => void;

/**
 * Thin wrapper over a Waku light node: connect, publish bytes to the configured
 * content topic, and subscribe to receive bytes. All HiveSync-level concerns
 * (framing, identity, encryption, routing) live above this layer.
 */
export class WakuTransport implements Transport {
  private node: WakuNodeLike | null = null;
  private encoder: any = null;
  private decoder: any = null;
  private readonly config: WakuConfig;
  private handler: RawMessageHandler | null = null;
  private started = false;
  private storePollTimer: NodeJS.Timeout | null = null;
  private lastStoreQueryTime: Date | null = null;
  private storePolling = false;

  constructor(config: WakuConfig) {
    this.config = config;
  }

  isStarted(): boolean {
    return this.started;
  }

  pubsubTopic(): string | undefined {
    return (this.decoder as any)?.pubsubTopic;
  }

  async start(peerWaitTimeoutMs = 30000): Promise<void> {
    const sdk = await loadSdk();
    const relayMod = await loadRelayMod();
    const utilsMod = await loadUtilsMod();
    const { waitForRemotePeer, Protocols } = sdk;
    // createLibp2pAndUpdateOptions and WakuNode are exported at runtime but
    // not in the .d.ts type definitions (ESM-only package). Cast to any.
    const createLibp2pAndUpdateOptions = (sdk as any).createLibp2pAndUpdateOptions;
    const WakuNode = (sdk as any).WakuNode;
    const { Relay, wakuGossipSub } = relayMod;
    const { createRoutingInfo } = utilsMod;

    const networkConfig = {
      clusterId: this.config.clusterId,
      numShardsInCluster: this.config.numShardsInCluster,
    };

    const useDefaultBootstrap = !this.config.bootstrapNodes || this.config.bootstrapNodes.length === 0;

    // Build routing info from network config + content topic.
    // This determines the pubsub topic (shard) our node subscribes to.
    const routingInfo = createRoutingInfo(networkConfig as any, {
      contentTopic: this.config.contentTopic,
    });

    // HYBRID NODE: Relay (gossipsub) for sending + Filter for receiving.
    //
    // createRelayNode() passes {} as protocolsEnabled, which defaults to
    // { filter: false, lightpush: false, store: false }. This means a
    // pure Relay node has NO Filter — it can only receive via gossipsub
    // mesh. On the Waku testnet, gossipsub mesh forms (3 peers) but
    // messages from light-node agents never reach the mesh because their
    // LightPush sends are rejected by testnet peers.
    //
    // createLightNode() enables Filter but has NO Relay — it can't send
    // via gossipsub, only via LightPush (which is broken on testnet).
    //
    // The solution: create a hybrid node manually. We replicate what
    // createRelayNode does (set up gossipsub as pubsub service, create
    // Relay object) BUT also pass { filter: true } to WakuNode so Filter
    // is enabled. This gives us:
    //   - Relay (gossipsub) for SENDING — broadcasts to mesh peers ✅
    //   - Filter for RECEIVING — full-node peer pushes messages to us ✅
    const nodeOptions: any = {
      defaultBootstrap: useDefaultBootstrap,
      bootstrapPeers: useDefaultBootstrap ? undefined : this.config.bootstrapNodes,
      networkConfig,
      routingInfos: [routingInfo],
      libp2p: {
        addresses: {
          listen: this.config.listenAddresses,
        },
        filterMultiaddrs: false,
        services: {
          pubsub: wakuGossipSub({
            defaultBootstrap: useDefaultBootstrap,
            bootstrapPeers: useDefaultBootstrap ? undefined : this.config.bootstrapNodes,
            networkConfig,
            routingInfos: [routingInfo],
          } as any),
        },
      },
    };

    const libp2p = await createLibp2pAndUpdateOptions(nodeOptions);
    const pubsubTopics = nodeOptions.routingInfos.map((ri: any) => ri.pubsubTopic);
    const relay = new Relay({ pubsubTopics, libp2p } as any);

    // KEY: pass { filter: true } — this is what createRelayNode does NOT do
    this.node = new WakuNode(nodeOptions, libp2p, { filter: true }, relay);

    await this.node.start();

    // Wait for Relay AND Filter peers. Relay for sending, Filter for receiving.
    // Don't block forever if only one protocol's peers are available.
    await waitForRemotePeer(this.node, [Protocols.Relay, Protocols.Filter], peerWaitTimeoutMs).catch(() => {
      logger.warn('Timed out waiting for peers — will continue anyway');
    });

    // Connect to any configured direct peers.
    if (this.config.directPeers && this.config.directPeers.length > 0) {
      for (const peerAddr of this.config.directPeers) {
        try {
          logger.info(`Dialing direct peer: ${peerAddr}`);
          await this.node.libp2p.dial(peerAddr);
          logger.info(`Connected to direct peer: ${peerAddr}`);
        } catch (err) {
          logger.warn(`Failed to dial direct peer ${peerAddr}: ${(err as Error).message}`);
        }
      }
    }

    // The node derives the pubsub topic/shard from its networkConfig + content topic.
    this.encoder = this.node.createEncoder({ contentTopic: this.config.contentTopic });
    this.decoder = this.node.createDecoder({ contentTopic: this.config.contentTopic });

    this.started = true;
    logger.info(`Waku transport connected (peerId ${this.node.peerId.toString()})`);
    logger.info(`Relay enabled: ${!!this.node.relay}, Filter: ${!!this.node.filter}, LightPush: ${!!this.node.lightPush}, Store: ${!!this.node.store}`);
  }

  async subscribe(handler: RawMessageHandler): Promise<void> {
    if (!this.decoder) {
      throw new Error('Waku transport not started');
    }
    this.handler = handler;

    // Primary: Relay (gossipsub) subscribe — most reliable on the testnet.
    if (this.node?.relay) {
      try {
        await this.node.relay.subscribeWithUnsubscribe([this.decoder], (msg: DecodedMessage) => {
          logger.info(`Relay callback fired: payload=${msg.payload?.length ?? 0} bytes`);
          if (msg.payload && msg.payload.length > 0 && this.handler) {
            this.handler(msg.payload);
          } else {
            logger.warn(`Relay message has empty/null payload — skipping`);
          }
        });
        logger.info(`Relay subscribed to ${this.config.contentTopic}`);
      } catch (err) {
        logger.warn(`Relay subscribe error: ${(err as Error).message}`);
      }
    }

    // Secondary: Filter subscribe — this is the primary RECEIVE path.
    // Filter V2: a full-node peer on the testnet subscribes to the gossipsub
    // mesh and pushes matching messages directly to us. This worked reliably
    // before the refactor (when we used createLightNode) and is the reason
    // messages were received. With our hybrid node, Filter is now enabled again.
    let filterPeers = 0;
    if (this.node?.filter) {
      try {
        const result = await this.node.filter.subscribe(this.decoder, (msg: DecodedMessage) => {
          logger.info(`Filter callback fired: payload=${msg.payload?.length ?? 0} bytes`);
          if (msg.payload && this.handler) {
            this.handler(msg.payload);
          }
        });

        if (result.error) {
          logger.warn(`Waku filter subscribe failed: ${result.error}`);
        }
        const failures = result.results?.failures?.length ?? 0;
        const successes = result.results?.successes?.length ?? 0;
        filterPeers = successes;
        if (successes === 0 && failures > 0) {
          logger.warn('Waku filter subscribe: no peer accepted the subscription');
        } else if (successes > 0) {
          logger.info(`Filter subscribed to ${this.config.contentTopic} (${successes} peer(s))`);
        } else {
          logger.info(`Filter subscribe returned: successes=0, failures=0, error=${result.error ?? 'none'} — waiting for peers`);
        }
      } catch (err) {
        logger.warn(`Filter subscribe error: ${(err as Error).message}`);
      }
    }

    // Tertiary: Store polling as a last-resort fallback for message retrieval.
    if (!this.node?.relay && filterPeers === 0) {
      this.startStorePolling();
      logger.info('No Relay or Filter — relying on Store polling for message retrieval');
    } else if (this.node?.store) {
      // Even with Relay, use Store polling to catch messages missed during reconnects.
      this.startStorePolling();
    }
  }

  /**
   * Poll the Waku Store protocol every 5 seconds for messages on our content
   * topic that we may have missed (e.g. when Filter subscribe has 0 peers).
   */
  private startStorePolling(): void {
    if (this.storePollTimer) return;
    this.lastStoreQueryTime = new Date();
    this.storePollTimer = setInterval(() => void this.pollStore(), 5000);
    this.storePollTimer.unref?.();
    logger.info('Started Store polling fallback for message retrieval');
  }

  private async pollStore(): Promise<void> {
    if (this.storePolling || !this.node?.store || !this.decoder || !this.handler) return;
    this.storePolling = true;
    try {
      const queryOpts: any = { pageSize: 50 };
      if (this.lastStoreQueryTime) {
        queryOpts.startTime = this.lastStoreQueryTime;
      }
      let receivedAny = false;
      await this.node.store.queryWithOrderedCallback(
        [this.decoder],
        (msg: DecodedMessage) => {
          if (msg.payload && this.handler) {
            receivedAny = true;
            this.handler(msg.payload);
          }
        },
        queryOpts
      );
      if (receivedAny) {
        logger.info('Store polling retrieved messages');
      }
    } catch (error) {
      logger.warn(`Store polling error: ${(error as Error).message}`);
    } finally {
      this.lastStoreQueryTime = new Date();
      this.storePolling = false;
    }
  }

  /**
   * Publish bytes to the configured content topic.
   * Primary: Relay (gossipsub) broadcast — messages go to all mesh peers.
   * Fallback: LightPush if Relay is not available or fails.
   */
  async publish(payload: Uint8Array, retries = 5): Promise<void> {
    if (!this.encoder) {
      throw new Error('Waku transport not started');
    }

    // Primary: Relay broadcast — most reliable on the testnet.
    if (this.node?.relay) {
      try {
        await this.node.relay.send(this.encoder, { payload });
        return;
      } catch (relayError) {
        logger.warn(`Relay send failed: ${(relayError as Error).message}, falling back to LightPush`);
      }
    }

    // Fallback: LightPush with retries.
    if (!this.node?.lightPush) {
      logger.warn('No Relay or LightPush available — message could not be sent');
      return;
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
      if (result.failures?.length) lastFailures = JSON.stringify(result.failures);
      logger.warn(`LightPush attempt ${attempt}/${retries} delivered to 0 peers: ${lastFailures}`);
      if (attempt < retries) {
        await delay(1500 * attempt);
      }
    }

    // Don't crash — failures are a Waku network condition, not fatal.
    logger.warn(`LightPush failed after ${retries} attempts (agent can still receive): ${lastFailures}`);
  }

  async getPeerCount(): Promise<number> {
    if (!this.node) return 0;
    try {
      const peers = await this.node.getConnectedPeers();
      return peers.length;
    } catch {
      return 0;
    }
  }

  peerId(): string | undefined {
    return this.node?.peerId.toString();
  }

  async stop(): Promise<void> {
    if (this.storePollTimer) {
      clearInterval(this.storePollTimer);
      this.storePollTimer = null;
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
