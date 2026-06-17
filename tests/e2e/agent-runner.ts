/**
 * A standalone HiveSync agent process used by the e2e test. It connects to the
 * real Waku network, discovers a named peer, exchanges an encrypted message,
 * and reports progress as `HSE2E <json>` lines on stdout for the test to parse.
 *
 * argv: <agentId> <agentName> <contentTopic> <peerAgentId> <token>
 */
import { BridgeManager } from '../../src';
import type { BridgeConfig } from '../../src';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Keep the bridge's own logging quiet; we only emit structured HSE2E lines.
process.env.LOG_LEVEL = 'error';

const [, , agentId, agentName, contentTopic, peerAgentId, token] = process.argv;

function emit(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`HSE2E ${JSON.stringify({ event, agentId, ...data })}\n`);
}

const PEER_WAIT_MS = 60000;
const DISCOVERY_MS = 60000;
const EXCHANGE_MS = 90000;
const expectedFromPeer = `msg-from-${peerAgentId}-${token}`;
const myMessage = `msg-from-${agentId}-${token}`;

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hs-e2e-${agentId}-`));
  const config: BridgeConfig = {
    agentId,
    agentName,
    storagePath: path.join(tmp, 'agent.db'),
    syncInterval: 5, // announce every 5s for fast discovery
    waku: {
      listenAddresses: [],
      bootstrapNodes: [],
      clusterId: 1,
      numShardsInCluster: 8,
      contentTopic,
      keepAlive: true,
      maxPeers: 10,
    },
  };

  const bridge = new BridgeManager(config);
  const started = await bridge.start(PEER_WAIT_MS);
  emit('started', { ok: started });
  if (!started) {
    process.exit(1);
  }

  const discovered = await bridge.waitForAgent(peerAgentId, DISCOVERY_MS);
  emit('discovered', { peer: peerAgentId, ok: discovered });
  if (!discovered) {
    await bridge.stop();
    process.exit(2);
  }

  // Keep resending until we observe the peer's message — one delivery only needs
  // to survive the public fleet's intermittent LightPush rejections.
  let received = false;
  const deadline = Date.now() + EXCHANGE_MS;
  while (!received && Date.now() < deadline) {
    try {
      await bridge.sendTextMessage(peerAgentId, myMessage);
    } catch {
      /* transient push failure; retry below */
    }
    const msgs = await bridge.getUnreadMessages();
    const hit = msgs.find((m) => m.content?.text === expectedFromPeer);
    if (hit) {
      received = true;
      emit('received', { text: hit.content.text, from: hit.sender, encrypted: hit.encrypted });
    } else {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!received) {
    emit('timeout', {});
  }

  // Linger briefly so the peer can also receive one of our sends.
  await new Promise((r) => setTimeout(r, 8000));
  await bridge.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  emit('done', { received });
  process.exit(received ? 0 : 3);
}

main().catch((err) => {
  emit('error', { message: (err as Error).message });
  process.exit(4);
});
