import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveVaultPath, isSafeVaultPath, writeVaultFile, UnsafeVaultPathError } from '../../src/sync/vault-path';
import { FileWatcher } from '../../src/sync/file-watcher';

/**
 * Note paths arrive from peers, so every vault read/write/delete must stay
 * inside the vault and only touch markdown notes.
 */
describe('vault path containment', () => {
  let root: string;
  let vault: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-vault-')));
    vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('accepts ordinary notes, including nested ones', () => {
    expect(resolveVaultPath(vault, 'note.md')).toBe(path.join(vault, 'note.md'));
    expect(resolveVaultPath(vault, 'Topics/Sub dir/Note — x.md')).toBe(path.join(vault, 'Topics', 'Sub dir', 'Note — x.md'));
  });

  test.each([
    ['../escape.md'],
    ['../../../../etc/cron.d/x.md'],
    ['Topics/../../escape.md'],
    ['Topics\\..\\..\\escape.md'],
    ['/etc/passwd.md'],
    ['C:\\Windows\\x.md'],
    ['.git/hooks/pre-commit.md'],
    ['.obsidian/plugins/evil/main.md'],
    ['Topics/.hidden/x.md'],
    ['etc/cron.d/x'],
    ['note.md\0.sh'],
    [''],
    [undefined],
    [42],
  ])('rejects %p', (p) => {
    expect(() => resolveVaultPath(vault, p)).toThrow(UnsafeVaultPathError);
    expect(isSafeVaultPath(vault, p)).toBe(false);
  });

  test('rejects a path that escapes through a symlinked directory', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(vault, 'link'), 'dir');
    expect(() => resolveVaultPath(vault, 'link/x.md')).toThrow(/symlink/);
  });

  test('writeVaultFile does not follow a symlink planted at the target', () => {
    if (fs.constants.O_NOFOLLOW === undefined) return; // not available on this platform
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, 'original');
    fs.symlinkSync(outside, path.join(vault, 'trap.md'));
    expect(() => writeVaultFile(vault, 'trap.md', 'overwritten')).toThrow();
    expect(fs.readFileSync(outside, 'utf-8')).toBe('original');
  });

  test('FileWatcher save/delete refuse traversal and leave outside files alone', async () => {
    const victim = path.join(root, 'victim.md');
    fs.writeFileSync(victim, 'keep me');
    const watcher = new FileWatcher(vault, async () => undefined);

    await expect(watcher.saveNoteContent('../victim.md', 'pwned')).rejects.toThrow(UnsafeVaultPathError);
    await expect(watcher.deleteNote('../victim.md')).rejects.toThrow(UnsafeVaultPathError);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep me');

    await watcher.saveNoteContent('Topics/ok.md', 'hello');
    expect(fs.readFileSync(path.join(vault, 'Topics', 'ok.md'), 'utf-8')).toBe('hello');
  });
});
