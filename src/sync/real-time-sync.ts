import { MessageType, ObsidianNote, SyncState } from '../types';
import { HiveSync } from '../core/hivesync-bridge';
import { StorageManager } from '../storage/storage-manager';
import { FileWatcher, FileChangeEvent } from './file-watcher';
import { mergeNoteContent, blocksMissingFrom } from './merge';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

export class RealTimeSyncManager {
  private bridge: HiveSync;
  private storage: StorageManager;
  private fileWatcher: FileWatcher | null = null;
  private vaultPath: string;
  private syncQueue: Map<string, Promise<void>> = new Map();
  private pendingChanges: Set<string> = new Set();
  private isProcessing: boolean = false;
  private syncDebounceTimer: NodeJS.Timeout | null = null;
  private syncDebounceDelay: number = 1000; // 1 second debounce
  // Paths we just wrote from a remote update — used to suppress the resulting
  // file-watcher event so a synced note isn't immediately re-broadcast (loop).
  private remoteWrites: Set<string> = new Set();

  constructor(bridge: HiveSync, storage: StorageManager, vaultPath: string) {
    this.bridge = bridge;
    this.storage = storage;
    this.vaultPath = vaultPath;

    // Register message handlers
    this.setupMessageHandlers();
  }

  private setupMessageHandlers(): void {
    // Handle real-time updates
    this.bridge.onMessage(MessageType.OBSIDIAN_UPDATE, async (message) => {
      await this.handleRemoteUpdate(message);
    });

    // Handle sync requests
    this.bridge.onMessage(MessageType.SYNC_REQUEST, async (message) => {
      await this.handleSyncRequest(message);
    });

    // Handle sync responses
    this.bridge.onMessage(MessageType.SYNC_RESPONSE, async (message) => {
      await this.handleSyncResponse(message);
    });
  }

  async start(): Promise<void> {
    logger.info('Starting real-time Obsidian sync...');

    // Initialize file watcher
    this.fileWatcher = new FileWatcher(
      this.vaultPath,
      async (event: FileChangeEvent) => {
        await this.handleFileChange(event);
      }
    );

    await this.fileWatcher.start();

    // Flush the initial scan into storage immediately (instead of waiting for
    // the debounce) so the first sync request/response sees the full vault.
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
      this.syncDebounceTimer = null;
    }
    await this.processPendingChanges();

    // Perform initial sync with all known agents
    await this.syncWithAllAgents();

