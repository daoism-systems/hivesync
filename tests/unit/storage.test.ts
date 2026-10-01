import { StorageManager } from '../../src/storage/storage-manager';
import { Message, MessageType, AgentIdentity, ObsidianNote } from '../../src/types';

describe('StorageManager', () => {
  let storage: StorageManager;

  beforeEach(async () => {
    storage = new StorageManager(':memory:');
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  describe('Message Operations', () => {
    test('should save and retrieve messages', async () => {
      const msg: Message = {
        id: 'msg-1',
        sender: 'agent-1',
        recipient: 'agent-2',
        type: MessageType.TEXT,
        content: { text: 'Hello, world!' },
        timestamp: new Date(),
        encrypted: true,
        signature: 'test-sig',
      };

      await storage.saveMessage(msg);
      const messages = await storage.getMessages(10, 0);

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('msg-1');
      expect(messages[0].sender).toBe('agent-1');
      expect(messages[0].content.text).toBe('Hello, world!');
      expect(messages[0].encrypted).toBe(true);
    });

    test('should mark messages as read', async () => {
      const msg: Message = {
        id: 'msg-2',
        sender: 'agent-1',
        recipient: 'agent-2',
        type: MessageType.TEXT,
        content: { text: 'Test' },
        timestamp: new Date(),
        encrypted: false,
      };

      await storage.saveMessage(msg);

      let unread = await storage.getUnreadMessages();
      expect(unread).toHaveLength(1);

      await storage.markMessageAsRead('msg-2');

      unread = await storage.getUnreadMessages();
      expect(unread).toHaveLength(0);
    });

    test('should paginate messages', async () => {
      for (let i = 0; i < 15; i++) {
        await storage.saveMessage({
          id: `msg-${i}`,
          sender: 'agent-1',
          recipient: 'agent-2',
          type: MessageType.TEXT,
          content: { text: `Message ${i}` },
          timestamp: new Date(Date.now() + i * 1000),
          encrypted: false,
        });
      }

      const firstPage = await storage.getMessages(10, 0);
      expect(firstPage).toHaveLength(10);
      expect(firstPage[0].id).toBe('msg-14');

      const secondPage = await storage.getMessages(10, 10);
      expect(secondPage).toHaveLength(5);
      expect(secondPage[0].id).toBe('msg-4');
    });
  });

  describe('Agent Operations', () => {
    test('should save and retrieve agents', async () => {
      const agent: AgentIdentity = {
        id: 'agent-1',
        name: 'Test Agent',
        publicKey: 'pk-abc',
        createdAt: new Date(),
      };

      await storage.saveAgent(agent);
      const retrieved = await storage.getAgent('agent-1');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('agent-1');
      expect(retrieved!.name).toBe('Test Agent');
      expect(retrieved!.publicKey).toBe('pk-abc');
    });

    test('should return null for missing agents', async () => {
      const result = await storage.getAgent('nonexistent');
      expect(result).toBeNull();
    });

    test('should update last seen timestamp', async () => {
      const agent: AgentIdentity = {
        id: 'agent-2',
        name: 'Agent Two',
        publicKey: 'pk-2',
        createdAt: new Date(),
      };

      await storage.saveAgent(agent);
      await expect(storage.updateAgentLastSeen('agent-2')).resolves.not.toThrow();
    });

    test('should list all agents', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.saveAgent({
          id: `agent-${i}`,
          name: `Agent ${i}`,
          publicKey: `pk-${i}`,
          createdAt: new Date(),
        });
      }

      const agents = await storage.getAllAgents();
      expect(agents).toHaveLength(5);
    });
  });

  describe('Note Operations', () => {
    test('should save and retrieve notes by path', async () => {
      const note: ObsidianNote = {
        id: 'note-1',
        path: 'folder/test.md',
        content: '# Test\n\nContent here.',
        lastModified: new Date(),
        hash: 'abc123',
      };

      await storage.saveNote(note);
      const retrieved = await storage.getNoteByPath('folder/test.md');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('note-1');
      expect(retrieved!.content).toBe('# Test\n\nContent here.');
      expect(retrieved!.hash).toBe('abc123');
    });

    test('should return null for missing notes', async () => {
      const result = await storage.getNoteByPath('nonexistent.md');
      expect(result).toBeNull();
    });

    test('should retrieve notes modified since a date', async () => {
      const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentDate = new Date();

      await storage.saveNote({
        id: 'old-note',
        path: 'old.md',
        content: 'Old',
        lastModified: oldDate,
        hash: 'old-hash',
      });

      await storage.saveNote({
        id: 'recent-note',
        path: 'recent.md',
        content: 'Recent',
        lastModified: recentDate,
        hash: 'recent-hash',
      });

      const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const modified = await storage.getModifiedNotes(since);

      expect(modified).toHaveLength(1);
      expect(modified[0].id).toBe('recent-note');
    });

    test('should mark notes as synced without error', async () => {
      await storage.saveNote({
        id: 'note-2',
        path: 'test2.md',
        content: 'Content',
        lastModified: new Date(),
        hash: 'hash-2',
      });

      await expect(
        storage.markNoteAsSynced('note-2', 'agent-1')
      ).resolves.not.toThrow();
    });
  });

  describe('Delivery receipts', () => {
    const outbound = (id: string): Message => ({
      id,
      sender: 'me',
      recipient: 'peer',
      type: MessageType.TEXT,
      content: { text: 'hi' },
      timestamp: new Date(),
      encrypted: true,
    });

    test('a new message has no receipt until the recipient ACKs it', async () => {
      await storage.saveMessage(outbound('r-1'));
      expect((await storage.getMessage('r-1'))!.ackStatus).toBeUndefined();
      expect(await storage.recordAck('r-1', 'peer', 'queued')).toBe(true);
      const m = await storage.getMessage('r-1');
      expect(m!.ackStatus).toBe('queued');
      expect(m!.ackedAt).toBeInstanceOf(Date);
    });

    test('only the message recipient can ACK it', async () => {
      await storage.saveMessage(outbound('r-2'));
      expect(await storage.recordAck('r-2', 'someone-else', 'processed')).toBe(false);
      expect((await storage.getMessage('r-2'))!.ackStatus).toBeUndefined();
    });

    test('a late weaker receipt never masks a stronger one', async () => {
      await storage.saveMessage(outbound('r-3'));
      await storage.recordAck('r-3', 'peer', 'rejected');
      expect(await storage.recordAck('r-3', 'peer', 'queued')).toBe(false);
      expect(await storage.recordAck('r-3', 'peer', 'processed')).toBe(false);
      expect((await storage.getMessage('r-3'))!.ackStatus).toBe('rejected');

      await storage.saveMessage(outbound('r-4'));
      await storage.recordAck('r-4', 'peer', 'queued');
      expect(await storage.recordAck('r-4', 'peer', 'processed')).toBe(true);
      expect((await storage.getMessage('r-4'))!.ackStatus).toBe('processed');
    });

    test('a plaintext send (recipient key never pinned) cannot carry a receipt', async () => {
      await storage.saveMessage({ ...outbound('r-8'), encrypted: false });
      expect(await storage.recordAck('r-8', 'peer', 'processed')).toBe(false);
      expect((await storage.getMessage('r-8'))!.ackStatus).toBeUndefined();
    });

    test('an unknown status from the wire is ignored', async () => {
      await storage.saveMessage(outbound('r-5'));
      expect(await storage.recordAck('r-5', 'peer', 'bogus' as any)).toBe(false);
      expect((await storage.getMessage('r-5'))!.ackStatus).toBeUndefined();
    });

    test('a re-publish clears a sticky failure so the new attempt can go green', async () => {
      await storage.saveMessage(outbound('r-6'));
      await storage.recordAck('r-6', 'peer', 'rejected');
      await storage.resetAck('r-6');
      expect(await storage.recordAck('r-6', 'peer', 'queued')).toBe(true);
      expect((await storage.getMessage('r-6'))!.ackStatus).toBe('queued');
    });

    test('markDelivered stamps published_at', async () => {
      await storage.saveMessage(outbound('r-7'));
      expect((await storage.getMessage('r-7'))!.publishedAt).toBeUndefined();
      await storage.markDelivered('r-7');
      expect((await storage.getMessage('r-7'))!.publishedAt).toBeInstanceOf(Date);
    });
  });

  describe('Robustness', () => {
    test('should ignore duplicate message ids (network redelivery)', async () => {
      const msg: Message = {
        id: 'dup-1',
        sender: 'a',
        recipient: 'b',
        type: MessageType.TEXT,
        content: { text: 'once' },
        timestamp: new Date(),
        encrypted: false,
      };
      await storage.saveMessage(msg);
      await expect(storage.saveMessage(msg)).resolves.not.toThrow();
      const all = await storage.getMessages(10, 0);
      expect(all.filter((m) => m.id === 'dup-1')).toHaveLength(1);
    });

    test('should accept a non-Date (deserialized) timestamp', async () => {
      const msg: any = {
        id: 'str-ts',
        sender: 'a',
        recipient: 'b',
        type: MessageType.TEXT,
        content: { text: 'hi' },
        timestamp: new Date().toISOString(), // string, as it arrives over the wire
        encrypted: false,
      };
      await expect(storage.saveMessage(msg)).resolves.not.toThrow();
      const all = await storage.getMessages(10, 0);
      expect(all[0].timestamp).toBeInstanceOf(Date);
    });

    test('should persist signing and encryption keys for agents', async () => {
      await storage.saveAgent({
        id: 'keyed',
        name: 'Keyed',
        publicKey: 'sign-pub',
        encPublicKey: 'enc-pub',
        keyId: 'fp-123',
        createdAt: new Date(),
      });
      const a = await storage.getAgent('keyed');
      expect(a!.encPublicKey).toBe('enc-pub');
      expect(a!.keyId).toBe('fp-123');
    });

    test('should return the NEWEST conversation messages, oldest first', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.saveMessage({
          id: `c-${i}`,
          sender: i % 2 ? 'me' : 'peer',
          recipient: i % 2 ? 'peer' : 'me',
          type: MessageType.TEXT,
          content: { text: `m${i}` },
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)),
          encrypted: false,
        });
      }
      const convo = await storage.getConversation('peer', 'me', 3);
      expect(convo.map((m) => m.id)).toEqual(['c-2', 'c-3', 'c-4']);
    });

    test('should read a plain-text outbox row as a text payload instead of throwing', async () => {
      // External adapters write outbox rows directly; one that skipped
      // JSON-encoding used to make every outbox read throw and stall the queue.
      await (storage as any).db.run(
        `INSERT INTO messages (id, sender, recipient, type, content, timestamp, encrypted, delivered, auto)
         VALUES ('plain-1', 'me', 'peer', 'text', 'not json', ?, 1, 0, 0)`,
        [new Date().toISOString()]
      );
      await storage.saveMessage({
        id: 'json-1',
        sender: 'me',
        recipient: 'peer',
        type: MessageType.TEXT,
        content: { text: 'queued behind it' },
        timestamp: new Date(Date.now() + 1000),
        encrypted: false,
      });
      const pending = await storage.getPendingOutgoing('me');
      expect(pending.map((m) => m.content.text)).toEqual(['not json', 'queued behind it']);
    });
  });

  describe('Sync State', () => {
    test('should update and retrieve sync state', async () => {
      await storage.updateSyncState('agent-1', 5, 2);
      const state = await storage.getSyncState('agent-1');

      expect(state).not.toBeNull();
      expect(state!.agentId).toBe('agent-1');
      expect(state!.notesSynced).toBe(5);
      expect(state!.conflicts).toBe(2);
    });

    test('should increment sync state on subsequent updates', async () => {
      await storage.updateSyncState('agent-2', 3, 1);
      await storage.updateSyncState('agent-2', 2, 0);

      const state = await storage.getSyncState('agent-2');
      expect(state!.notesSynced).toBe(5);
      expect(state!.conflicts).toBe(1);
    });

    test('should return null for missing sync state', async () => {
      const state = await storage.getSyncState('nonexistent');
      expect(state).toBeNull();
    });
  });
});
