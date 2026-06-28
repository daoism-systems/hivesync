import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { v4 as uuidv4 } from 'uuid';
import { Message, AgentIdentity, ObsidianNote, SyncState, Contact, HandshakeStatus, HandshakeApproval } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export class StorageManager {
  private db: any = null;
  private storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    
    // Ensure storage directory exists
    const dir = path.dirname(storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async initialize(): Promise<void> {
    this.db = await open({
      filename: this.storagePath,
      driver: sqlite3.Database
    });

    await this.createTables();
    console.log('Storage manager initialized');
  }

  private async createTables(): Promise<void> {
    // Messages table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        encrypted INTEGER NOT NULL,
        signature TEXT,
        delivered INTEGER DEFAULT 0,
        read INTEGER DEFAULT 0,
        auto INTEGER DEFAULT 0
      )
    `);

    // Add the `auto` column to a pre-existing messages table (idempotent).
    await this.migrateMessagesTable();

    // Agents table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        enc_public_key TEXT,
        key_id TEXT,
        created_at DATETIME NOT NULL,
        last_seen DATETIME,
        trusted INTEGER DEFAULT 0,
        handshake_status TEXT DEFAULT 'none',
        capabilities TEXT,
        handshake_confirmed_at DATETIME
      )
    `);

    // Migrate older agents tables that predate the handshake columns.
    await this.migrateAgentsTable();

    // Obsidian notes table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS obsidian_notes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        last_modified DATETIME NOT NULL,
        hash TEXT NOT NULL,
        synced INTEGER DEFAULT 0,
        sync_timestamp DATETIME
      )
    `);

    // Sync state table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        agent_id TEXT PRIMARY KEY,
        last_sync DATETIME NOT NULL,
        notes_synced INTEGER DEFAULT 0,
        conflicts INTEGER DEFAULT 0,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    // Handshake approvals table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS handshake_approvals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        capabilities TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME,
        responded_at DATETIME
      )
    `);

    // Create indexes
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
      CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_notes_path ON obsidian_notes(path);
      CREATE INDEX IF NOT EXISTS idx_notes_hash ON obsidian_notes(hash);
    `);

    await this.migrateHandshakeApprovals();
  }

  /** Idempotent migration hook for future handshake_approvals schema changes. */
  private async migrateHandshakeApprovals(): Promise<void> {
    // Placeholder for future column additions — nothing to migrate yet.
  }

  /** Add the `auto` column to a pre-existing messages table (idempotent). */
  private async migrateMessagesTable(): Promise<void> {
    const cols: any[] = await this.db.all(`PRAGMA table_info(messages)`);
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('auto')) {
      await this.db.exec(`ALTER TABLE messages ADD COLUMN auto INTEGER DEFAULT 0`);
    }
  }

  /** Add handshake columns to a pre-existing agents table (idempotent). */
  private async migrateAgentsTable(): Promise<void> {
    const cols: any[] = await this.db.all(`PRAGMA table_info(agents)`);
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('handshake_status')) {
      await this.db.exec(`ALTER TABLE agents ADD COLUMN handshake_status TEXT DEFAULT 'none'`);
    }
    if (!names.has('capabilities')) {
      await this.db.exec(`ALTER TABLE agents ADD COLUMN capabilities TEXT`);
    }
    if (!names.has('handshake_confirmed_at')) {
      await this.db.exec(`ALTER TABLE agents ADD COLUMN handshake_confirmed_at DATETIME`);
    }
  }

  // Message operations
  async saveMessage(message: Message): Promise<void> {
    // Timestamps may arrive as Date (local) or string/number (deserialized).
    const timestamp =
      message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : new Date(message.timestamp).toISOString();

    // INSERT OR IGNORE: the network can redeliver a message we've already stored.
    await this.db.run(
      `INSERT OR IGNORE INTO messages (id, sender, recipient, type, content, timestamp, encrypted, signature, auto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.sender,
        message.recipient,
        message.type,
        JSON.stringify(message.content),
        timestamp,
        message.encrypted ? 1 : 0,
        message.signature || null,
        message.auto ? 1 : 0
      ]
    );
  }

  private rowToMessage(row: any): Message {
    return {
      id: row.id,
      sender: row.sender,
      recipient: row.recipient,
      type: row.type as any,
      content: JSON.parse(row.content),
      timestamp: new Date(row.timestamp),
      encrypted: row.encrypted === 1,
      signature: row.signature || undefined,
      auto: row.auto === 1,
    };
  }

  async getMessages(limit: number = 100, offset: number = 0): Promise<Message[]> {
    const rows = await this.db.all(
      `SELECT * FROM messages ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return rows.map((row: any) => this.rowToMessage(row));
  }

  /** Text conversation (both directions) between self and a peer, oldest first. */
  async getConversation(peerId: string, selfId: string, limit: number = 500): Promise<Message[]> {
    const rows = await this.db.all(
      `SELECT * FROM messages
       WHERE type = 'text'
         AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
       ORDER BY timestamp ASC LIMIT ?`,
      [peerId, selfId, selfId, peerId, limit]
    );
    return rows.map((row: any) => this.rowToMessage(row));
  }

  /** All broadcast text messages, oldest first. */
  async getBroadcasts(limit: number = 500): Promise<Message[]> {
    const rows = await this.db.all(
      `SELECT * FROM messages
       WHERE type = 'text' AND recipient = 'broadcast'
       ORDER BY timestamp ASC LIMIT ?`,
      [limit]
    );
    return rows.map((row: any) => this.rowToMessage(row));
  }

  async getUnreadMessages(): Promise<Message[]> {
    const rows = await this.db.all(
      `SELECT * FROM messages WHERE read = 0 ORDER BY timestamp ASC`
    );

    return rows.map((row: any) => this.rowToMessage(row));
  }

  async markMessageAsRead(messageId: string): Promise<void> {
    await this.db.run(
      `UPDATE messages SET read = 1 WHERE id = ?`,
      [messageId]
    );
  }

  /**
   * Outgoing messages we authored that haven't been sent over Waku yet. These
   * are typically written directly to the DB by external adapters (e.g. Hermes)
   * which never contact the daemon; the outbox poller picks them up and sends.
   */
  async getPendingOutgoing(agentId: string): Promise<Message[]> {
    const rows = await this.db.all(
      `SELECT * FROM messages WHERE sender = ? AND delivered = 0 ORDER BY timestamp ASC`,
      [agentId]
    );
    return rows.map((row: any) => this.rowToMessage(row));
  }

  /** Mark an outgoing message as delivered (successfully sent over Waku). */
  async markDelivered(messageId: string): Promise<void> {
    await this.db.run(
      `UPDATE messages SET delivered = 1 WHERE id = ?`,
      [messageId]
    );
  }

  // Agent operations
  async saveAgent(agent: AgentIdentity): Promise<void> {
    // Preserve trust flag and original created_at across re-announcements.
    await this.db.run(
      `INSERT INTO agents (id, name, public_key, enc_public_key, key_id, created_at, last_seen, trusted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         public_key = excluded.public_key,
         enc_public_key = excluded.enc_public_key,
         key_id = excluded.key_id,
         last_seen = excluded.last_seen`,
      [
        agent.id,
        agent.name,
        agent.publicKey,
        agent.encPublicKey || null,
        agent.keyId || null,
        agent.createdAt.toISOString(),
        (agent.lastSeen || new Date()).toISOString(),
      ]
    );
  }

  private rowToAgent(row: any): AgentIdentity {
    return {
      id: row.id,
      name: row.name,
      publicKey: row.public_key,
      encPublicKey: row.enc_public_key || undefined,
      keyId: row.key_id || undefined,
      createdAt: new Date(row.created_at),
      lastSeen: row.last_seen ? new Date(row.last_seen) : undefined,
    };
  }

  async getAgent(agentId: string): Promise<AgentIdentity | null> {
    const row = await this.db.get(`SELECT * FROM agents WHERE id = ?`, [agentId]);
    return row ? this.rowToAgent(row) : null;
  }

  async getAllAgents(): Promise<AgentIdentity[]> {
    const rows = await this.db.all(`SELECT * FROM agents ORDER BY last_seen DESC`);
    return rows.map((row: any) => this.rowToAgent(row));
  }

  /** Load agents with a confirmed handshake (persists across restarts). */
  async getAllConfirmedHandshakes(): Promise<Array<{
    id: string; name: string; publicKey: string; encPublicKey?: string;
    keyId?: string; handshakeStatus?: string; handshakeConfirmedAt?: string;
  }>> {
    const rows = await this.db.all(
      `SELECT id, name, public_key, enc_public_key, key_id, handshake_status, handshake_confirmed_at
       FROM agents WHERE handshake_status = 'confirmed'`
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      publicKey: r.public_key,
      encPublicKey: r.enc_public_key || undefined,
      keyId: r.key_id || undefined,
      handshakeStatus: r.handshake_status,
      handshakeConfirmedAt: r.handshake_confirmed_at,
    }));
  }

  async updateAgentLastSeen(agentId: string): Promise<void> {
    await this.db.run(
      `UPDATE agents SET last_seen = ? WHERE id = ?`,
      [new Date().toISOString(), agentId]
    );
  }

  // Handshake / contacts operations

  /**
   * Persist the outcome of a handshake. A confirmed handshake promotes the peer
   * to a trusted "friend" (trusted = 1).
   */
  async saveAgentHandshake(
    agentId: string,
    status: HandshakeStatus,
    capabilities: string[],
    confirmedAt?: Date
  ): Promise<void> {
    await this.db.run(
      `UPDATE agents
         SET handshake_status = ?,
             capabilities = ?,
             handshake_confirmed_at = ?,
             trusted = ?
       WHERE id = ?`,
      [
        status,
        JSON.stringify(capabilities ?? []),
        confirmedAt ? confirmedAt.toISOString() : null,
        status === 'confirmed' ? 1 : 0,
        agentId,
      ]
    );
  }

  async getAgentHandshake(
    agentId: string
  ): Promise<{ status: HandshakeStatus; capabilities: string[]; confirmedAt?: Date } | null> {
    const row = await this.db.get(
      `SELECT handshake_status, capabilities, handshake_confirmed_at FROM agents WHERE id = ?`,
      [agentId]
    );
    if (!row) return null;
    return {
      status: (row.handshake_status || 'none') as HandshakeStatus,
      capabilities: parseCapabilities(row.capabilities),
      confirmedAt: row.handshake_confirmed_at ? new Date(row.handshake_confirmed_at) : undefined,
    };
  }

  /** All peers whose handshake has been confirmed, most recently seen first. */
  async getAllContacts(): Promise<Contact[]> {
    const rows = await this.db.all(
      `SELECT * FROM agents WHERE handshake_status = 'confirmed' ORDER BY last_seen DESC`
    );
    return rows.map((row: any) => this.rowToContact(row));
  }

  /** A single contact (with handshake details), or null if unknown. */
  async getContact(agentId: string): Promise<Contact | null> {
    const row = await this.db.get(`SELECT * FROM agents WHERE id = ?`, [agentId]);
    return row ? this.rowToContact(row) : null;
  }

  private rowToContact(row: any): Contact {
    return {
      id: row.id,
      name: row.name,
      capabilities: parseCapabilities(row.capabilities),
      handshakeStatus: (row.handshake_status || 'none') as HandshakeStatus,
      handshakeConfirmedAt: row.handshake_confirmed_at ? new Date(row.handshake_confirmed_at) : undefined,
      lastSeen: row.last_seen ? new Date(row.last_seen) : undefined,
    };
  }

  // Obsidian notes operations
  async saveNote(note: ObsidianNote): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO obsidian_notes (id, path, content, last_modified, hash, synced)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        note.id,
        note.path,
        note.content,
        note.lastModified.toISOString(),
        note.hash,
        0 // Not synced yet
      ]
    );
  }

  async getNoteByPath(notePath: string): Promise<ObsidianNote | null> {
    const row = await this.db.get(
      `SELECT * FROM obsidian_notes WHERE path = ?`,
      [notePath]
    );

    if (!row) return null;

    return {
      id: row.id,
      path: row.path,
      content: row.content,
      lastModified: new Date(row.last_modified),
      hash: row.hash,
    };
  }

  async getModifiedNotes(since: Date): Promise<ObsidianNote[]> {
    const rows = await this.db.all(
      `SELECT * FROM obsidian_notes WHERE last_modified > ? ORDER BY last_modified DESC`,
      [since.toISOString()]
    );

    return rows.map((row: any) => ({
      id: row.id,
      path: row.path,
      content: row.content,
      lastModified: new Date(row.last_modified),
      hash: row.hash,
    }));
  }

  async markNoteAsSynced(noteId: string, agentId: string): Promise<void> {
    await this.db.run(
      `UPDATE obsidian_notes SET synced = 1, sync_timestamp = ? WHERE id = ?`,
      [new Date().toISOString(), noteId]
    );

    // Update sync state
    await this.updateSyncState(agentId, 1, 0);
  }

  // Sync state operations
  async updateSyncState(agentId: string, notesSynced: number, conflicts: number): Promise<void> {
    await this.db.run(
      `INSERT OR REPLACE INTO sync_state (agent_id, last_sync, notes_synced, conflicts)
       VALUES (?, ?, COALESCE((SELECT notes_synced FROM sync_state WHERE agent_id = ?), 0) + ?,
               COALESCE((SELECT conflicts FROM sync_state WHERE agent_id = ?), 0) + ?)`,
      [
        agentId,
        new Date().toISOString(),
        agentId,
        notesSynced,
        agentId,
        conflicts
      ]
    );
  }

  async getSyncState(agentId: string): Promise<SyncState | null> {
    const row = await this.db.get(
      `SELECT * FROM sync_state WHERE agent_id = ?`,
      [agentId]
    );

    if (!row) return null;

    return {
      agentId: row.agent_id,
      lastSync: new Date(row.last_sync),
      notesSynced: row.notes_synced,
      conflicts: row.conflicts,
    };
  }

  // Handshake approval operations

  async createHandshakeApproval(agentId: string, agentName: string, capabilities: string[]): Promise<string> {
    const id = uuidv4();
    await this.db.run(
      `INSERT INTO handshake_approvals (id, agent_id, agent_name, capabilities, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [id, agentId, agentName, JSON.stringify(capabilities), new Date().toISOString()]
    );
    return id;
  }

  async getPendingApprovals(): Promise<HandshakeApproval[]> {
    const rows = await this.db.all(
      `SELECT * FROM handshake_approvals WHERE status = 'pending' ORDER BY created_at ASC`
    );
    return rows.map((row: any) => this.rowToApproval(row));
  }

  async approveHandshakeByAgent(agentId: string): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE handshake_approvals SET status = 'approved', responded_at = ?
       WHERE agent_id = ? AND status = 'pending'`,
      [new Date().toISOString(), agentId]
    );
    return (result.changes ?? 0) > 0;
  }

  async denyHandshakeByAgent(agentId: string): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE handshake_approvals SET status = 'denied', responded_at = ?
       WHERE agent_id = ? AND status = 'pending'`,
      [new Date().toISOString(), agentId]
    );
    return (result.changes ?? 0) > 0;
  }

  async getRecentlyApproved(): Promise<HandshakeApproval[]> {
    const cutoff = new Date(Date.now() - 30000).toISOString();
    const rows = await this.db.all(
      `SELECT * FROM handshake_approvals WHERE status = 'approved' AND responded_at > ?`,
      [cutoff]
    );
    return rows.map((row: any) => this.rowToApproval(row));
  }

  private rowToApproval(row: any): HandshakeApproval {
    return {
      id: row.id,
      agentId: row.agent_id,
      agentName: row.agent_name ?? '',
      capabilities: parseCapabilities(row.capabilities),
      status: row.status as 'pending' | 'approved' | 'denied',
      createdAt: new Date(row.created_at),
      respondedAt: row.responded_at ? new Date(row.responded_at) : undefined,
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
      } catch (_) {
        // already closed
      }
      this.db = null;
    }
  }
}

/** Tolerantly decode the JSON-encoded capabilities column. */
function parseCapabilities(raw: any): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
