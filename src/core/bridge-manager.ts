import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import { HiveSync } from './hivesync-bridge';
import { Identity } from './identity';
import { Transport } from './transport';
import { verifyPassword } from './crypto';
import { StorageManager } from '../storage/storage-manager';
import { QuarantineStore } from '../storage/quarantine-store';
import { RealTimeSyncManager } from '../sync/real-time-sync';
import { BridgeConfig, AgentIdentity, Message, MessageType, QuarantinedMessage, Contact, HandshakeApproval } from '../types';
import { HandshakeInfo } from './hivesync-bridge';
import { logger } from '../utils/logger';

// Meta field carried inside message content, stripped before the message is
// stored or handed to consumers.
const AUTO_FIELD = '__auto';

// How often the outbox poller checks the DB for messages to push over Waku.
const OUTBOX_POLL_INTERVAL_MS = 2000;

/**
 * Orchestrates identity, transport, storage and (optional) sync, and enforces
 * access control via handshake-based trust. Emits events so both humans (the
 * TUI) and agents react live:
 *  - `text`            (message: Message)        a TRUSTED incoming text message
 *  - `message`         (message: Message)        any TRUSTED incoming message
 *  - `quarantine`      (message: QuarantinedMessage) an untrusted message held aside
 *  - `agentDiscovered` (agent: AgentIdentity)    a newly discovered peer
 *
 * Trust: without legacy auth config, a message is trusted only when the sender
 * has a confirmed handshake (status='confirmed'). Untrusted messages are
 * quarantined and never executed. Handshake_init/ack always bypass this check.
 */
export class BridgeManager extends EventEmitter {
  private readonly config: BridgeConfig;
  private readonly identity: Identity;
  private readonly hivesync: HiveSync;
  private readonly storage: StorageManager;
  private readonly quarantine: QuarantineStore;
  private realTimeSync: RealTimeSyncManager | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private approvalTimer: NodeJS.Timeout | null = null;
  private processingOutbox = false;
  private isRunning = false;

  constructor(config: BridgeConfig, transport?: Transport) {
    super();
    this.config = config;
    const identityDir =
      config.storagePath === ':memory:'
        ? path.join(process.cwd(), 'data')
        : path.dirname(config.storagePath);
    // ':memory:' storage implies a throwaway run, so use an ephemeral identity.
    this.identity =
      config.storagePath === ':memory:'
        ? Identity.ephemeral(config.agentId, config.agentName)
        : Identity.loadOrCreate(identityDir, config.agentId, config.agentName);
    this.hivesync = new HiveSync(config, this.identity, transport);
    this.storage = new StorageManager(config.storagePath);

    const quarantineDir =
      config.storagePath === ':memory:'
        ? path.join(os.tmpdir(), `hivesync-quarantine-${sanitize(config.agentId)}-${process.pid}`)
        : path.join(path.dirname(config.storagePath), 'quarantine');
    this.quarantine = new QuarantineStore(quarantineDir);
  }

  /** True if access control is active (a password has been configured). */
  get authEnabled(): boolean {
    return !!this.config.auth?.hash;
  }

