#!/usr/bin/env node
/**
 * HiveSync Waku E2E Test
 *
 * Creates TWO independent Waku relay nodes on localhost,
 * has them communicate bidirectionally via the Relay protocol.
 *
 * Both nodes connect to our daemon (port 16000) as a direct peer,
 * ensuring they share the same gossipsub mesh. Then they send
 * messages to each other via relay.
 */

const RELAY_PORT = 16000;
const RELAY_PEER_ID = '12D3KooWFF9yuHk9egcSxb7tCAiheu5jqsjtpp4Dw29dac3KmYbK';
const RELAY_ADDR = `/ip4/127.0.0.1/tcp/${RELAY_PORT}/ws/p2p/${RELAY_PEER_ID}`;
const CLUSTER_ID = 1;
const NUM_SHARDS = 8;
const CONTENT_TOPIC = '/hivesync/1/agents/proto';

let passed = 0;
let failed = 0;

function log(prefix, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${prefix.padEnd(8)} ${msg}`);
}

function pass(msg) { log('PASS', msg); passed++; }
function fail(msg) { log('FAIL', msg); failed++; }

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Create a hybrid Waku relay+filter node manually.
 * Both nodes MUST have filterMultiaddrs: false so they can
 * dial plain WebSocket addresses (not just WSS).
 */
async function createHybridNode(port, contentTopic) {
  const sdk = await new Function('return import("@waku/sdk")')();
  const relayMod = await new Function('return import("@waku/relay")')();
  const utils = await new Function('return import("@waku/utils")')();

  const { createLibp2pAndUpdateOptions, WakuNode } = sdk;
  const { Relay, wakuGossipSub } = relayMod;
  const { createRoutingInfo } = utils;

  const routingInfo = createRoutingInfo(
    { clusterId: CLUSTER_ID, numShardsInCluster: NUM_SHARDS },
    { contentTopic }
  );

  const opts = {
    defaultBootstrap: true,
    networkConfig: { clusterId: CLUSTER_ID, numShardsInCluster: NUM_SHARDS },
    routingInfos: [routingInfo],
    libp2p: {
      addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}/ws`] },
      filterMultiaddrs: false,
      services: {
        pubsub: wakuGossipSub({ defaultBootstrap: true }),
      },
    },
  };

  log('NODE', `Creating hybrid node on port ${port}...`);
  const libp2p = await createLibp2pAndUpdateOptions(opts);
  const pubsubTopics = [routingInfo.pubsubTopic];
  const relay = new Relay({ pubsubTopics, libp2p });
  const node = new WakuNode(opts, libp2p, { filter: true }, relay);
  await node.start();
  log('NODE', `Node started: ${node.peerId.toString()}`);

  const encoder = node.createEncoder({ contentTopic });
  const decoder = node.createDecoder({ contentTopic });

  return { node, encoder, decoder, relay };
}

/**
 * Wait until the node has at least minPeers mesh peers on the pubsub topic.
 */
async function waitForMesh(node, pubsubTopic, minPeers, timeoutMs) {
  const gs = node.libp2p.services.pubsub;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mesh = gs?.getMeshPeers?.(pubsubTopic)?.length ?? 0;
    if (mesh >= minPeers) return mesh;
    await sleep(1000);
  }
  return gs?.getMeshPeers?.(pubsubTopic)?.length ?? 0;
}

