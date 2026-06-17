import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QuarantineStore } from '../../src/storage/quarantine-store';
import { Message, MessageType } from '../../src/types';

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'q-1',
    sender: 'agent-x',
    recipient: 'me',
    type: MessageType.TEXT,
    content: { text: 'suspicious payload' },
    timestamp: new Date(),
    encrypted: true,
    ...over,
  };
}

describe('QuarantineStore', () => {
  let dir: string;
  let store: QuarantineStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-quar-'));
    store = new QuarantineStore(path.join(dir, 'quarantine'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes an inert read-only JSON file', async () => {
    const file = await store.add(msg(), 'no valid password');
    expect(fs.existsSync(file)).toBe(true);
    expect(file.endsWith('.json')).toBe(true);

    const mode = fs.statSync(file).mode & 0o777;
    expect(mode & 0o222).toBe(0); // not writable

    const rec = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(rec.sender).toBe('agent-x');
    expect(rec.reason).toBe('no valid password');
    expect(rec.content.text).toBe('suspicious payload');
    expect(rec.quarantinedAt).toBeDefined();
  });

  test('lists and counts quarantined messages', async () => {
    await store.add(msg({ id: 'a' }), 'r1');
    await store.add(msg({ id: 'b', sender: 'agent-y' }), 'r2');

    expect(await store.count()).toBe(2);
    const items = await store.list();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.sender).sort()).toEqual(['agent-x', 'agent-y']);
    expect(items[0].file).toBeDefined();
  });

  test('empty store lists nothing', async () => {
    expect(await store.count()).toBe(0);
    expect(await store.list()).toEqual([]);
  });
});
