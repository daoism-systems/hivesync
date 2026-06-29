import { v4 as uuidv4 } from 'uuid';
import {
  Message,
  MessageType,
  BridgeConfig,
  Envelope,
  AnnouncePayload,
  AgentIdentity,
  HandshakeStatus,
  HandshakeInitPayload,
  HandshakeAckPayload,
  AckStatus,
  AckPayload,
} from '../types';
import { Identity } from './identity';
import { fingerprint } from './crypto';
import { Transport } from './transport';
import { WakuTransport } from './waku-transport';
import { logger } from '../utils/logger';

const ENVELOPE_VERSION = 1;
const BROADCAST = 'broadcast';
const MAX_SEEN_IDS = 5000;

// Receive-side rate cap defaults: accept at most RATE_LIMIT_MAX actionable
// messages from one sender per RATE_LIMIT_WINDOW_MS. Generous enough that
// healthy agents (Claw's 2s outbox = ≤30/min) never trip it; tight enough to
// shed a runaway/looping/injected flood. Overridable via BridgeConfig.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

/** Our advertised protocol version and capabilities, sent in handshakes. */
const AGENT_VERSION = '2.0.0';
const AGENT_CAPABILITIES = ['text', 'file', 'command', 'sync', 'obsidian'];

/** Delay before auto-initiating a handshake on a fresh discovery. */
const HANDSHAKE_INIT_DELAY_MS = 1000;

/** What we learn (and pin) about another agent on the network. */
interface KnownAgent {
  agentId: string;
  agentName: string;
  keyId: string;
  signPublicKey: string;
  encPublicKey: string;
  lastSeen: Date;
  handshakeStatus: HandshakeStatus;
  capabilities?: string[];
  handshakeConfirmedAt?: Date;
}

/** Summary of where a handshake with a peer stands. */
export interface HandshakeInfo {
  agentId: string;
  agentName: string;
  status: HandshakeStatus;
  capabilities: string[];
  handshakeConfirmedAt?: Date;
}

export type MessageHandler = (message: Message) => void | Promise<void>;
export type AgentDiscoveredHandler = (agent: AgentIdentity) => void | Promise<void>;
export type HandshakeConfirmedHandler = (info: HandshakeInfo) => void | Promise<void>;
export type HandshakeApprovalNeededHandler = (info: { agentId: string; agentName: string; capabilities: string[] }) => void | Promise<void>;

/**
 * HiveSync messaging core. Sits on top of {@link WakuTransport} and provides:
 *  - a signed, optionally end-to-end-encrypted message envelope,
 *  - identity-based addressing (agentId), self-filtering and de-duplication,
 *  - peer discovery via periodic ANNOUNCE (find others / be found),
 *  - ACKs for direct messages.
 */
export class HiveSync {
  private readonly config: BridgeConfig;
  private readonly identity: Identity;
  private readonly transport: Transport;

  private readonly messageHandlers = new Map<MessageType, MessageHandler>();
  private readonly agentDiscoveredHandlers: AgentDiscoveredHandler[] = [];
  private readonly handshakeConfirmedHandlers: HandshakeConfirmedHandler[] = [];
  private readonly handshakeApprovalNeededHandlers: HandshakeApprovalNeededHandler[] = [];
  private readonly knownAgents = new Map<string, KnownAgent>();
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** Per-sender inbound timestamps (ms) for the receive-side rate cap. */
  private readonly inboundTimes = new Map<string, number[]>();

  private announceTimer: NodeJS.Timeout | null = null;
  private earlyAnnounceTimer: NodeJS.Timeout | null = null;
  private isConnected = false;

  constructor(config: BridgeConfig, identity: Identity, transport?: Transport) {
    this.config = config;
    this.identity = identity;
    this.transport = transport ?? new WakuTransport(config.waku);
  }

  get agentId(): string {
    return this.identity.agentId;
  }

