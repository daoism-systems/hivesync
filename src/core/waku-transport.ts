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
    sdkPromise = (new Function('return import("@waku/sdk")')() as Promise<WakuSdk>);
  }
  return sdkPromise;
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
    const { createLightNode, waitForRemotePeer, Protocols } = sdk;

    const networkConfig = {
      clusterId: this.config.clusterId,
      numShardsInCluster: this.config.numShardsInCluster,
    };

    const useDefaultBootstrap = !this.config.bootstrapNodes || this.config.bootstrapNodes.length === 0;

    this.node = await createLightNode({
      defaultBootstrap: useDefaultBootstrap,
      bootstrapPeers: useDefaultBootstrap ? undefined : this.config.bootstrapNodes,
      networkConfig,
    });

    await this.node.start();
    await waitForRemotePeer(this.node, [Protocols.LightPush, Protocols.Filter], peerWaitTimeoutMs);

    // The node derives the pubsub topic/shard from its networkConfig + content topic.
    this.encoder = this.node.createEncoder({ contentTopic: this.config.contentTopic });
    this.decoder = this.node.createDecoder({ contentTopic: this.config.contentTopic });

    this.started = true;
    logger.info(`Waku transport connected (peerId ${this.node.peerId.toString()})`);
  }

  async subscribe(handler: RawMessageHandler): Promise<void> {
    if (!this.node?.filter || !this.decoder) {
      throw new Error('Waku transport not started');
    }
    this.handler = handler;

    const result = await this.node.filter.subscribe(this.decoder, (msg: DecodedMessage) => {
      if (msg.payload && this.handler) {
        this.handler(msg.payload);
      }
    });

    if (result.error) {
      throw new Error(`Waku filter subscribe failed: ${result.error}`);
    }
    const failures = result.results?.failures?.length ?? 0;
    const successes = result.results?.successes?.length ?? 0;
    if (successes === 0 && failures > 0) {
      throw new Error('Waku filter subscribe: no peer accepted the subscription');
    }
    logger.info(`Subscribed to ${this.config.contentTopic} (${successes} peer(s))`);
  }

  /**
   * Publish bytes via LightPush. The public fleet has peers that reject pushes
   * (e.g. RLN rate limiting), so a partial success (>=1 peer) counts as sent;
   * we only retry/raise when every peer rejects.
   */
  async publish(payload: Uint8Array, retries = 5): Promise<void> {
    if (!this.node?.lightPush || !this.encoder) {
      throw new Error('Waku transport not started');
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
        // Back off so the node can rotate to a healthier set of push peers.
        await delay(1500 * attempt);
      }
    }
    // Don't crash — LightPush failures are a Waku network condition, not fatal.
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
