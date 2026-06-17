import * as fs from 'fs';
import * as path from 'path';
import { Message, QuarantinedMessage } from '../types';

/**
 * Isolated holding area for untrusted messages (no/invalid password).
 *
 * Messages are written as inert, read-only JSON files in a dedicated folder.
 * They are deliberately NOT stored in the main database and never parsed back
 * into the agent's execution path — so prompt-injection content can be
 * inspected by hand but can't act on the agent. `list()` exists only for a
 * read-only viewer.
 */
export class QuarantineStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  getDir(): string {
    return this.dir;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Persist an untrusted message as a read-only JSON file. */
  async add(message: Message, reason: string): Promise<string> {
    this.ensureDir();
    const ts = new Date(message.timestamp).toISOString().replace(/[:.]/g, '-');
    const file = path.join(this.dir, `${ts}_${sanitize(message.sender)}_${message.id.slice(0, 8)}.json`);

    const record: QuarantinedMessage = {
      id: message.id,
      sender: message.sender,
      recipient: message.recipient,
      type: message.type,
      content: message.content,
      timestamp: new Date(message.timestamp).toISOString(),
      encrypted: message.encrypted,
      reason,
      quarantinedAt: new Date().toISOString(),
    };

    // 0444: read-only on disk, a small nudge that these are not to be acted on.
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o444 });
    return file;
  }

  /** Read quarantined messages for display (newest first). Safe: parse only. */
  async list(limit = 500): Promise<QuarantinedMessage[]> {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);

    const out: QuarantinedMessage[] = [];
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')) as QuarantinedMessage;
        rec.file = f;
        out.push(rec);
      } catch {
        // Skip unreadable/corrupt entries rather than fail the whole listing.
      }
    }
    return out;
  }

  async count(): Promise<number> {
    if (!fs.existsSync(this.dir)) return 0;
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).length;
  }
}

function sanitize(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40) || 'unknown';
}
