/**
 * Orchestrates a multi-agent HiveSync sync demo over REAL Logos Messaging by spawning all
 * agent processes (scripts/demo-sync.ts) at the SAME instant, so their fixed
 * discovery/broadcast windows are guaranteed to overlap. This is the difference
 * between this and launching agents by hand: no start-time skew.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only scripts/demo-orchestrate.ts [agentId...]
 * Defaults to a 2-agent run (everhomie, claw). Pass names for an N-agent run,
 * e.g. `... demo-orchestrate.ts everhomie claw vibecoder`.
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

const RUNNER = path.join(__dirname, 'demo-sync.ts');
const names = process.argv.slice(2);
const agentIds = names.length >= 2 ? names : ['everhomie', 'claw'];
const token = `o${Date.now().toString(36)}`;
const topic = `/hivesync-demo-${token}/1/agents/proto`;

interface Ev {
  event: string;
  agentId: string;
  [k: string]: unknown;
}
const events: Ev[] = [];

function spawnAgent(agentId: string): ChildProcess {
  const peers = agentIds.filter((a) => a !== agentId).join(',');
  const name = agentId.charAt(0).toUpperCase() + agentId.slice(1);
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', RUNNER, agentId, name, topic, peers, token],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', LOG_LEVEL: 'error' } }
  );
  let buf = '';
  child.stdout.on('data', (c: Buffer) => {
    buf += c.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('HSE2E ')) {
        try {
          const e = JSON.parse(line.slice(6)) as Ev;
          events.push(e);
          if (['discovered', 'handshakes', 'synced', 'done'].includes(e.event)) {
            // eslint-disable-next-line no-console
            console.log(`[${e.agentId}] ${e.event} ${JSON.stringify(e)}`);
          }
        } catch {
          /* ignore */
        }
      }
    }
  });
  return child;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`Orchestrating ${agentIds.length} agents on ${topic}`);
  const children = agentIds.map(spawnAgent); // all spawned synchronously => same start
  await Promise.all(
    children.map((c) => new Promise<number>((res) => c.on('exit', (code) => res(code ?? -1))))
  );

  const synced = events.filter((e) => e.event === 'synced');
  const expected = agentIds.length * 3;
  // eslint-disable-next-line no-console
  console.log('\n===== RESULT =====');
  let allConverged = synced.length === agentIds.length;
  for (const id of agentIds) {
    const s = synced.find((e) => e.agentId === id);
    const count = (s?.count as number) ?? 0;
    const ok = !!s?.converged;
    if (!ok) allConverged = false;
    // eslint-disable-next-line no-console
    console.log(`${id}: ${count}/${expected} records, converged=${ok} :: ${JSON.stringify(s?.records ?? [])}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nALL CONVERGED: ${allConverged}`);
  process.exit(allConverged ? 0 : 1);
}

main();
