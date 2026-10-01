/**
 * Proves the relay-hub topology with NO public Logos Messaging fleet: one hub transport
 * that listens, two spokes that dial the hub. A payload published by spoke A
 * must reach spoke B (relayed by the hub), and vice-versa — i.e. real
 * bidirectional delivery through a single reachable node.
 *
 * This is the model for production: the hub is everhomie's VPS listening on an
 * open port (e.g. 443); claw and vibecoder dial it. Here everything runs on
 * 127.0.0.1 so it's a faithful, offline test of the exact code path.
 *
 *   node -r ts-node/register/transpile-only scripts/demo-relay-mesh.ts
 */
import { WakuTransport } from '../src/core/waku-transport';
import type { WakuConfig } from '../src';

const contentTopic = '/hivesync/1/agents/proto';
const base = (over: Partial<WakuConfig>): WakuConfig => ({
  mode: 'relay',
  listenAddresses: [],
  bootstrapNodes: [],
  directPeers: [],
  clusterId: 1,
  numShardsInCluster: 8,
  contentTopic,
  keepAlive: true,
  maxPeers: 10,
  ...over,
});

const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 1. Hub listens on an ephemeral localhost ws port.
  const hub = new WakuTransport(base({ listenAddresses: ['/ip4/127.0.0.1/tcp/0/ws'] }));
  await hub.start(5000);
  const hubAddr = hub.getDialableMultiaddrs().find((a) => a.includes('/ws') && a.includes('/p2p/'));
  if (!hubAddr) throw new Error('hub produced no dialable /ws multiaddr');
  console.log(`hub dialable at: ${hubAddr}`);

  // 2. Spokes dial the hub.
  const spokeA = new WakuTransport(base({ directPeers: [hubAddr] }));
  const spokeB = new WakuTransport(base({ directPeers: [hubAddr] }));
  await Promise.all([spokeA.start(8000), spokeB.start(8000)]);

  // 3. Everyone subscribes (the hub must be subscribed to relay the topic).
  const gotA: string[] = [];
  const gotB: string[] = [];
  await hub.subscribe(() => undefined);
  await spokeA.subscribe((p) => gotA.push(dec(p)));
  await spokeB.subscribe((p) => gotB.push(dec(p)));

  // 4. Let the gossipsub mesh form across hub + spokes.
  await sleep(4000);
  console.log(`peers — hub:${await hub.getPeerCount()} A:${await spokeA.getPeerCount()} B:${await spokeB.getPeerCount()}`);

  // 5. Bidirectional delivery through the hub, with a few resends for mesh warmup.
  const msgAB = 'hello-from-A';
  const msgBA = 'hello-from-B';
  let okAB = false;
  let okBA = false;
  for (let i = 0; i < 10 && !(okAB && okBA); i++) {
    if (!okAB) await spokeA.publish(enc(msgAB));
    if (!okBA) await spokeB.publish(enc(msgBA));
    await sleep(1000);
    okAB = gotB.includes(msgAB); // A's message arrived at B
    okBA = gotA.includes(msgBA); // B's message arrived at A
  }

  console.log(`\n=== RESULT ===`);
  console.log(`A -> hub -> B delivered: ${okAB}`);
  console.log(`B -> hub -> A delivered: ${okBA}`);
  const pass = okAB && okBA;
  console.log(`BIDIRECTIONAL VIA HUB: ${pass}`);

  await Promise.all([spokeA.stop(), spokeB.stop(), hub.stop()]);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('relay-mesh test error:', e);
  process.exit(2);
});