  async initialize(peerWaitTimeoutMs = 30000): Promise<boolean> {
    try {
      logger.info('Initializing HiveSync bridge...');
      await this.transport.start(peerWaitTimeoutMs);
      await this.transport.subscribe((payload) => {
        void this.handleIncoming(payload);
      });

      this.isConnected = true;
      logger.success(`HiveSync bridge connected as ${this.identity.agentId} (key ${this.identity.keyId})`);

      // Gate the FIRST announce on having a connected peer, so the initial
      // send doesn't fire into the void and burn its retries before any
      // LightPush/relay peer is available (a real startup race on slow
      // networks). Done in the background so startup never blocks; the steady
      // interval below announces regardless.
      void this.waitForPeers(15000)
        .then(() => this.announce())
        .catch((e) => logger.debug('initial announce failed:', e));
      this.earlyAnnounceTimer = setTimeout(() => void this.announce(), 8000);
      this.earlyAnnounceTimer.unref?.();
      const intervalSec = this.config.syncInterval > 0 ? this.config.syncInterval : 30;
      this.announceTimer = setInterval(() => void this.announce(), intervalSec * 1000);
      this.announceTimer.unref?.();

      return true;
    } catch (error) {
      logger.error('Failed to initialize HiveSync bridge:', error);
      this.isConnected = false;
      return false;
    }
  }

