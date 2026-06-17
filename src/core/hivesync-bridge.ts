import { v4 as uuidv4 } from 'uuid';
import {
  Message,
  MessageType,
  BridgeConfig,
  Envelope,
  AnnouncePayload,
  AgentIdentity,
} from '../types';
import { Identity } from './identity';
import { fingerprint } from './crypto';
import { Transport } from './transport';
import { WakuTransport } from './waku-transport';
import { logger } from '../utils/logger';

const ENVELOPE_VERSION = 1;
const BROADCAST = 'broadcast';
const MAX_SEEN_IDS = 5000;

/** What we learn (and pin) about another agent on the network. */
interface KnownAgent {
  agentId: string;
  agentName: string;
  keyId: string;
  signPublicKey: string;
  encPublicKey: string;
  lastSeen: Date;
}

export type MessageHandler = (message: Message) => void | Promise<void>;
export type AgentDiscoveredHandler = (agent: AgentIdentity) => void | Promise<void>;

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
  private readonly knownAgents = new Map<string, KnownAgent>();
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];

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

      // Announce presence now, and a couple of times shortly after to ride out
      // subscription propagation, then on a steady interval.
      await this.announce();
      this.earlyAnnounceTimer = setTimeout(() => void this.announce(), 2000);
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

  onMessage(type: MessageType, handler: MessageHandler): void {
    this.messageHandlers.set(type, handler);
  }

  onAgentDiscovered(handler: AgentDiscoveredHandler): void {
    this.agentDiscoveredHandlers.push(handler);
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

    // Routing: only process messages addressed to us or broadcast.
    if (envelope.to !== this.identity.agentId && envelope.to !== BROADCAST) {
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

    const isNew = !this.knownAgents.has(payload.agentId);
    this.knownAgents.set(payload.agentId, {
      agentId: payload.agentId,
      agentName: payload.agentName,
      keyId: payload.keyId,
      signPublicKey: payload.signPublicKey,
      encPublicKey: payload.encPublicKey,
      lastSeen: new Date(),
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

  private async sendAck(messageId: string, recipient: string): Promise<void> {
    await this.sendMessage({
      sender: this.identity.agentId,
      recipient,
      type: MessageType.ACK,
      content: { originalMessageId: messageId },
      encrypted: false,
    });
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
  const canonical = JSON.stringify([
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
  ]);
  return Buffer.from(canonical, 'utf-8');
}
