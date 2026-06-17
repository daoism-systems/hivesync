/**
 * Transport abstraction for HiveSync.
 *
 * HiveSync's messaging logic (framing, identity, signing, encryption,
 * discovery, ACKs) is independent of how bytes actually move between agents.
 * That movement is a `Transport`. The production implementation is
 * {@link WakuTransport}; {@link InMemoryTransport} provides a deterministic,
 * in-process bus used by tests.
 */
export interface Transport {
  /** Connect and become ready to publish/subscribe. */
  start(peerWaitTimeoutMs?: number): Promise<void>;
  /** Register the handler invoked for every received frame. */
  subscribe(handler: (payload: Uint8Array) => void): Promise<void>;
  /** Broadcast a frame to the shared content topic. */
  publish(payload: Uint8Array): Promise<void>;
  /** Number of currently connected transport peers. */
  getPeerCount(): Promise<number>;
  /** This node's transport-level identifier, if any. */
  peerId(): string | undefined;
  isStarted(): boolean;
  stop(): Promise<void>;
}

/** Module-level buses keyed by content topic, shared across InMemoryTransports. */
const buses = new Map<string, Set<InMemoryTransport>>();

/**
 * In-process pub/sub transport. All instances sharing a content topic see each
 * other's published frames (except their own), mirroring Waku's broadcast model
 * without any network. Used for fast, deterministic tests.
 */
export class InMemoryTransport implements Transport {
  private readonly topic: string;
  private readonly id: string;
  private handler: ((payload: Uint8Array) => void) | null = null;
  private started = false;

  constructor(topic: string, id?: string) {
    this.topic = topic;
    this.id = id || `mem-${Math.floor(performance.now() * 1000)}-${buses.get(topic)?.size ?? 0}`;
  }

  async start(): Promise<void> {
    if (!buses.has(this.topic)) buses.set(this.topic, new Set());
    buses.get(this.topic)!.add(this);
    this.started = true;
  }

  async subscribe(handler: (payload: Uint8Array) => void): Promise<void> {
    this.handler = handler;
  }

  async publish(payload: Uint8Array): Promise<void> {
    const peers = buses.get(this.topic);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this || !peer.handler) continue;
      const copy = payload.slice();
      // Deliver asynchronously to mimic real network delivery semantics.
      setImmediate(() => peer.handler && peer.handler(copy));
    }
  }

  async getPeerCount(): Promise<number> {
    return Math.max(0, (buses.get(this.topic)?.size ?? 1) - 1);
  }

  peerId(): string | undefined {
    return this.id;
  }

  isStarted(): boolean {
    return this.started;
  }

  async stop(): Promise<void> {
    buses.get(this.topic)?.delete(this);
    this.started = false;
    this.handler = null;
  }
}