  /** Poll until at least one peer is connected, or the timeout elapses. */
  private async waitForPeers(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.isConnected) {
      try {
        if ((await this.transport.getPeerCount()) > 0) return;
      } catch {
        /* transport may not expose peers yet */
      }
      // unref'd so a pending wait never keeps the process (or a test) alive.
      await new Promise((r) => {
        const t = setTimeout(r, 500);
        t.unref?.();
      });
    }
  }

  onMessage(type: MessageType, handler: MessageHandler): void {
    this.messageHandlers.set(type, handler);
  }

  onAgentDiscovered(handler: AgentDiscoveredHandler): void {
    this.agentDiscoveredHandlers.push(handler);
  }

  onHandshakeConfirmed(handler: HandshakeConfirmedHandler): void {
    this.handshakeConfirmedHandlers.push(handler);
  }

  onHandshakeApprovalNeeded(handler: HandshakeApprovalNeededHandler): void {
    this.handshakeApprovalNeededHandlers.push(handler);
  }

  getKnownAgents(): AgentIdentity[] {
    return Array.from(this.knownAgents.values()).map((a) => ({
      id: a.agentId,
      name: a.agentName,
      publicKey: a.signPublicKey,
      encPublicKey: a.encPublicKey,
      keyId: a.keyId,
      createdAt: a.lastSeen,
      lastSeen: a.lastSeen,
    }));
  }

  /** Restore confirmed handshakes from persistent storage (survives restarts). */
  restoreTrustedAgents(
    agents: Array<{
      id: string; name: string; publicKey: string; encPublicKey?: string;
      keyId?: string; handshakeStatus?: string; handshakeConfirmedAt?: string;
    }>,
  ): void {
    for (const a of agents) {
      if (a.handshakeStatus === 'confirmed') {
        this.knownAgents.set(a.id, {
          agentId: a.id,
          agentName: a.name,
          signPublicKey: a.publicKey,
          encPublicKey: a.encPublicKey || '',
          keyId: a.keyId || '',
          lastSeen: a.handshakeConfirmedAt ? new Date(a.handshakeConfirmedAt) : new Date(),
          handshakeStatus: 'confirmed',
          handshakeConfirmedAt: a.handshakeConfirmedAt ? new Date(a.handshakeConfirmedAt) : undefined,
        });
        logger.info(`Restored trusted handshake for ${a.id} (${a.name})`);
      }
    }
  }

  async sendMessage(message: Omit<Message, 'id' | 'timestamp'>): Promise<string> {
    if (!this.isConnected) {
      throw new Error('HiveSync bridge not initialized or connected');
    }

    const id = uuidv4();
    const ts = Date.now();
    const recipient = message.recipient;
    const plaintext = Buffer.from(JSON.stringify(message.content ?? {}), 'utf-8');

    const envelope: Envelope = {
      v: ENVELOPE_VERSION,
      id,
      from: this.identity.agentId,
      to: recipient,
      type: message.type,
      ts,
      spk: this.identity.signPublicKey,
      sig: '',
      enc: false,
    };
    // Carry the automated-message flag (only when set, to keep the signed form
    // backward-compatible — see canonicalBytes).
    if (message.auto) envelope.auto = true;

    // Encrypt only directed messages to an agent whose encryption key we know.
    const recipientKey = recipient !== BROADCAST ? this.knownAgents.get(recipient)?.encPublicKey : undefined;
    if (message.encrypted && recipientKey) {
      const payload = this.identity.encryptFor(recipientKey, plaintext);
      envelope.enc = true;
      envelope.iv = payload.iv;
      envelope.ct = payload.ciphertext;
      envelope.tag = payload.tag;
      envelope.epk = payload.epk;
    } else {
      if (message.encrypted && recipient !== BROADCAST) {
        logger.warn(`No encryption key known for ${recipient}; sending signed plaintext`);
      }
      envelope.body = plaintext.toString('utf-8');
    }

    envelope.sig = this.identity.sign(canonicalBytes(envelope));
    this.rememberId(id);

    await this.transport.publish(Buffer.from(JSON.stringify(envelope), 'utf-8'));
    logger.debug(`Message sent: ${id} (${message.type}) to ${recipient}`);
    return id;
  }

  private async handleIncoming(payload: Uint8Array): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(Buffer.from(payload).toString('utf-8')) as Envelope;
    } catch {
      return; // not a HiveSync frame
    }

    if (!envelope || envelope.v !== ENVELOPE_VERSION || !envelope.id || !envelope.from) {
      return;
    }

    // Ignore our own frames echoed back by the network, and duplicates.
    if (envelope.from === this.identity.agentId) return;
    if (this.seenIds.has(envelope.id)) return;
    this.rememberId(envelope.id);

    // Authenticity: signature must verify against the embedded signing key.
    if (!this.identity.verify(envelope.spk, canonicalBytes(envelope), envelope.sig)) {
      logger.warn(`Dropping message ${envelope.id}: bad signature from ${envelope.from}`);
      return;
    }

    // TOFU: pin agentId -> signing key. Reject if a known agent's key changed.
    const keyId = fingerprint(envelope.spk);
    const pinned = this.knownAgents.get(envelope.from);
    if (pinned && pinned.keyId !== keyId) {
      logger.warn(`Dropping message ${envelope.id}: key mismatch for ${envelope.from} (possible impersonation)`);
      return;
    }

    if (envelope.type === MessageType.ANNOUNCE) {
      await this.handleAnnounce(envelope);
      return;
    }

    // Handshake frames bypass auth/classify (like ANNOUNCE): they carry no
    // secrets and must work before any password is exchanged. They are still
    // signature- and TOFU-verified above. Only handle ones addressed to us.
    if (envelope.type === MessageType.HANDSHAKE_INIT || envelope.type === MessageType.HANDSHAKE_ACK) {
      if (envelope.to !== this.identity.agentId) return;
      let payload: any;
      try {
        payload = this.decodeContent(envelope);
      } catch (error) {
        logger.warn(`Failed to decode handshake ${envelope.id} from ${envelope.from}:`, error);
        return;
      }
      if (pinned) pinned.lastSeen = new Date();
      if (envelope.type === MessageType.HANDSHAKE_INIT) {
        await this.handleHandshakeInit(envelope.from, payload as HandshakeInitPayload);
      } else {
        await this.handleHandshakeAck(envelope.from, payload as HandshakeAckPayload);
      }
      return;
    }

    // Routing: only process messages addressed to us or broadcast.
    if (envelope.to !== this.identity.agentId && envelope.to !== BROADCAST) {
      return;
    }

    // Receive-side rate cap (circuit breaker): shed directed actionable traffic
    // from a sender that floods us — a buggy/looping/injected peer — before it
    // can storm the mesh. ACK/ANNOUNCE/handshake are protocol and flow freely;
    // broadcasts aren't capped (they're not addressed to us). We reply with a
    // `rate_limited` ACK so the sender learns to back off.
    if (
      envelope.to === this.identity.agentId &&
      (envelope.type === MessageType.TEXT || envelope.type === MessageType.COMMAND) &&
      this.isRateLimited(envelope.from)
    ) {
      logger.warn(`Rate cap: shedding ${envelope.type} ${envelope.id} from ${envelope.from}`);
      await this.sendAck(envelope.id, envelope.from, 'rate_limited').catch((e) =>
        logger.debug('Failed to send rate_limited ACK:', e)
      );
      return;
    }

    let content: any;
    try {
      content = this.decodeContent(envelope);
    } catch (error) {
      logger.warn(`Failed to decode message ${envelope.id} from ${envelope.from}:`, error);
      return;
    }

    if (pinned) pinned.lastSeen = new Date();

    const message: Message = {
      id: envelope.id,
      sender: envelope.from,
      recipient: envelope.to,
      type: envelope.type,
      content,
      timestamp: new Date(envelope.ts),
      encrypted: envelope.enc,
      signature: envelope.sig,
      auto: envelope.auto === true,
    };

    logger.debug(`Received ${message.type} from ${message.sender}`);

    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      await handler(message);
    }

    // ACK directed messages only (avoids broadcast ACK storms).
    if (message.type !== MessageType.ACK && envelope.to === this.identity.agentId) {
      await this.sendAck(message.id, message.sender).catch((e) =>
        logger.debug('Failed to send ACK:', e)
      );
    }
  }

  private decodeContent(envelope: Envelope): any {
    if (envelope.enc) {
      if (!envelope.iv || !envelope.ct || !envelope.tag || !envelope.epk) {
        throw new Error('encrypted envelope missing fields');
      }
      const plaintext = this.identity.decrypt({
        iv: envelope.iv,
        ciphertext: envelope.ct,
        tag: envelope.tag,
        epk: envelope.epk,
      });
      return JSON.parse(plaintext.toString('utf-8'));
    }
    return JSON.parse(envelope.body ?? '{}');
  }

  private async handleAnnounce(envelope: Envelope): Promise<void> {
    let payload: AnnouncePayload;
    try {
      payload = JSON.parse(envelope.body ?? '{}');
    } catch {
      return;
    }
    if (!payload.agentId || !payload.signPublicKey || !payload.encPublicKey) return;

    // The announce must be signed by the key it advertises.
    if (fingerprint(payload.signPublicKey) !== fingerprint(envelope.spk)) {
      logger.warn(`Dropping announce from ${payload.agentId}: signing key mismatch`);
      return;
    }

    // Preserve any handshake state we already established across re-announces.
    const prior = this.knownAgents.get(payload.agentId);
    const isNew = !prior;
    this.knownAgents.set(payload.agentId, {
      agentId: payload.agentId,
      agentName: payload.agentName,
      keyId: payload.keyId,
      signPublicKey: payload.signPublicKey,
      encPublicKey: payload.encPublicKey,
      lastSeen: new Date(),
      handshakeStatus: prior?.handshakeStatus ?? 'none',
      capabilities: prior?.capabilities,
      handshakeConfirmedAt: prior?.handshakeConfirmedAt,
    });

    if (isNew) {
      logger.success(`Discovered agent ${payload.agentName} (${payload.agentId})`);
      const agent: AgentIdentity = {
        id: payload.agentId,
        name: payload.agentName,
        publicKey: payload.signPublicKey,
        encPublicKey: payload.encPublicKey,
        keyId: payload.keyId,
        createdAt: new Date(),
        lastSeen: new Date(),
      };
      for (const cb of this.agentDiscoveredHandlers) {
        await cb(agent);
      }
      // Reply so the newcomer learns about us promptly.
      await this.announce().catch((e) => logger.debug('Failed to re-announce:', e));
      // Auto-initiate a handshake shortly after discovery (let the announce
      // round-trip settle so both sides know each other's keys first).
      const t = setTimeout(() => {
        void this.sendHandshakeInit(payload.agentId).catch((e) =>
          logger.debug('Failed to initiate handshake:', e)
        );
      }, HANDSHAKE_INIT_DELAY_MS);
      t.unref?.();
    }
  }

  async announce(): Promise<void> {
    if (!this.isConnected) return;
    const payload: AnnouncePayload = {
      agentId: this.identity.agentId,
      agentName: this.identity.agentName,
      keyId: this.identity.keyId,
      signPublicKey: this.identity.signPublicKey,
      encPublicKey: this.identity.encPublicKey,
    };
    await this.sendMessage({
      sender: this.identity.agentId,
      recipient: BROADCAST,
      type: MessageType.ANNOUNCE,
      content: payload,
      encrypted: false,
    });
  }

  // --- handshake protocol --------------------------------------------------

  /** Send a HANDSHAKE_INIT to a peer, marking the handshake pending. */
  async sendHandshakeInit(agentId: string): Promise<void> {
    const known = this.knownAgents.get(agentId);
    if (known && known.handshakeStatus !== 'confirmed') {
      known.handshakeStatus = 'pending';
    }
    const payload: HandshakeInitPayload = {
      agentName: this.identity.agentName,
      agentVersion: AGENT_VERSION,
      capabilities: AGENT_CAPABILITIES,
      timestamp: Date.now(),
    };
    await this.sendMessage({
      sender: this.identity.agentId,
      recipient: agentId,
      type: MessageType.HANDSHAKE_INIT,
      content: payload,
      encrypted: false,
    });
    logger.debug(`Handshake init sent to ${agentId}`);
  }

  /** Reply to a HANDSHAKE_INIT, advertising our capabilities. */
  async sendHandshakeAck(agentId: string, accepted: boolean, reason?: string): Promise<void> {
    const payload: HandshakeAckPayload = {
      accepted,
      agentName: this.identity.agentName,
      agentVersion: AGENT_VERSION,
      capabilities: AGENT_CAPABILITIES,
      timestamp: Date.now(),
    };
    if (reason !== undefined) payload.reason = reason;
    await this.sendMessage({
      sender: this.identity.agentId,
      recipient: agentId,
      type: MessageType.HANDSHAKE_ACK,
      content: payload,
      encrypted: false,
    });
    logger.debug(`Handshake ack (accepted=${accepted}${reason ? `, reason=${reason}` : ''}) sent to ${agentId}`);
  }

  private async handleHandshakeInit(from: string, payload: HandshakeInitPayload): Promise<void> {
    const known = this.knownAgents.get(from);
    const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];
    if (known) {
      known.capabilities = capabilities;
    }
    // Require explicit user approval before confirming. Send a pending ack.
    await this.sendHandshakeAck(from, false, 'pending_approval').catch((e) =>
      logger.debug('Failed to send handshake ack:', e)
    );
    if (known) {
      known.handshakeStatus = 'pending';
    }
    const agentName = payload.agentName ?? from;
    logger.info(`Handshake request from ${agentName} (${from}) — awaiting user approval`);
    const approvalInfo = { agentId: from, agentName, capabilities };
    for (const cb of this.handshakeApprovalNeededHandlers) {
      await cb(approvalInfo);
    }
  }

  private async handleHandshakeAck(from: string, payload: HandshakeAckPayload): Promise<void> {
    const known = this.knownAgents.get(from);
    const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];
    if (known) {
      known.capabilities = capabilities;
      if (payload.accepted) {
        known.handshakeStatus = 'confirmed';
        known.handshakeConfirmedAt = new Date();
      } else if (payload.reason === 'pending_approval') {
        known.handshakeStatus = 'pending';
      } else {
        known.handshakeStatus = 'failed';
      }
    }
    if (payload.accepted) {
      logger.success(`Handshake confirmed with ${payload.agentName ?? from} (${from})`);
      await this.notifyHandshakeConfirmed(from);
    } else if (payload.reason === 'pending_approval') {
      logger.info(`Handshake with ${payload.agentName ?? from} (${from}) awaiting user approval on the other side`);
    } else {
      logger.warn(`Handshake rejected by ${from}`);
    }
  }

  private async notifyHandshakeConfirmed(agentId: string): Promise<void> {
    const known = this.knownAgents.get(agentId);
    const info: HandshakeInfo = {
      agentId,
      agentName: known?.agentName ?? agentId,
      status: 'confirmed',
      capabilities: known?.capabilities ?? [],
      handshakeConfirmedAt: known?.handshakeConfirmedAt ?? new Date(),
    };
    for (const cb of this.handshakeConfirmedHandlers) {
      await cb(info);
    }
  }

  /** Called by BridgeManager once the user approves a pending handshake. */
  async completeHandshakeApproval(agentId: string): Promise<void> {
    const known = this.knownAgents.get(agentId);
    if (known) {
      known.handshakeStatus = 'confirmed';
      known.handshakeConfirmedAt = new Date();
    }
    await this.sendHandshakeAck(agentId, true).catch((e) =>
      logger.debug('Failed to send approved handshake ack:', e)
    );
    logger.success(`Handshake approved and confirmed with ${known?.agentName ?? agentId} (${agentId})`);
    await this.notifyHandshakeConfirmed(agentId);
  }

  /** Current handshake state for a peer, or null if the peer is unknown. */
  getHandshakeStatus(agentId: string): HandshakeInfo | null {
    const known = this.knownAgents.get(agentId);
    if (!known) return null;
    return {
      agentId: known.agentId,
      agentName: known.agentName,
      status: known.handshakeStatus,
      capabilities: known.capabilities ?? [],
      handshakeConfirmedAt: known.handshakeConfirmedAt,
    };
  }

  /** Resolve once the handshake with a peer is confirmed (or fails / times out). */
  async handshakeWait(agentId: string, timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const known = this.knownAgents.get(agentId);
      if (known?.handshakeStatus === 'confirmed') return true;
      if (known?.handshakeStatus === 'failed') return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.knownAgents.get(agentId)?.handshakeStatus === 'confirmed';
  }

  /**
   * Send a delivery receipt for `messageId`. This is the TRANSPORT-level ACK
   * ("I received it"), so it defaults to status 'queued'; an agent that has
   * actually acted on the message can send a follow-up ACK with 'processed'.
   * ACKs are exempt from the auto-reply guard, so they flow even in response to
   * an `auto:true` message — but we never ACK an ACK (the caller guards that),
   * which is what prevents receipt storms.
   */
  private async sendAck(
    messageId: string,
    recipient: string,
    status: AckStatus = 'queued'
  ): Promise<void> {
    const content: AckPayload = { originalMessageId: messageId, status };
    await this.sendMessage({
      sender: this.identity.agentId,
      recipient,
      type: MessageType.ACK,
      content,
      encrypted: false,
    });
  }

  /**
   * Per-sender sliding-window rate cap. Returns true once `sender` has exceeded
   * the configured limit within the window — the caller then sheds the message.
   * Shed messages still count toward the window, so a flooding sender stays
   * capped until it actually backs off.
   */
  private isRateLimited(sender: string): boolean {
    const max = this.config.rateLimitPerWindow ?? RATE_LIMIT_MAX;
    if (max <= 0) return false; // cap disabled
    const windowMs = this.config.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;
    const now = Date.now();
    const times = (this.inboundTimes.get(sender) ?? []).filter((t) => now - t < windowMs);
    times.push(now);
    this.inboundTimes.set(sender, times);
    return times.length > max;
  }

  private rememberId(id: string): void {
    this.seenIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > MAX_SEEN_IDS) {
      const old = this.seenOrder.shift();
      if (old) this.seenIds.delete(old);
    }
  }

  async disconnect(): Promise<void> {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.earlyAnnounceTimer) {
      clearTimeout(this.earlyAnnounceTimer);
      this.earlyAnnounceTimer = null;
    }
    await this.transport.stop();
    this.isConnected = false;
    logger.info('HiveSync bridge disconnected');
  }

  async getStatus(): Promise<{ connected: boolean; peerId?: string; peers: number; knownAgents: number }> {
    return {
      connected: this.isConnected,
      peerId: this.transport.peerId(),
      peers: this.isConnected ? await this.transport.getPeerCount() : 0,
      knownAgents: this.knownAgents.size,
    };
  }

  /** Multiaddrs other nodes can dial to reach this node (relay hub mode). */
  getDialableMultiaddrs(): string[] {
    return this.transport.getDialableMultiaddrs?.() ?? [];
  }

  /** Synchronous status snapshot (no peer-count round-trip). */
  getStatusSync(): { connected: boolean; peerId?: string; knownAgents: number } {
    return {
      connected: this.isConnected,
      peerId: this.transport.peerId(),
      knownAgents: this.knownAgents.size,
    };
  }
}

/**
 * Deterministic byte serialization of the security-relevant envelope fields.
 * Both signing and verification use this; `spk`/`sig` are excluded (the key is
 * the verifier, the signature is the output).
 */
function canonicalBytes(env: Envelope): Buffer {
  const fields: unknown[] = [
    env.v,
    env.id,
    env.from,
    env.to,
    env.type,
    env.ts,
    env.enc,
    env.body ?? null,
    env.iv ?? null,
    env.ct ?? null,
    env.tag ?? null,
    env.epk ?? null,
  ];
  // Backward compatibility: only extend the signed payload when `auto` is set.
  // An envelope without the flag therefore hashes byte-identically to the
  // pre-`auto` format, so messages still verify across agents that haven't
  // upgraded. A truthy `auto` does change the signature form — but only newer
  // agents send/understand it, and non-auto traffic is unaffected throughout
  // rollout (no version bump, no flag-day).
  if (env.auto) fields.push('auto', true);
  return Buffer.from(JSON.stringify(fields), 'utf-8');
}