async function main() {
  console.log('═'.repeat(60));
  console.log('  HiveSync Waku E2E Test');
  console.log(`  Relay: ${RELAY_ADDR}`);
  console.log(`  Content Topic: ${CONTENT_TOPIC}`);
  console.log('═'.repeat(60));

  const maMod = await new Function('return import("@multiformats/multiaddr")')();
  let nodeA, nodeB;

  try {
    // Create both nodes
    log('TEST', 'Creating Node A (port 16001)...');
    nodeA = await createHybridNode(16001, CONTENT_TOPIC);
    log('TEST', `Node A peerId: ${nodeA.node.peerId.toString()}`);

    log('TEST', 'Creating Node B (port 16002)...');
    nodeB = await createHybridNode(16002, CONTENT_TOPIC);
    log('TEST', `Node B peerId: ${nodeB.node.peerId.toString()}`);

    // Dial our relay daemon directly — this guarantees mesh overlap
    const relayMa = maMod.multiaddr(RELAY_ADDR);
    log('DIAL', `Node A → relay daemon...`);
    try {
      await nodeA.node.libp2p.dial(relayMa);
      log('DIAL', 'Node A connected to relay daemon');
    } catch (e) {
      log('DIAL', `Node A dial failed: ${e.message.substring(0, 80)}`);
    }
    log('DIAL', `Node B → relay daemon...`);
    try {
      await nodeB.node.libp2p.dial(relayMa);
      log('DIAL', 'Node B connected to relay daemon');
    } catch (e) {
      log('DIAL', `Node B dial failed: ${e.message.substring(0, 80)}`);
    }

    // Give mesh time to form + verify
    log('MESH', 'Waiting 12s for mesh formation...');
    const meshA = await waitForMesh(nodeA.node, RELAY_ADDR, 1, 12000);
    log('MESH', `Node A mesh peers: ${meshA}`);
    const meshB = await waitForMesh(nodeB.node, RELAY_ADDR, 1, 12000);
    log('MESH', `Node B mesh peers: ${meshB}`);

    // Log all connections
    for (const conn of nodeA.node.libp2p.getConnections()) {
      log('CONN', `Node A connected to: ${conn.remotePeer.toString()}`);
    }
    for (const conn of nodeB.node.libp2p.getConnections()) {
      log('CONN', `Node B connected to: ${conn.remotePeer.toString()}`);
    }

    // ── Test 1: Node B sends → Node A receives ──
    log('TEST', '─── Test 1: B sends → A receives ───');
    let msgReceivedA = false;
    let msgPayloadA = '';

    nodeA.node.relay.subscribeWithUnsubscribe([nodeA.decoder], (msg) => {
      const text = new TextDecoder().decode(msg.payload);
      log('RECV', `Node A received: "${text}"`);
      msgReceivedA = true;
      msgPayloadA = text;
    });

    const testMsg1 = 'Hello from B! ' + Date.now();
    log('SEND', `Node B sending: "${testMsg1}"...`);
    try {
      await nodeB.node.relay.send(nodeB.encoder, { payload: new TextEncoder().encode(testMsg1) });
      log('SEND', 'Node B send completed');
    } catch (e) {
      log('SEND', `Node B send error: ${e.message.substring(0, 80)}`);
    }

    // Wait up to 18s for delivery
    const deadline1 = Date.now() + 18000;
    while (!msgReceivedA && Date.now() < deadline1) {
      await sleep(500);
    }

    if (msgReceivedA && msgPayloadA === testMsg1) {
      pass('Test 1: B → A bidirectional send/receive');
    } else if (msgReceivedA) {
      fail(`Test 1: Payload mismatch. Got: "${msgPayloadA}", expected: "${testMsg1}"`);
    } else {
      fail('Test 1: Node A did not receive message within 18s');
    }

    // ── Test 2: Node A sends → Node B receives ──
    log('TEST', '─── Test 2: A sends → B receives ───');
    let msgReceivedB = false;
    let msgPayloadB = '';

    nodeB.node.relay.subscribeWithUnsubscribe([nodeB.decoder], (msg) => {
      const text = new TextDecoder().decode(msg.payload);
      log('RECV', `Node B received: "${text}"`);
      msgReceivedB = true;
      msgPayloadB = text;
    });

    const testMsg2 = 'Hello from A! ' + Date.now();
    log('SEND', `Node A sending: "${testMsg2}"...`);
    try {
      await nodeA.node.relay.send(nodeA.encoder, { payload: new TextEncoder().encode(testMsg2) });
      log('SEND', 'Node A send completed');
    } catch (e) {
      log('SEND', `Node A send error: ${e.message.substring(0, 80)}`);
    }

    const deadline2 = Date.now() + 18000;
    while (!msgReceivedB && Date.now() < deadline2) {
      await sleep(500);
    }

    if (msgReceivedB && msgPayloadB === testMsg2) {
      pass('Test 2: A → B bidirectional send/receive');
    } else if (msgReceivedB) {
      fail(`Test 2: Payload mismatch. Got: "${msgPayloadB}", expected: "${testMsg2}"`);
    } else {
      fail('Test 2: Node B did not receive message within 18s');
    }

  } finally {
    // Cleanup
    if (nodeA) await nodeA.node.stop();
    if (nodeB) await nodeB.node.stop();
  }

  // Summary
  console.log('─'.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  STATUS: ALL PASSED ✅');
  } else {
    console.log('  STATUS: SOME FAILED ❌');
  }
  console.log('═'.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});