import * as fs from 'fs';
import * as path from 'path';

/** A note path that must never be read, written or deleted. */
export class UnsafeVaultPathError extends Error {
  constructor(notePath: unknown, reason: string) {
    super(`Refusing unsafe vault path ${JSON.stringify(notePath)}: ${reason}`);
    this.name = 'UnsafeVaultPathError';
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve a vault-relative note path to an absolute path that is guaranteed to
 * stay inside the vault. Note paths arrive from peers (sync messages), so they
 * are hostile input: a path like `../../etc/cron.d/x` must never escape the
 * vault, and paths inside it must not reach files that something will execute.
 *
 * Rules:
 *  - a non-empty relative string, no NUL bytes, no absolute or drive paths;
 *  - no `..` segment and no hidden segment (`.git/hooks/…`, `.obsidian/plugins/…`
 *    are code-execution paths even though they are inside the vault);
 *  - a `.md` file (sync only ever carries markdown notes);
 *  - the deepest existing ancestor must resolve (through symlinks) inside the
 *    vault, so a symlinked directory cannot be used to escape.
 */
export function resolveVaultPath(vaultPath: string, notePath: unknown): string {
  if (typeof notePath !== 'string' || notePath.length === 0) {
    throw new UnsafeVaultPathError(notePath, 'not a non-empty string');
  }
  if (notePath.includes('\0')) {
    throw new UnsafeVaultPathError(notePath, 'contains a NUL byte');
  }
  if (path.isAbsolute(notePath) || path.win32.isAbsolute(notePath) || /^[a-zA-Z]:/.test(notePath)) {
    throw new UnsafeVaultPathError(notePath, 'absolute path');
  }
  const segments = notePath.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) {
    throw new UnsafeVaultPathError(notePath, 'contains a ".." segment');
  }
  if (segments.some((s) => s.startsWith('.'))) {
    throw new UnsafeVaultPathError(notePath, 'contains a hidden segment');
  }
  if (!notePath.toLowerCase().endsWith('.md')) {
    throw new UnsafeVaultPathError(notePath, 'not a .md note');
  }

  const root = fs.existsSync(vaultPath) ? fs.realpathSync(vaultPath) : path.resolve(vaultPath);
  const full = path.resolve(root, ...segments);
  if (!isInside(root, full)) {
    throw new UnsafeVaultPathError(notePath, 'resolves outside the vault');
  }

  let probe = full;
  while (probe !== root && !fs.existsSync(probe)) {
    probe = path.dirname(probe);
  }
  if (probe !== root && !isInside(root, fs.realpathSync(probe))) {
    throw new UnsafeVaultPathError(notePath, 'resolves outside the vault through a symlink');
  }
  return full;
}

/** True when `notePath` passes {@link resolveVaultPath}. */
export function isSafeVaultPath(vaultPath: string, notePath: unknown): boolean {
  try {
    resolveVaultPath(vaultPath, notePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a note inside the vault. The final component is opened with
 * O_NOFOLLOW where the platform supports it, so a symlink planted at the
 * target between the check and the write is not followed.
 */
export function writeVaultFile(vaultPath: string, notePath: unknown, content: string): string {
  const full = resolveVaultPath(vaultPath, notePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(full, flags, 0o644);
  try {
    fs.writeFileSync(fd, content, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
  return full;
}