  async start(peerWaitTimeoutMs = 30000): Promise<boolean> {
    try {
      logger.info('Starting HiveSync Bridge Manager...');

      await this.storage.initialize();
      await this.registerAgent();

      // Persist agents we discover on the network, and notify listeners. The
      // HiveSync core auto-initiates the handshake shortly after discovery.
      this.hivesync.onAgentDiscovered(async (agent) => {
        await this.storage.saveAgent(agent);
        this.emit('agentDiscovered', agent);
      });
      // On a confirmed handshake, persist capabilities + promote to a trusted
      // "friend", then surface the event for UIs/agents.
      this.hivesync.onHandshakeConfirmed(async (info) => {
        await this.storage.saveAgentHandshake(
          info.agentId,
          'confirmed',
          info.capabilities,
          info.handshakeConfirmedAt
        );
        this.emit('handshakeConfirmed', info);
      });
      this.setupMessageHandlers();

      const started = await this.hivesync.initialize(peerWaitTimeoutMs);
      if (!started) {
        throw new Error('Failed to initialize HiveSync bridge');
      }

      // Obsidian real-time sync is strictly opt-in and never blocks messaging.
      const obsidian = this.config.obsidian;
      if (obsidian?.enabled && obsidian.vaultPath) {
        if (fs.existsSync(obsidian.vaultPath)) {
          try {
            this.realTimeSync = new RealTimeSyncManager(this.hivesync, this.storage, obsidian.vaultPath);
            await this.realTimeSync.start();
          } catch (error) {
            logger.warn('Obsidian sync failed to start (continuing without it):', error);
            this.realTimeSync = null;
          }
        } else {
          logger.warn(`Obsidian vault path does not exist, skipping sync: ${obsidian.vaultPath}`);
        }
      }

      this.isRunning = true;

      // Poll the DB for outgoing messages written directly by external adapters
      // (e.g. the Hermes gateway) and push them over Waku. Separate timer so it
      // never interferes with discovery/announce or message handling.
      this.outboxTimer = setInterval(() => void this.processOutbox(), OUTBOX_POLL_INTERVAL_MS);
      this.outboxTimer.unref?.();

      // When a peer sends us a handshake_init, store the approval request in DB.
      this.hivesync.onHandshakeApprovalNeeded(async ({ agentId, agentName, capabilities }) => {
        await this.storage.createHandshakeApproval(agentId, agentName, capabilities);
        logger.info(`Handshake approval needed for ${agentName} (${agentId}) — use 'hivesync approve ${agentId}'`);
        this.emit('handshakeApprovalNeeded', { agentId, agentName, capabilities });
      });

      // Poll every 3s for approvals written to DB (e.g. by CLI approve command).
      this.approvalTimer = setInterval(async () => {
        try {
          const approved = await this.storage.getRecentlyApproved();
          for (const approval of approved) {
            await this.hivesync.completeHandshakeApproval(approval.agent_id).catch((e) =>
              logger.debug('Failed to complete handshake approval:', e)
            );
          }
        } catch (e) {
          logger.debug('Approval poll error:', e);
        }
      }, 3000);
      this.approvalTimer.unref?.();

      // Re-emit pending approvals from a prior run so handlers can surface them.
      const pendingOnStart = await this.storage.getPendingApprovals();
      for (const approval of pendingOnStart) {
        this.emit('handshakeApprovalNeeded', {
          agentId: approval.agent_id,
          agentName: approval.agent_name,
          capabilities: approval.capabilities,
        });
      }

      logger.success(`Bridge Manager started. Agent: ${this.config.agentName} (${this.config.agentId})`);
      return true;
    } catch (error) {
      logger.error('Failed to start Bridge Manager:', error);
      this.isRunning = false;
      await this.stop().catch(() => undefined);
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.approvalTimer) {
      clearInterval(this.approvalTimer);
      this.approvalTimer = null;
    }
    if (this.realTimeSync) {
      await this.realTimeSync.stop().catch(() => undefined);
      this.realTimeSync = null;
    }
    await this.hivesync.disconnect().catch(() => undefined);
    await this.storage.close();
    this.isRunning = false;
  }

