/**
 * Additive note merging — the heart of "vaults enrich each other, never shrink".
 *
 * Sync must never destroy content: a remote update is combined with the local
 * note so the result contains everything both agents know. The merge is
 * idempotent and monotonic — re-applying a merge (or merging the merged result
 * back on the other side) adds nothing new, so update loops settle instead of
 * ping-ponging.
 *
 * Strategy:
 *  1. Identical content → keep local (no write, no watcher event).
 *  2. One side strictly contains the other → take the superset (a pure
 *     expansion, e.g. a note someone appended to).
 *  3. Divergent content → keep the local text in place and append the remote
 *     blocks (blank-line-separated paragraphs) that the local note is missing.
 */

/** Split markdown into blank-line-separated blocks, preserving block text. */
function splitBlocks(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** Canonical key for "is this block already present" comparisons. */
function blockKey(block: string): string {
  return block.replace(/\s+/g, ' ').trim();
}

export interface MergeResult {
  /** The merged content. Equal to `local` when nothing new arrived. */
  content: string;
  /** True when the merge produced content different from `local` (a write is needed). */
  changed: boolean;
  /** Number of remote blocks appended (0 for superset/identical cases). */
  addedBlocks: number;
}

/**
 * Merge `remote` note content into `local` additively.
 * Never returns content that lost a local block.
 */
export function mergeNoteContent(local: string, remote: string): MergeResult {
  const normLocal = local.replace(/\r\n/g, '\n');
  const normRemote = remote.replace(/\r\n/g, '\n');

  // Trivial cases: one side empty or identical.
  if (normLocal.trim() === normRemote.trim() || normRemote.trim() === '') {
    return { content: local, changed: false, addedBlocks: 0 };
  }
  if (normLocal.trim() === '') {
    return { content: remote, changed: true, addedBlocks: splitBlocks(normRemote).length };
  }

  // Pure expansion in either direction → take the superset wholesale, which
  // preserves in-place edits (insertions in the middle of a note), not just
  // appends at the end.
  if (normRemote.includes(normLocal.trim())) {
    return { content: remote, changed: true, addedBlocks: 0 };
  }
  if (normLocal.includes(normRemote.trim())) {
    return { content: local, changed: false, addedBlocks: 0 };
  }

  // Divergent: block-level union. Local stays as-is; remote-only blocks are
  // appended in their original order.
  const localKeys = new Set(splitBlocks(normLocal).map(blockKey));
  const additions = splitBlocks(normRemote).filter((b) => !localKeys.has(blockKey(b)));

  if (additions.length === 0) {
    return { content: local, changed: false, addedBlocks: 0 };
  }

  const merged = normLocal.replace(/\s+$/, '') + '\n\n' + additions.join('\n\n') + '\n';
  return { content: merged, changed: true, addedBlocks: additions.length };
}

/**
 * Blocks present in `a` but missing from `b` (whitespace-normalized).
 * Use this — not raw string inequality — to decide whether `a` can enrich `b`:
 * two notes with the same blocks in different order must count as equal, or
 * reciprocal-enrichment replies would bounce between agents forever.
 */
export function blocksMissingFrom(a: string, b: string): string[] {
  const bKeys = new Set(splitBlocks(b.replace(/\r\n/g, '\n')).map(blockKey));
  return splitBlocks(a.replace(/\r\n/g, '\n')).filter((block) => !bKeys.has(blockKey(block)));
}
