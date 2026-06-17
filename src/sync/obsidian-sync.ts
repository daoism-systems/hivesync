import { MessageType, ObsidianNote, SyncState } from '../types';
import { HiveSync } from '../core/hivesync-bridge';
import { StorageManager } from '../storage/storage-manager';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export class ObsidianSyncManager {
  private bridge: HiveSync;
  private storage: StorageManager;
  private vaultPath: string;
  private syncInterval: NodeJS.Timeout | null = null;

  constructor(bridge: HiveSync, storage: StorageManager, vaultPath: string) {
    this.bridge = bridge;
    this.storage = storage;
    this.vaultPath = vaultPath;

    // Register message handlers
    this.setupMessageHandlers();
  }

  private setupMessageHandlers(): void {
    // Handle sync requests
    this.bridge.onMessage(MessageType.SYNC_REQUEST, async (message) => {
      console.log(`Received sync request from ${message.sender}`);
      await this.handleSyncRequest(message);
    });

    // Handle sync responses
    this.bridge.onMessage(MessageType.SYNC_RESPONSE, async (message) => {
      console.log(`Received sync response from ${message.sender}`);
      await this.handleSyncResponse(message);
    });

    // Handle Obsidian updates
    this.bridge.onMessage(MessageType.OBSIDIAN_UPDATE, async (message) => {
      console.log(`Received Obsidian update from ${message.sender}`);
      await this.handleObsidianUpdate(message);
    });
  }

  async startSync(intervalMinutes: number = 5): Promise<void> {
    console.log(`Starting Obsidian sync with ${intervalMinutes} minute interval`);
    
    // Initial sync
    await this.syncWithAllAgents();

    // Set up periodic sync
    this.syncInterval = setInterval(
      () => this.syncWithAllAgents(),
      intervalMinutes * 60 * 1000
    );
  }

  async stopSync(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('Obsidian sync stopped');
    }
  }

  async syncWithAllAgents(): Promise<void> {
    try {
      const agents = await this.storage.getAllAgents();
      
      for (const agent of agents) {
        await this.requestSync(agent.id);
      }
    } catch (error) {
      console.error('Error syncing with agents:', error);
    }
  }

  async requestSync(agentId: string): Promise<void> {
    const lastSyncState = await this.storage.getSyncState(agentId);
    const lastSyncTime = lastSyncState?.lastSync || new Date(0);

    const syncRequest = {
      sender: this.bridge.agentId,
      recipient: agentId,
      type: MessageType.SYNC_REQUEST,
      content: {
        since: lastSyncTime.toISOString(),
        requestId: uuidv4(),
      },
      encrypted: true,
    };

    await this.bridge.sendMessage(syncRequest);
    console.log(`Sync request sent to ${agentId}`);
  }

  private async handleSyncRequest(message: any): Promise<void> {
    const { since, requestId } = message.content;
    const sinceDate = new Date(since);

    // Get modified notes since last sync
    const modifiedNotes = await this.getModifiedNotesSince(sinceDate);

    // Prepare sync response
    const syncResponse = {
      sender: this.bridge.agentId,
      recipient: message.sender,
      type: MessageType.SYNC_RESPONSE,
      content: {
        requestId,
        notes: modifiedNotes,
        timestamp: new Date().toISOString(),
      },
      encrypted: true,
    };

    await this.bridge.sendMessage(syncResponse);
    console.log(`Sent ${modifiedNotes.length} notes to ${message.sender}`);
  }

  private async handleSyncResponse(message: any): Promise<void> {
    const { notes } = message.content;
    const sender = message.sender;

    console.log(`Processing ${notes.length} notes from ${sender}`);

    let conflicts = 0;
    let synced = 0;

    for (const noteData of notes) {
      const note: ObsidianNote = {
        id: noteData.id || uuidv4(),
        path: noteData.path,
        content: noteData.content,
        lastModified: new Date(noteData.lastModified),
        hash: noteData.hash,
      };

      // Check for conflicts
      const existingNote = await this.storage.getNoteByPath(note.path);
      
      if (existingNote) {
        // Conflict resolution: keep the most recent version
        if (note.lastModified > existingNote.lastModified) {
          await this.saveNoteToVault(note);
          await this.storage.saveNote(note);
          synced++;
        } else {
          conflicts++;
        }
      } else {
        // New note
        await this.saveNoteToVault(note);
        await this.storage.saveNote(note);
        synced++;
      }

      // Mark as synced
      await this.storage.markNoteAsSynced(note.id, sender);
    }

    // Update sync state
    await this.storage.updateSyncState(sender, synced, conflicts);

    console.log(`Sync completed: ${synced} notes synced, ${conflicts} conflicts`);
  }

  private async handleObsidianUpdate(message: any): Promise<void> {
    const noteData = message.content;
    const note: ObsidianNote = {
      id: noteData.id || uuidv4(),
      path: noteData.path,
      content: noteData.content,
      lastModified: new Date(noteData.lastModified),
      hash: noteData.hash,
    };

    // Save the note
    await this.saveNoteToVault(note);
    await this.storage.saveNote(note);

    console.log(`Updated note: ${note.path} from ${message.sender}`);

    // Forward to other agents (except sender)
    const agents = await this.storage.getAllAgents();
    for (const agent of agents) {
      if (agent.id !== message.sender) {
        const updateMessage = {
          sender: this.bridge.agentId,
          recipient: agent.id,
          type: MessageType.OBSIDIAN_UPDATE,
          content: noteData,
          encrypted: true,
        };
        await this.bridge.sendMessage(updateMessage);
      }
    }
  }

  async scanVault(): Promise<ObsidianNote[]> {
    const notes: ObsidianNote[] = [];

    if (!fs.existsSync(this.vaultPath)) {
      console.warn(`Vault path does not exist: ${this.vaultPath}`);
      return notes;
    }

    const scanDirectory = async (dir: string): Promise<void> => {
      const files = fs.readdirSync(dir);

      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          await scanDirectory(fullPath);
        } else if (file.endsWith('.md')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const relativePath = path.relative(this.vaultPath, fullPath);
          const hash = this.calculateHash(content);

          const note: ObsidianNote = {
            id: uuidv4(),
            path: relativePath,
            content,
            lastModified: stat.mtime,
            hash,
          };

          notes.push(note);
          await this.storage.saveNote(note);
        }
      }
    };

    await scanDirectory(this.vaultPath);
    console.log(`Scanned ${notes.length} notes from vault`);
    return notes;
  }

  private async getModifiedNotesSince(since: Date): Promise<any[]> {
    const notes = await this.storage.getModifiedNotes(since);
    return notes.map(note => ({
      id: note.id,
      path: note.path,
      content: note.content,
      lastModified: note.lastModified.toISOString(),
      hash: note.hash,
    }));
  }

  private async saveNoteToVault(note: ObsidianNote): Promise<void> {
    const fullPath = path.join(this.vaultPath, note.path);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write the note
    fs.writeFileSync(fullPath, note.content, 'utf-8');

    // Update modification time
    fs.utimesSync(fullPath, new Date(), note.lastModified);
  }

  private calculateHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  async getSyncStatus(): Promise<SyncState[]> {
    const agents = await this.storage.getAllAgents();
    const statuses: SyncState[] = [];

    for (const agent of agents) {
      const state = await this.storage.getSyncState(agent.id);
      if (state) {
        statuses.push(state);
      }
    }

    return statuses;
  }
}