  /**
   * Drain the outbox: messages authored by us that are still undelivered. These
   * are written straight to the DB by external adapters (the Hermes gateway)
   * that never talk to the daemon, so the daemon is responsible for putting them
   * on the wire. Sent via `hivesync.sendMessage` directly (NOT `sendText`, which
   * would re-persist the message). On a successful Waku send we mark it
   * delivered; if the send throws (e.g. a LightPush failure) we leave it
   * undelivered so the next poll retries.
   */
  private async processOutbox(): Promise<void> {
    if (!this.isRunning || this.processingOutbox) return;
    this.processingOutbox = true;
    try {
      const pending = await this.storage.getPendingOutgoing(this.config.agentId);
      for (const message of pending) {
        const text = message.content?.text;
        if (typeof text !== 'string') {
          // Nothing we can send; mark delivered so it doesn't block the queue.
          logger.warn(`Outbox message ${message.id} has no text payload; skipping`);
          await this.storage.markDelivered(message.id);
          continue;
        }

        try {
          // Build the wire content with just the text (no password)
          const wire: any = { text };

          await this.hivesync.sendMessage({
            sender: this.config.agentId,
            recipient: message.recipient,
            type: message.type,
            content: wire,
            encrypted: message.recipient !== 'broadcast',
          });
          await this.storage.markDelivered(message.id);
          logger.info(`Outbox: delivered message ${message.id} to ${message.recipient}`);
        } catch (error) {
          // Leave delivered=0 so the next poll retries this message.
          logger.warn(`Outbox: failed to send message ${message.id} to ${message.recipient}:`, error);
        }
      }
    } catch (error) {
      logger.error('Outbox polling failed:', error);
    } finally {
      this.processingOutbox = false;
    }
  }

  private async registerAgent(): Promise<void> {
    const agent: AgentIdentity = {
      id: this.identity.agentId,
      name: this.identity.agentName,
      publicKey: this.identity.signPublicKey,
      encPublicKey: this.identity.encPublicKey,
      keyId: this.identity.keyId,
      createdAt: this.identity.createdAt,
      lastSeen: new Date(),
    };
    await this.storage.saveAgent(agent);
  }

  private setupMessageHandlers(): void {
    this.hivesync.onMessage(MessageType.TEXT, async (message) => {
      const { trusted, content, isAuto } = this.classify(message);
      const msg: Message = { ...message, content };
      if (!trusted) {
        await this.quarantineMessage(msg);
        return;
      }
      await this.storage.saveMessage(msg);
      this.emit('text', msg);
      this.emit('message', msg);
      if (!isAuto && this.config.auth?.autoReply) {
        void this.sendText(msg.sender, this.config.auth.autoReply, { auto: true }).catch(() => undefined);
      }
    });

    this.hivesync.onMessage(MessageType.COMMAND, async (message) => {
      const { trusted, content } = this.classify(message);
      const msg: Message = { ...message, content };
      if (!trusted) {
        await this.quarantineMessage(msg);
        return;
      }
      await this.storage.saveMessage(msg);
      this.emit('message', msg);
      await this.handleCommand(msg);
    });

    this.hivesync.onMessage(MessageType.ACK, async (message) => {
      const originalMessageId = message.content?.originalMessageId;
      logger.debug(`ACK from ${message.sender} for ${originalMessageId}`);
      // Surface delivery receipts so UIs can show a "delivered" marker.
      if (originalMessageId) this.emit('ack', originalMessageId, message.sender);
    });
  }

  /**
   * Decide whether an inbound message is trusted. With no legacy auth
   * configured, trust is based on handshake status — only confirmed-handshake
   * peers are trusted. Strips the auto-reply marker from content.
   */
  private classify(message: Message): { trusted: boolean; content: any; isAuto: boolean } {
    const content = { ...(message.content ?? {}) };
    const isAuto = content[AUTO_FIELD] === true;
    delete content[AUTO_FIELD];

    let trusted: boolean;
    if (!this.config.auth?.hash) {
      // No password — trust only confirmed-handshake peers
      const hs = this.hivesync.getHandshakeStatus(message.sender);
      trusted = hs?.status === 'confirmed';
    } else {
      // Legacy password mode (backward compat)
      const auth = typeof content['__auth'] === 'string' ? (content['__auth'] as string) : undefined;
      delete (content as any)['__auth'];
      trusted =
        message.encrypted === true &&
        !!auth &&
        verifyPassword(auth, { salt: this.config.auth.salt, hash: this.config.auth.hash });
    }
    return { trusted, content, isAuto };
  }

