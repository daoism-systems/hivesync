import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

/**
 * True end-to-end test: spawn two independent HiveSync agent *processes* that
 * connect to the real Waku network, discover each other, and exchange an
 * end-to-end-encrypted message.
 *
 * This depends on internet access and the public Waku fleet. Set
 * HIVESYNC_SKIP_E2E=1 to skip (e.g. in an offline CI).
 */

const RUNNER = path.join(__dirname, 'agent-runner.ts');
const TEST_TIMEOUT = 220000;

interface AgentEvent {
  event: string;
  agentId: string;
  [k: string]: unknown;
}

function spawnAgent(
  agentId: string,
  agentName: string,
  contentTopic: string,
  peerAgentId: string,
  token: string,
  onEvent: (e: AgentEvent) => void
): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', RUNNER, agentId, agentName, contentTopic, peerAgentId, token],
    { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' } }
  );

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('HSE2E ')) {
        try {
          onEvent(JSON.parse(line.slice('HSE2E '.length)) as AgentEvent);
        } catch {
          /* ignore non-JSON */
        }
      }
    }
  });
  // Surface child stderr to help diagnose CI failures.
  child.stderr.on('data', (c: Buffer) => {
    const s = c.toString().trim();
    if (s) process.stderr.write(`[${agentId}] ${s}\n`);
  });
  return child;
}

const maybe = process.env.HIVESYNC_SKIP_E2E === '1' ? describe.skip : describe;

maybe('HiveSync real-Waku e2e (two processes)', () => {
  test(
    'two agents discover each other and exchange an encrypted message over Waku',
    async () => {
      const token = `${Date.now().toString(36)}`;
      const topic = `/hivesync-e2e-${token}/1/agents/proto`;

      const events: AgentEvent[] = [];
      const record = (e: AgentEvent) => {
        events.push(e);
        // eslint-disable-next-line no-console
        console.log(`[e2e] ${e.agentId}: ${e.event} ${JSON.stringify(e)}`);
      };

      const alice = spawnAgent('alice', 'Alice', topic, 'bob', token, record);
      const bob = spawnAgent('bob', 'Bob', topic, 'alice', token, record);

      const exitCodes = await Promise.all([
        new Promise<number>((res) => alice.on('exit', (c) => res(c ?? -1))),
        new Promise<number>((res) => bob.on('exit', (c) => res(c ?? -1))),
      ]);

      const received = events.filter((e) => e.event === 'received');
      const aliceReceived = received.find((e) => e.agentId === 'alice');
      const bobReceived = received.find((e) => e.agentId === 'bob');

      // Both agents discovered their peer.
      expect(events.some((e) => e.event === 'discovered' && e.agentId === 'alice' && e.ok)).toBe(true);
      expect(events.some((e) => e.event === 'discovered' && e.agentId === 'bob' && e.ok)).toBe(true);

      // Each agent received the other's message, end-to-end encrypted.
      expect(aliceReceived).toBeDefined();
      expect(bobReceived).toBeDefined();
      expect(aliceReceived!.from).toBe('bob');
      expect(bobReceived!.from).toBe('alice');
      expect(aliceReceived!.encrypted).toBe(true);
      expect(bobReceived!.encrypted).toBe(true);

      expect(exitCodes[0]).toBe(0);
      expect(exitCodes[1]).toBe(0);
    },
    TEST_TIMEOUT
  );
});
