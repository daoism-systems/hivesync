/**
 * Store census — query the fleet's Store for our content topic and tally
 * envelopes by sender/recipient/type. Answers "whose messages actually reach
 * the network" without trusting any agent's own logs.
 *
 * Usage: node -r ts-node/register/transpile-only scripts/store-census.ts [hours]
 */
const contentTopic = '/hivesync/1/agents/proto';
const clusterId = 1;
const numShardsInCluster = 8;
const hours = Number(process.argv[2] || 48);
// Pin the census to specific store node(s): HIVESYNC_BOOTSTRAP=/dns4/...,/dns4/...
const bootstrap = process.env.HIVESYNC_BOOTSTRAP
  ? process.env.HIVESYNC_BOOTSTRAP.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

const loadSdk = () => new Function('return import("@waku/sdk")')() as Promise<any>;

function log(...a: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(...a);
}

async function main(): Promise<void> {
  const sdk = await loadSdk();
  const { createLightNode, waitForRemotePeer, Protocols } = sdk;
  if (!bootstrap.length) {
    log(
      'WARNING: no HIVESYNC_BOOTSTRAP given — defaultBootstrap mixes the sandbox and\n' +
        'test fleets, so the store query may hit a test-fleet node and report 0\n' +
        'messages. Pin a sandbox store node for a meaningful census.'
    );
  }
  const node = await createLightNode({
    defaultBootstrap: bootstrap.length === 0,
    bootstrapPeers: bootstrap.length ? bootstrap : undefined,
    networkConfig: { clusterId, numShardsInCluster },
    numPeersToUse: 3,
  });
  await node.start();
  await waitForRemotePeer(node, [Protocols.Store], 30000);

  const decoder = node.createDecoder({ contentTopic });
  const byPair = new Map<string, number>();
  const latest = new Map<string, string>();
  let total = 0;
  let undecodable = 0;

  await node.store.queryWithOrderedCallback(
    [decoder],
    (msg: any) => {
      total++;
      try {
        const env = JSON.parse(new TextDecoder().decode(msg.payload));
        const key = `${env.from} -> ${env.to}  [${env.type}]`;
        byPair.set(key, (byPair.get(key) ?? 0) + 1);
        // Waku-level timestamp (ns Date) — envelope field names vary.
        const at = msg.timestamp ? new Date(msg.timestamp).toISOString() : '';
        const fromKey = String(env.from);
        if (!latest.has(fromKey) || at > (latest.get(fromKey) ?? '')) {
          latest.set(fromKey, at);
        }
      } catch {
        undecodable++;
      }
    },
    { timeStart: new Date(Date.now() - hours * 3600 * 1000) }
  );

  log(`\n=== Store census: ${total} message(s) on ${contentTopic}, last ${hours}h ===`);
  log(`undecodable payloads: ${undecodable}\n`);
  log('--- by from -> to [type] ---');
  for (const [k, v] of [...byPair.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  ${String(v).padStart(4)}  ${k}`);
  }
  log('\n--- latest message per sender ---');
  for (const [from, at] of [...latest.entries()].sort()) {
    const ts = /^\d+$/.test(at) ? new Date(Number(at)).toISOString() : at;
    log(`  ${from}: ${ts}`);
  }
  await node.stop();
  process.exit(0);
}

main().catch((e) => {
  log('census failed:', e);
  process.exit(1);
});
