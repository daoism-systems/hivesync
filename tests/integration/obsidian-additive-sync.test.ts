import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { BridgeManager } from '../../src/core/bridge-manager';
import { InMemoryTransport } from '../../src/core/transport';
import { BridgeConfig } from '../../src/types';

const TOPIC = '/hivesync-test/1/obsidian-sync/proto';

function makeConfig(agentId: string, agentName: string, vaultPath: string): BridgeConfig {
  return {
    agentId,
    agentName,
    storagePath: ':memory:',
    syncInterval: 0,
    waku: {
      listenAddresses: [],
      bootstrapNodes: [],
      clusterId: 1,
      numShardsInCluster: 8,
      contentTopic: TOPIC,
      keepAlive: false,
      maxPeers: 2,
    },
    obsidian: { enabled: true, vaultPath },
  };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return Boolean(await pred());
}

async function establishTrust(a: BridgeManager, b: BridgeManager, aId: string, bId: string): Promise<void> {
  await a.waitForAgent(bId, 5000);
  await b.waitForAgent(aId, 5000);
  await waitFor(async () => (await b.getPendingApprovals()).some((x) => x.agentId === aId), 8000);
  await b.approveHandshake(aId);
  await waitFor(() => b.getHandshakeStatus(aId)?.status === 'confirmed', 5000);
  await waitFor(async () => (await a.getPendingApprovals()).some((x) => x.agentId === bId), 8000);
  await a.approveHandshake(bId);
  await waitFor(() => a.getHandshakeStatus(bId)?.status === 'confirmed', 5000);
}

function read(vault: string, rel: string): string {
  return fs.readFileSync(nodePath.join(vault, rel), 'utf-8');
}

function exists(vault: string, rel: string): boolean {
  return fs.existsSync(nodePath.join(vault, rel));
}

describe('Obsidian additive sync e2e (two agents, in-memory transport)', () => {
  let vaultA: string;
  let vaultB: string;
  let alpha: BridgeManager;
  let beta: BridgeManager;

  beforeEach(async () => {
    vaultA = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'vault-a-'));
    vaultB = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'vault-b-'));

    // Both vaults share a note path with divergent content, and each has a
    // note the other lacks.
    fs.mkdirSync(nodePath.join(vaultA, 'Notes'), { recursive: true });
    fs.mkdirSync(nodePath.join(vaultB, 'Notes'), { recursive: true });
    fs.writeFileSync(nodePath.join(vaultA, 'Notes', 'Shared.md'), '# Shared\n\nfact from alpha\n');
    fs.writeFileSync(nodePath.join(vaultB, 'Notes', 'Shared.md'), '# Shared\n\nfact from beta\n');
    fs.writeFileSync(nodePath.join(vaultA, 'OnlyAlpha.md'), '# Alpha exclusive\n');
    fs.writeFileSync(nodePath.join(vaultB, 'OnlyBeta.md'), '# Beta exclusive\n');

    alpha = new BridgeManager(
      makeConfig('agent-alpha', 'Agent Alpha', vaultA),
      new InMemoryTransport(TOPIC, 'agent-alpha')
    );
    beta = new BridgeManager(
      makeConfig('agent-beta', 'Agent Beta', vaultB),
      new InMemoryTransport(TOPIC, 'agent-beta')
    );

    await alpha.start();
    await beta.start();
    await establishTrust(alpha, beta, 'agent-alpha', 'agent-beta');
  }, 60000);

  afterEach(async () => {
    await alpha.stop();
    await beta.stop();
    fs.rmSync(vaultA, { recursive: true, force: true });
    fs.rmSync(vaultB, { recursive: true, force: true });
  });

  test('vaults enrich each other: union of notes, merged shared content', async () => {
    await alpha.triggerSync();
    await beta.triggerSync();

    // Each agent gains the note it lacked.
    expect(await waitFor(() => exists(vaultA, 'OnlyBeta.md'), 15000)).toBe(true);
    expect(await waitFor(() => exists(vaultB, 'OnlyAlpha.md'), 15000)).toBe(true);

    // The shared note converges to contain BOTH facts on BOTH sides.
    expect(
      await waitFor(() => {
        const a = read(vaultA, 'Notes/Shared.md');
        const b = read(vaultB, 'Notes/Shared.md');
        return (
          a.includes('fact from alpha') &&
          a.includes('fact from beta') &&
          b.includes('fact from alpha') &&
          b.includes('fact from beta')
        );
      }, 15000)
    ).toBe(true);
  }, 60000);

  test('deletions never propagate: peer keeps its copy and nothing is unlinked', async () => {
    await alpha.triggerSync();
    await beta.triggerSync();
    await waitFor(() => exists(vaultB, 'OnlyAlpha.md'), 15000);

    // Alpha deletes a note locally; give the watcher time to see it.
    fs.unlinkSync(nodePath.join(vaultA, 'OnlyAlpha.md'));
    await new Promise((r) => setTimeout(r, 2500));

    // More sync rounds must not delete beta's copy.
    await alpha.triggerSync();
    await beta.triggerSync();
    await new Promise((r) => setTimeout(r, 2500));

    expect(exists(vaultB, 'OnlyAlpha.md')).toBe(true);
    expect(read(vaultB, 'OnlyAlpha.md')).toContain('Alpha exclusive');

    // And beta's copy flows back: alpha's vault expands again instead of
    // the deletion winning.
    await beta.triggerSync();
    expect(await waitFor(() => exists(vaultA, 'OnlyAlpha.md'), 15000)).toBe(true);
  }, 60000);
});
