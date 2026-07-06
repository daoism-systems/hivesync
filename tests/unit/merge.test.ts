import { mergeNoteContent, blocksMissingFrom } from '../../src/sync/merge';

describe('mergeNoteContent (additive sync)', () => {
  test('identical content is unchanged', () => {
    const r = mergeNoteContent('# A\n\ntext\n', '# A\n\ntext\n');
    expect(r.changed).toBe(false);
    expect(r.content).toBe('# A\n\ntext\n');
  });

  test('empty local adopts remote', () => {
    const r = mergeNoteContent('', '# New note\n');
    expect(r.changed).toBe(true);
    expect(r.content).toBe('# New note\n');
  });

  test('empty remote never shrinks local (deletion cannot propagate)', () => {
    const r = mergeNoteContent('# Keep me\n', '');
    expect(r.changed).toBe(false);
    expect(r.content).toBe('# Keep me\n');
  });

  test('remote superset (append) is adopted wholesale', () => {
    const local = '# Note\n\nline one\n';
    const remote = '# Note\n\nline one\n\nline two added by peer\n';
    const r = mergeNoteContent(local, remote);
    expect(r.changed).toBe(true);
    expect(r.content).toBe(remote);
  });

  test('remote superset with mid-note insertion is adopted wholesale', () => {
    const local = '# Title\nintro\noutro\n';
    const remote = '# Title\nintro\noutro\n\nnew section\n';
    const r = mergeNoteContent(local, remote);
    expect(r.content).toBe(remote);
  });

  test('local superset keeps local, no change', () => {
    const local = '# Note\n\nline one\n\nline two\n';
    const remote = '# Note\n\nline one\n';
    const r = mergeNoteContent(local, remote);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(local);
  });

  test('divergent notes union: local kept, remote-only blocks appended', () => {
    const local = '# Note\n\nalpha from A\n';
    const remote = '# Note\n\nbeta from B\n';
    const r = mergeNoteContent(local, remote);
    expect(r.changed).toBe(true);
    expect(r.content).toContain('alpha from A');
    expect(r.content).toContain('beta from B');
    // local text stays in place, remote addition appended
    expect(r.content.indexOf('alpha from A')).toBeLessThan(r.content.indexOf('beta from B'));
    expect(r.addedBlocks).toBe(1);
  });

  test('merge is idempotent', () => {
    const local = 'A block\n\nshared\n';
    const remote = 'B block\n\nshared\n';
    const once = mergeNoteContent(local, remote);
    const twice = mergeNoteContent(once.content, remote);
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
  });

  test('two-agent exchange converges (no ping-pong)', () => {
    const a0 = '# Note\n\nfact from A\n';
    const b0 = '# Note\n\nfact from B\n';

    // B receives A's note and merges
    const b1 = mergeNoteContent(b0, a0);
    expect(b1.changed).toBe(true);
    // B replies because it holds blocks A lacks
    expect(blocksMissingFrom(b1.content, a0).length).toBeGreaterThan(0);

    // A receives B's merged note
    const a1 = mergeNoteContent(a0, b1.content);
    expect(a1.changed).toBe(true);
    // A now holds nothing B lacks → no further reply, loop terminates
    expect(blocksMissingFrom(a1.content, b1.content).length).toBe(0);

    // And a further round trip changes nothing on either side
    const b2 = mergeNoteContent(b1.content, a1.content);
    expect(b2.changed).toBe(false);
    expect(blocksMissingFrom(b2.content, a1.content).length).toBe(0);
  });

  test('order-only differences do not count as enrichment', () => {
    const a = 'one\n\ntwo\n';
    const b = 'two\n\none\n';
    expect(blocksMissingFrom(a, b).length).toBe(0);
    expect(blocksMissingFrom(b, a).length).toBe(0);
  });

  test('CRLF vs LF does not duplicate blocks', () => {
    const local = '# Note\r\n\r\nsame text\r\n';
    const remote = '# Note\n\nsame text\n';
    const r = mergeNoteContent(local, remote);
    expect(r.changed).toBe(false);
  });
});