  private async quarantineMessage(message: Message): Promise<void> {
    const reason = this.config.auth?.hash
      ? message.encrypted
        ? 'missing or invalid password'
        : 'unauthenticated (not encrypted)'
      : 'untrusted (handshake not confirmed)';
    const file = await this.quarantine.add(message, reason);
    logger.warn(`Quarantined message from ${message.sender} (${reason}) -> ${file}`);
    this.emit('quarantine', { ...message, reason, file } as unknown as QuarantinedMessage);
  }

  private async handleCommand(message: Message): Promise<void> {
    const { command } = message.content;

    switch (command) {
      case 'status': {
        const status = await this.getStatus();
        await this.sendTextMessage(message.sender, `Status: ${JSON.stringify(status)}`);
        break;
      }
      case 'agents': {
        const agents = await this.storage.getAllAgents();
        const list = agents.map((a) => `${a.name} (${a.id})`).join('\n');
        await this.sendTextMessage(message.sender, `Known agents:\n${list}`);
        break;
      }
      case 'sync':
        if (this.realTimeSync) {
          await this.realTimeSync.syncWithAllAgents();
          await this.sendTextMessage(message.sender, 'Sync initiated');
        } else {
          await this.sendTextMessage(message.sender, 'Real-time sync not configured');
        }
        break;
      case 'help':
        await this.sendTextMessage(
          message.sender,
          'Commands: status, agents, sync, help'
        );
        break;
      default:
        await this.sendTextMessage(message.sender, `Unknown command: ${command}`);
    }
  }

  async sendTextMessage(recipient: string, text: string): Promise<string> {
    return this.sendText(recipient, text, {});
  }

  /**
   * Internal text send. `auto` tags an automated reply so it can't re-trigger
   * another automated reply.
   */
  private async sendText(
    recipient: string,
    text: string,
    opts: { auto?: boolean }
  ): Promise<string> {
    const willEncrypt = recipient !== 'broadcast' && this.isAgentKnown(recipient);
    const wire: any = { text };
    if (opts.auto) wire[AUTO_FIELD] = true;

    const id = await this.hivesync.sendMessage({
      sender: this.config.agentId,
      recipient,
      type: MessageType.TEXT,
      content: wire,
      encrypted: recipient !== 'broadcast',
    });
    // Record our own outgoing message (clean content) so history is complete.
    // Mark it delivered immediately: we've already put it on the wire here, so
    // the outbox poller must not pick it up and send it a second time.
    await this.storage.saveMessage({
      id,
      sender: this.config.agentId,
      recipient,
      type: MessageType.TEXT,
      content: { text },
      timestamp: new Date(),
      encrypted: willEncrypt,
    });
    await this.storage.markDelivered(id);
    return id;
  }

  private isAgentKnown(agentId: string): boolean {
    return this.hivesync.getKnownAgents().some((a) => a.id === agentId && !!a.encPublicKey);
  }

  // --- quarantine (inbound) -----------------------------------------------

  getQuarantineDir(): string {
    return this.quarantine.getDir();
  }

  async getQuarantine(limit = 500): Promise<QuarantinedMessage[]> {
    return this.quarantine.list(limit);
  }

  async getQuarantineCount(): Promise<number> {
    return this.quarantine.count();
  }

  async sendCommand(recipient: string, command: string, args: any = {}): Promise<string> {
    return this.hivesync.sendMessage({
      sender: this.config.agentId,
      recipient,
      type: MessageType.COMMAND,
      content: { command, args },
      encrypted: recipient !== 'broadcast',
    });
  }

