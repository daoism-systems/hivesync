import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import { HiveSync } from './hivesync-bridge';
import { Identity } from './identity';
import { Transport } from './transport';
import { StorageManager } from '../storage/storage-manager';
import { QuarantineStore } from '../storage/quarantine-store';
import { RealTimeSyncManager } from '../sync/real-time-sync';
import { BridgeConfig, AgentIdentity, Message, MessageType, QuarantinedMessage, Contact, HandshakeApproval } from '../types';
import { HandshakeInfo } from './hivesync-bridge';
import { logger } from '../utils/logger';

// How often the outbox poller checks the DB for messages to push over Waku.
const OUTBOX_POLL_INTERVAL_MS = 2000;

// How often we poll the DB for handshake approvals recorded by the CLI/UI.
const APPROVAL_POLL_INTERVAL_MS = 3000;

/**
 * Orchestrates identity, transport, storage and (optional) sync, and enforces
 * access control via handshake-based trust. Emits events so both humans (the
 * TUI) and agents react live:
 *  - `text`            (message: Message)        a TRUSTED incoming text message
 *  - `message`         (message: Message)        any TRUSTED incoming message
 *  - `quarantine`      (message: QuarantinedMessage) an untrusted message held aside
 *  - `agentDiscovered` (agent: AgentIdentity)    a newly discovered peer
 *
 * Trust: a message is trusted only when the sender has a confirmed handshake
 * (status='confirmed'). Untrusted messages are quarantined and never executed.
 * Handshake_init/ack always bypass this check.
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
  // True when a transport was injected (tests use InMemoryTransport). The
  // Waku-fleet startup delay below is meaningless for an in-process transport
  // and would only slow tests, so we skip it in that case.
  private readonly hasInjectedTransport: boolean;

  constructor(config: BridgeConfig, transport?: Transport) {
    super();
    this.config = config;
    this.hasInjectedTransport = !!transport;
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

      // Restore previously confirmed handshakes from storage so trusted
      // agents don't need to re-handshake after a daemon restart.
      const trusted = await this.storage.getAllConfirmedHandshakes();
      if (trusted.length > 0) {
        this.hivesync.restoreTrustedAgents(trusted);
      }

      // Brief pause so the first LightPush epoch can stabilise before the
      // initial announce/sync burst fires — prevents rate-limit rejection
      // on the very first send. Only relevant for the real Waku transport;
      // skipped when a transport is injected (tests) so it doesn't slow them.
      if (!this.hasInjectedTransport) {
        await new Promise((r) => setTimeout(r, 2000));
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

      // Poll for approvals recorded in the DB (e.g. by the CLI `approve`
      // command in a separate process) and complete the handshake for each.
      this.approvalTimer = setInterval(() => {
        void this.storage
          .getRecentlyApproved()
          .then((approved) =>
            Promise.all(
              approved.map((approval) =>
                this.hivesync
                  .completeHandshakeApproval(approval.agentId)
                  .catch((e) => logger.debug('Failed to complete handshake approval:', e))
              )
            )
          )
          .catch((e) => logger.debug('Approval poll error:', e));
      }, APPROVAL_POLL_INTERVAL_MS);
      this.approvalTimer.unref?.();

      // Re-emit pending approvals from a prior run so handlers can surface them.
      const pendingOnStart = await this.storage.getPendingApprovals();
      for (const approval of pendingOnStart) {
        this.emit('handshakeApprovalNeeded', {
          agentId: approval.agentId,
          agentName: approval.agentName,
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
          await this.hivesync.sendMessage({
            sender: this.config.agentId,
            recipient: message.recipient,
            type: message.type,
            content: { text },
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
      const trusted = this.isTrusted(message);
      if (!trusted) {
        await this.quarantineMessage(message);
        return;
      }
      await this.storage.saveMessage(message);
      this.emit('text', message);
      this.emit('message', message);
    });

    this.hivesync.onMessage(MessageType.COMMAND, async (message) => {
      const trusted = this.isTrusted(message);
      const msg: Message = message;
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
   * Decide whether an inbound message is trusted. Trust is based purely on
   * handshake status: only peers whose handshake we have confirmed are trusted.
   * Everyone else (including not-yet-handshaked peers) is quarantined.
   */
  private isTrusted(message: Message): boolean {
    return this.hivesync.getHandshakeStatus(message.sender)?.status === 'confirmed';
  }

  private async quarantineMessage(message: Message): Promise<void> {
    const reason = 'untrusted (handshake not confirmed)';
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
    const willEncrypt = recipient !== 'broadcast' && this.isAgentKnown(recipient);

    const id = await this.hivesync.sendMessage({
      sender: this.config.agentId,
      recipient,
      type: MessageType.TEXT,
      content: { text },
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

  /** Multiaddrs other agents can dial to reach this node (relay hub mode). */
  getDialableMultiaddrs(): string[] {
    return this.hivesync.getDialableMultiaddrs();
  }

  /** This node's libp2p peer id (available after start). */
  getPeerId(): string | undefined {
    return this.hivesync.getStatusSync().peerId;
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
