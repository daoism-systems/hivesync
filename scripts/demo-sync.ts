/**
 * Multi-agent HiveSync demo over REAL Logos Messaging.
 *
 * Each invocation runs ONE agent. The agent:
 *   1. connects to the public Logos Messaging Network (light node),
 *   2. discovers its named peers and completes mutual handshakes,
 *   3. seeds its local SQLite DB with a few records,
 *   4. broadcasts each record to the peers and stores records it receives,
 *   5. reports the merged record set so a watcher can confirm DB convergence.
 *
 * Records ride inside normal HiveSync text messages as JSON:
 *   {"__rec": "<id>", "data": "<value>"}
 * so this exercises the exact send/receive path real agents use.
 *
 * Progress is emitted as `HSE2E <json>` lines on stdout (same convention as the
 * jest e2e) so an orchestrator or subagent can parse it.
 *
 * argv: <agentId> <agentName> <contentTopic> <peerCsv> <token>
 *   peerCsv: comma-separated peer agentIds (e.g. "bob,carol")
 */
import { BridgeManager } from '../src';
import type { BridgeConfig } from '../src';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const [, , agentId, agentName, contentTopic, peerCsv, token] = process.argv;
const peers = (peerCsv || '').split(',').map((s) => s.trim()).filter(Boolean);

function emit(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`HSE2E ${JSON.stringify({ event, agentId, ...data })}\n`);
}

const PEER_WAIT_MS = 60000;
const DISCOVERY_MS = 90000;
// Long broadcast/harvest window so agents stay overlapped even when their
// start times or fleet-connect times differ by a minute on the public testnet.
const SETTLE_MS = 120000;

// Each agent contributes 3 records to the shared "database".
const myRecords = [0, 1, 2].map((i) => ({ __rec: `${agentId}-rec${i}`, data: `${token}:${agentId}:${i}` }));
const expectedTotal = (peers.length + 1) * 3; // own + each peer's 3 records

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hs-demo-${agentId}-`));
  const config: BridgeConfig = {
    agentId,
    agentName,
    storagePath: path.join(tmp, 'agent.db'),
    syncInterval: 5,
    waku: {
      listenAddresses: [],
      bootstrapNodes: [],
      directPeers: [],
      clusterId: 1,
      numShardsInCluster: 8,
      contentTopic,
      keepAlive: true,
      maxPeers: 10,
    },
  };

  const bridge = new BridgeManager(config);
  const started = await bridge.start(PEER_WAIT_MS);
  emit('started', { ok: started, peers });
  if (!started) process.exit(1);

  // Discover every peer.
  for (const peer of peers) {
    const found = await bridge.waitForAgent(peer, DISCOVERY_MS);
    emit('discovered', { peer, ok: found });
  }

  // The merged DB view: record id -> data. Seed with our own records.
  const db = new Map<string, string>();
  for (const r of myRecords) db.set(r.__rec, r.data);

  // Batch ALL of our records into ONE directed message per peer. A single
  // successful LightPush then carries our entire record set — more robust than
  // N separate sends, each an independent chance to hit the public fleet's
  // intermittent RLN rejection.
  const batch = JSON.stringify({ __recs: myRecords });

  // HiveSync only TRUSTS (stores, rather than quarantines) messages from a peer
  // whose handshake is confirmed; un-handshaked peers are quarantined. The
  // handshake_init is itself a Logos Messaging message that may take several tries to
  // arrive, so we fold approval INTO the main loop and keep approving — and
  // keep resending — until the DB converges. This mirrors the working e2e.
  const approved = new Set<string>();
  const deadline = Date.now() + SETTLE_MS;
  let converged = false;
  while (!converged && Date.now() < deadline) {
    for (const peer of peers) {
      // Approve the peer's handshake the moment its init has arrived.
      if (!approved.has(peer) && (await bridge.approveHandshake(peer).catch(() => false))) {
        approved.add(peer);
        emit('handshakes', { approved: [...approved] });
      }
      // (Re)send our batch. Once the handshake is mutually confirmed this is
      // encrypted + trusted, so a resend lands in the peer's DB.
      try {
        await bridge.sendTextMessage(peer, batch);
      } catch {
        /* transient push failure; retried next loop */
      }
    }
    // Harvest received record batches from every conversation.
    for (const peer of peers) {
      const conv = await bridge.getConversation(peer).catch(() => []);
      for (const m of conv) {
        const text = (m as any).content?.text;
        if (typeof text !== 'string') continue;
        try {
          const parsed = JSON.parse(text);
          const recs = Array.isArray(parsed?.__recs) ? parsed.__recs : [];
          for (const rec of recs) {
            if (rec && rec.__rec && typeof rec.data === 'string') db.set(rec.__rec, rec.data);
          }
        } catch {
          /* not a record batch */
        }
      }
    }
    emit('progress', { have: db.size, want: expectedTotal, handshakes: [...approved] });
    if (db.size >= expectedTotal) converged = true;
    else await new Promise((r) => setTimeout(r, 2500));
  }

  emit('synced', {
    converged,
    count: db.size,
    want: expectedTotal,
    records: [...db.keys()].sort(),
  });

  // Linger so peers can finish harvesting our records too.
  await new Promise((r) => setTimeout(r, 10000));
  await bridge.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  emit('done', { converged });
  process.exit(converged ? 0 : 3);
}

main().catch((err) => {
  emit('error', { message: (err as Error).message });
  process.exit(4);
});
