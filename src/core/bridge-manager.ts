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
import { BridgeConfig, AgentIdentity, Message, MessageType, QuarantinedMessage } from '../types';
import { logger } from '../utils/logger';

// Meta fields carried inside the (encrypted) message content, stripped before
// the message is stored or handed to consumers.
const AUTH_FIELD = '__auth';
const AUTO_FIELD = '__auto';

/**
 * Orchestrates identity, transport, storage and (optional) sync, and enforces
 * access control. Emits events so both humans (the TUI) and agents react live:
 *  - `text`            (message: Message)        a TRUSTED incoming text message
 *  - `message`         (message: Message)        any TRUSTED incoming message
 *  - `quarantine`      (message: QuarantinedMessage) an untrusted message held aside
 *  - `agentDiscovered` (agent: AgentIdentity)    a newly discovered peer
 *
 * Trust: if a password is configured (`config.auth`), an inbound message is
 * trusted only when it is E2E-encrypted AND carries the matching password.
 * Untrusted messages are quarantined (isolated files) and never executed. With
 * no password configured the agent runs in open mode (all messages trusted).
 */
export class BridgeManager extends EventEmitter {
  private readonly config: BridgeConfig;
  private readonly identity: Identity;
  private readonly hivesync: HiveSync;
  private readonly storage: StorageManager;
  private readonly quarantine: QuarantineStore;
  // Outbound passwords for peers, entered this session and never persisted.
  private readonly sessionPasswords = new Map<string, string>();
  private realTimeSync: RealTimeSyncManager | null = null;
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

      // Persist agents we discover on the network, and notify listeners.
      this.hivesync.onAgentDiscovered(async (agent) => {
        await this.storage.saveAgent(agent);
        this.emit('agentDiscovered', agent);
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
    if (this.realTimeSync) {
      await this.realTimeSync.stop().catch(() => undefined);
      this.realTimeSync = null;
    }
    await this.hivesync.disconnect().catch(() => undefined);
    await this.storage.close();
    this.isRunning = false;
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
      logger.debug(`ACK from ${message.sender} for ${message.content?.originalMessageId}`);
    });
  }

  /**
   * Decide whether an inbound message is trusted, and strip the meta fields
   * (password / auto-reply marker) from its content.
   */
  private classify(message: Message): { trusted: boolean; content: any; isAuto: boolean } {
    const content = { ...(message.content ?? {}) };
    const auth = typeof content[AUTH_FIELD] === 'string' ? (content[AUTH_FIELD] as string) : undefined;
    const isAuto = content[AUTO_FIELD] === true;
    delete content[AUTH_FIELD];
    delete content[AUTO_FIELD];

    let trusted: boolean;
    if (!this.config.auth?.hash) {
      trusted = true; // open mode
    } else {
      // Trust requires an encrypted message carrying the matching password.
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
      : 'quarantined';
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
   * Internal text send. Attaches the session password as `__auth` ONLY when the
   * message will actually be encrypted to the recipient (so a password is never
   * sent in the clear). `auto` tags an automated reply so it can't re-trigger
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
    if (willEncrypt) {
      const pw = this.sessionPasswords.get(recipient);
      if (pw) wire[AUTH_FIELD] = pw;
    }

    const id = await this.hivesync.sendMessage({
      sender: this.config.agentId,
      recipient,
      type: MessageType.TEXT,
      content: wire,
      encrypted: recipient !== 'broadcast',
    });
    // Record our own outgoing message (clean content) so history is complete.
    await this.storage.saveMessage({
      id,
      sender: this.config.agentId,
      recipient,
      type: MessageType.TEXT,
      content: { text },
      timestamp: new Date(),
      encrypted: willEncrypt,
    });
    return id;
  }

  private isAgentKnown(agentId: string): boolean {
    return this.hivesync.getKnownAgents().some((a) => a.id === agentId && !!a.encPublicKey);
  }

  // --- access control (outbound) ------------------------------------------

  /** Store a peer's password for this session only (never persisted). */
  setAgentPassword(agentId: string, password: string): void {
    if (password) this.sessionPasswords.set(agentId, password);
    else this.sessionPasswords.delete(agentId);
  }

  clearAgentPassword(agentId: string): void {
    this.sessionPasswords.delete(agentId);
  }

  hasAgentPassword(agentId: string): boolean {
    return this.sessionPasswords.has(agentId);
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