    logger.info('Real-time Obsidian sync started');
  }

  async stop(): Promise<void> {
    if (this.fileWatcher) {
      await this.fileWatcher.stop();
      this.fileWatcher = null;
    }

    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
      this.syncDebounceTimer = null;
    }

    logger.info('Real-time Obsidian sync stopped');
  }

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    const { type, path: filePath } = event;

    // Only process markdown files
    if (!filePath.endsWith('.md') && type !== 'unlink') {
      return;
    }

    // Suppress events caused by our own remote-update writes (anti-loop).
    if (this.remoteWrites.has(filePath)) {
      this.remoteWrites.delete(filePath);
      return;
    }

    logger.debug(`File change detected: ${type} ${filePath}`);

    // Add to pending changes
    this.pendingChanges.add(filePath);

    // Debounce sync to batch multiple changes
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }

    this.syncDebounceTimer = setTimeout(async () => {
      await this.processPendingChanges();
    }, this.syncDebounceDelay);
  }

  private async processPendingChanges(): Promise<void> {
    if (this.isProcessing || this.pendingChanges.size === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      const changes = Array.from(this.pendingChanges);
      this.pendingChanges.clear();

      logger.info(`Processing ${changes.length} file changes`);

      for (const filePath of changes) {
        await this.processFileChange(filePath);
      }

      // Sync changes with all agents
      await this.syncChangesWithAgents(changes);
    } catch (error) {
      logger.error('Error processing pending changes:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processFileChange(filePath: string): Promise<void> {
    try {
      const fullPath = path.join(this.vaultPath, filePath);
      
      if (!this.fileWatcher) {
        return;
      }

      // Check if file still exists
      if (!fs.existsSync(fullPath)) {
        // Additive sync: the vault only ever expands. A deleted note is
        // restored from its last known content in storage, and no deletion
        // ever propagates to peers.
        const stored = await this.storage.getNoteByPath(filePath);
        if (stored && stored.hash !== 'DELETED' && stored.content !== '') {
          this.remoteWrites.add(filePath);
          if (this.fileWatcher) {
            await this.fileWatcher.saveNoteContent(filePath, stored.content);
          }
          logger.info(`Restored locally deleted note ${filePath} (additive sync never deletes)`);
        }
        return;
      }

      // Read file content
      const content = await this.fileWatcher.getNoteContent(filePath);
      const stats = fs.statSync(fullPath);
      const hash = this.calculateHash(content);

      // Check if note exists and has changed
      const existingNote = await this.storage.getNoteByPath(filePath);
      
      if (!existingNote || existingNote.hash !== hash) {
        // Note is new or changed
        const note: ObsidianNote = {
          id: existingNote?.id || uuidv4(),
          path: filePath,
          content,
          lastModified: stats.mtime,
          hash,
        };

        await this.storage.saveNote(note);
        logger.debug(`Updated note in storage: ${filePath}`);
      }
    } catch (error) {
      logger.error(`Error processing file change for ${filePath}:`, error);
    }
  }

  private async syncChangesWithAgents(changedFiles: string[]): Promise<void> {
    const agents = await this.storage.getAllAgents();

    for (const agent of agents) {
      if (agent.id === this.bridge.agentId) continue; // don't sync with self
      await this.syncChangesWithAgent(agent.id, changedFiles);
    }
  }

  private async syncChangesWithAgent(agentId: string, changedFiles: string[]): Promise<void> {
    try {
      const notes: ObsidianNote[] = [];

      for (const filePath of changedFiles) {
        const note = await this.storage.getNoteByPath(filePath);
        if (note) {
          notes.push(note);
        }
      }

      if (notes.length === 0) {
        return;
      }

      const updateMessage = {
        sender: this.bridge.agentId,
        recipient: agentId,
        type: MessageType.OBSIDIAN_UPDATE,
        content: {
          notes: notes.map(note => ({
            id: note.id,
            path: note.path,
            content: note.content,
            lastModified: note.lastModified.toISOString(),
            hash: note.hash,
          })),
          timestamp: new Date().toISOString(),
        },
        encrypted: true,
      };

      await this.bridge.sendMessage(updateMessage);
      logger.info(`Sent ${notes.length} updates to ${agentId}`);
    } catch (error) {
      logger.error(`Error syncing changes with agent ${agentId}:`, error);
    }
  }

  private async handleRemoteUpdate(message: any): Promise<void> {
    const { notes } = message.content;
    const sender = message.sender;

    logger.info(`Received ${notes.length} updates from ${sender}`);

    const { applied, enriched } = await this.mergeIncomingNotes(notes);

    // Update sync state
    await this.storage.updateSyncState(sender, applied, 0);

    // Reciprocal enrichment: for notes where we held content the sender lacks,
    // push the merged version back so the sender's vault expands too. The
    // exchange terminates because merging is idempotent — once both sides hold
    // the same block set, merges stop producing changes.
    if (enriched.length > 0) {
      await this.sendNotesToAgent(sender, enriched);
    }

    logger.info(
      `Merged ${applied} updates from ${sender}` +
        (enriched.length > 0 ? `, sent ${enriched.length} enriched notes back` : '')
    );
  }

  /**
   * Additively merge incoming notes into the vault. Never deletes or shrinks
   * a local note. Returns the notes where the merge result contains content
   * the sender didn't have (candidates for reciprocal enrichment).
   */
  private async mergeIncomingNotes(
    notes: any[]
  ): Promise<{ applied: number; enriched: ObsidianNote[] }> {
    let applied = 0;
    const enriched: ObsidianNote[] = [];

    for (const noteData of notes) {
      const incoming: ObsidianNote = {
        id: noteData.id || uuidv4(),
        path: noteData.path,
        content: noteData.content,
        lastModified: new Date(noteData.lastModified),
        hash: noteData.hash,
      };

      // Additive sync: remote deletion tombstones are ignored — a peer
      // deleting a note never deletes ours.
      if (incoming.hash === 'DELETED' || incoming.content === '') {
        logger.info(`Ignoring deletion tombstone for ${incoming.path} (additive sync)`);
        continue;
      }

      const existingNote = await this.storage.getNoteByPath(incoming.path);

      // The file on disk is the authoritative local content. Storage may lag
      // behind it (update arriving before the initial scan finishes) or run
      // ahead of it (a locally deleted file whose content storage retains so
      // peers can restore it) — merging against anything but the real file
      // could overwrite bytes we never merged.
      let localContent = '';
      const fullPath = path.join(this.vaultPath, incoming.path);
      if (fs.existsSync(fullPath)) {
        try {
          localContent = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logger.warn(`Could not read ${incoming.path} for merge, treating as empty:`, error);
        }
      }

      const merge = mergeNoteContent(localContent, incoming.content);

      if (merge.changed) {
        const mergedNote: ObsidianNote = {
          id: existingNote?.id || incoming.id,
          path: incoming.path,
          content: merge.content,
          lastModified: new Date(),
          hash: this.calculateHash(merge.content),
        };
        await this.applyNoteUpdate(mergedNote);
        applied++;
        // Reply only if we hold blocks the sender lacks (block-set comparison,
        // so order-only differences never trigger a reply loop).
        if (blocksMissingFrom(merge.content, incoming.content).length > 0) {
          enriched.push(mergedNote);
        }
      } else if (
        localContent !== '' &&
        blocksMissingFrom(localContent, incoming.content).length > 0
      ) {
        // Nothing new for us, but our copy has blocks the sender lacks.
        enriched.push({
          id: existingNote?.id || incoming.id,
          path: incoming.path,
          content: localContent,
          lastModified: new Date(),
          hash: this.calculateHash(localContent),
        });
      }
    }

    return { applied, enriched };
  }

  private async sendNotesToAgent(agentId: string, notes: ObsidianNote[]): Promise<void> {
    try {
      const updateMessage = {
        sender: this.bridge.agentId,
        recipient: agentId,
        type: MessageType.OBSIDIAN_UPDATE,
        content: {
          notes: notes.map((note) => ({
            id: note.id,
            path: note.path,
            content: note.content,
            lastModified: note.lastModified.toISOString(),
            hash: note.hash,
          })),
          timestamp: new Date().toISOString(),
        },
        encrypted: true,
      };
      await this.bridge.sendMessage(updateMessage);
    } catch (error) {
      logger.error(`Error sending enriched notes to ${agentId}:`, error);
    }
  }

  private async applyNoteUpdate(note: ObsidianNote): Promise<void> {
    if (this.fileWatcher) {
      // Flag the path so the resulting watcher event is ignored (anti-loop).
      this.remoteWrites.add(note.path);
      await this.fileWatcher.saveNoteContent(note.path, note.content);
    }

    await this.storage.saveNote(note);
    await this.storage.markNoteAsSynced(note.id, 'remote-update');
  }

  private async handleSyncRequest(message: any): Promise<void> {
    const { since, requestId } = message.content;
    const sinceDate = new Date(since);

    // Get modified notes since last sync. Deletion tombstones are never
    // shared — additive sync only ever propagates content.
    const modifiedNotes = (await this.storage.getModifiedNotes(sinceDate)).filter(
      (note) => note.hash !== 'DELETED' && note.content !== ''
    );

    const syncResponse = {
      sender: this.bridge.agentId,
      recipient: message.sender,
      type: MessageType.SYNC_RESPONSE,
      content: {
        requestId,
        notes: modifiedNotes.map(note => ({
          id: note.id,
          path: note.path,
          content: note.content,
          lastModified: note.lastModified.toISOString(),
          hash: note.hash,
        })),
        timestamp: new Date().toISOString(),
      },
      encrypted: true,
    };

    await this.bridge.sendMessage(syncResponse);
    logger.info(`Sent sync response with ${modifiedNotes.length} notes to ${message.sender}`);
  }

  private async handleSyncResponse(message: any): Promise<void> {
    const { notes } = message.content;
    const sender = message.sender;

    logger.info(`Processing sync response with ${notes.length} notes from ${sender}`);

    const { applied, enriched } = await this.mergeIncomingNotes(notes);

    // Update sync state
    await this.storage.updateSyncState(sender, applied, 0);

    // Push back anything we hold that the sender lacks — sync rounds enrich
    // both vaults, not just ours.
    if (enriched.length > 0) {
      await this.sendNotesToAgent(sender, enriched);
    }

    logger.info(
      `Sync completed: ${applied} merged` +
        (enriched.length > 0 ? `, ${enriched.length} enriched notes sent back` : '')
    );
  }

  async syncWithAllAgents(): Promise<void> {
    try {
      const agents = await this.storage.getAllAgents();

      for (const agent of agents) {
        if (agent.id === this.bridge.agentId) continue; // don't sync with self
        await this.requestSync(agent.id);
      }
    } catch (error) {
      logger.error('Error syncing with agents:', error);
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
    logger.info(`Sync request sent to ${agentId}`);
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

  private calculateHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  isWatching(): boolean {
    return this.fileWatcher?.isRunning() || false;
  }
}