  async broadcastMessage(text: string): Promise<string> {
    const id = await this.hivesync.sendMessage({
      sender: this.config.agentId,
      recipient: 'broadcast',
      type: MessageType.TEXT,
      content: { text },
      encrypted: false,
    });
    await this.storage.saveMessage({
      id,
      sender: this.config.agentId,
      recipient: 'broadcast',
      type: MessageType.TEXT,
      content: { text },
      timestamp: new Date(),
      encrypted: false,
    });
    await this.storage.markDelivered(id);
    return id;
  }

  /** Full text conversation (both directions) with one agent, oldest first. */
  async getConversation(peerId: string, limit = 500): Promise<Message[]> {
    return this.storage.getConversation(peerId, this.config.agentId, limit);
  }

  /** All broadcast text messages seen/sent, oldest first. */
  async getBroadcasts(limit = 500): Promise<Message[]> {
    return this.storage.getBroadcasts(limit);
  }

  get agentId(): string {
    return this.config.agentId;
  }

  /** Wait until an agent has been discovered (so encryption keys are known). */
  async waitForAgent(agentId: string, timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.hivesync.getKnownAgents().some((a) => a.id === agentId)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  getKnownAgents(): AgentIdentity[] {
    return this.hivesync.getKnownAgents();
  }

  // --- handshake protocol --------------------------------------------------

  /** Manually (re-)initiate a handshake with a peer. */
  async initiateHandshake(agentId: string): Promise<void> {
    await this.hivesync.sendHandshakeInit(agentId);
  }

  /** Current in-memory handshake state for a peer (null if not yet discovered). */
  getHandshakeStatus(agentId: string): HandshakeInfo | null {
    return this.hivesync.getHandshakeStatus(agentId);
  }

  /** Resolve once the handshake with a peer is confirmed (or fails / times out). */
  async handshakeWait(agentId: string, timeoutMs = 10000): Promise<boolean> {
    return this.hivesync.handshakeWait(agentId, timeoutMs);
  }

  /** All peers with a confirmed handshake (persisted contacts). */
  async getContacts(): Promise<Contact[]> {
    return this.storage.getAllContacts();
  }

  /** A single persisted contact (with handshake details). */
  async getContact(agentId: string): Promise<Contact | null> {
    return this.storage.getContact(agentId);
  }

  /** All handshake requests awaiting user approval. */
  async getPendingApprovals(): Promise<HandshakeApproval[]> {
    return this.storage.getPendingApprovals();
  }

  /** Approve a pending handshake and immediately send the confirmed ack. */
  async approveHandshake(agentId: string): Promise<boolean> {
    const changed = await this.storage.approveHandshakeByAgent(agentId);
    if (changed) {
      await this.hivesync.completeHandshakeApproval(agentId).catch((e) =>
        logger.debug('Failed to complete handshake approval:', e)
      );
    }
    return changed;
  }

  /** Deny a pending handshake request. */
  async denyHandshake(agentId: string): Promise<boolean> {
    return this.storage.denyHandshakeByAgent(agentId);
  }

  async getUnreadMessages(): Promise<Message[]> {
    return this.storage.getUnreadMessages();
  }

  async markMessageAsRead(messageId: string): Promise<void> {
    await this.storage.markMessageAsRead(messageId);
  }

  async getStatus(): Promise<any> {
    const hivesync = await this.hivesync.getStatus();
    return {
      running: this.isRunning,
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      keyId: this.identity.keyId,
      authEnabled: this.authEnabled,
      quarantined: await this.getQuarantineCount(),
      hivesync,
      realTimeSync: !!this.realTimeSync,
      fileWatching: this.realTimeSync?.isWatching() || false,
    };
  }

  async triggerSync(): Promise<void> {
    if (this.realTimeSync) {
      await this.realTimeSync.syncWithAllAgents();
    }
  }

  async getSyncStatus(): Promise<any> {
    if (this.realTimeSync) {
      return this.realTimeSync.getSyncStatus();
    }
    return [];
  }
}

function sanitize(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40) || 'agent';
}
