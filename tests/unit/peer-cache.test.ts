import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPeerCache, savePeerCache, mergeByPeerId } from '../../src/core/waku-transport';

const WS = '/ip4/1.2.3.4/tcp/443/wss/p2p/16Uiu2HAmExample';
const WS2 = '/ip4/5.6.7.8/tcp/8000/ws/p2p/16Uiu2HAmOther';

describe('peer cache', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-peercache-'));
    file = path.join(dir, 'known-peers.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips proven peers', () => {
    savePeerCache(file, [WS, WS2], 20);
    expect(loadPeerCache(file)).toEqual([WS, WS2]);
  });

  test('dedupes and caps to max, most-recent first', () => {
    savePeerCache(file, [WS, WS, WS2], 1);
    expect(loadPeerCache(file)).toEqual([WS]);
  });

  test('load ignores non-dialable / id-less addrs', () => {
    fs.writeFileSync(
      file,
      JSON.stringify([WS, '/ip4/9.9.9.9/tcp/30303', 'not-a-multiaddr', '/ip4/1.1.1.1/tcp/443/wss']),
      'utf-8'
    );
    // Only the ws/wss addr carrying a /p2p/ id survives.
    expect(loadPeerCache(file)).toEqual([WS]);
  });

  test('missing file and empty inputs are safe no-ops', () => {
    expect(loadPeerCache(path.join(dir, 'nope.json'))).toEqual([]);
    expect(loadPeerCache(undefined)).toEqual([]);
    savePeerCache(undefined, [WS], 20); // no path → no throw, no write
    savePeerCache(file, [], 20); // empty → no file written
    expect(fs.existsSync(file)).toBe(false);
  });

  test('corrupt JSON loads as empty', () => {
    fs.writeFileSync(file, '{ not json', 'utf-8');
    expect(loadPeerCache(file)).toEqual([]);
  });
});

describe('mergeByPeerId', () => {
  const A = '/ip4/1.1.1.1/tcp/443/wss/p2p/16Uiu2HAmAAA';
  const A2 = '/ip4/9.9.9.9/tcp/8000/ws/p2p/16Uiu2HAmAAA'; // same peerId as A, diff addr
  const B = '/ip4/2.2.2.2/tcp/443/wss/p2p/16Uiu2HAmBBB';

  test('keeps primary first and appends only new peerIds', () => {
    expect(mergeByPeerId([A], [B])).toEqual([A, B]);
  });

  test('drops an extra whose peerId already appears in primary', () => {
    // A2 is the same node as A via a different address → redundant.
    expect(mergeByPeerId([A], [A2, B])).toEqual([A, B]);
  });

  test('dedupes within the extra list too', () => {
    expect(mergeByPeerId([], [B, B])).toEqual([B]);
  });
});
