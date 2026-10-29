import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeManager } from '../../src/core/bridge-manager';
import { InMemoryTransport } from '../../src/core/transport';
import { BridgeConfig, MessageType } from '../../src/types';

/**
 * Vault sync frames write files on the receiving host. They must only be
 * accepted from confirmed contacts, and even then a note path may never land
 * outside the vault.
 */
let seq = 0;

function setup() {
  seq += 1;
  const topic = `/hivesync-test/1/sync-trust-${seq}/proto`;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hs-sync-${seq}-`)));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);

  const cfg = (id: string, name: string, withVault: boolean): BridgeConfig => ({
    agentId: id,
    agentName: name,
    storagePath: path.join(dir, `${id}.db`),
    syncInterval: 0,
    ...(withVault ? { obsidian: { enabled: true, vaultPath: vault } } : {}),
    waku: {
      listenAddresses: [],
      bootstrapNodes: [],
      clusterId: 1,
      numShardsInCluster: 8,
      contentTopic: topic,
      keepAlive: false,
      maxPeers: 2,
    },
  });

  const attacker = new BridgeManager(cfg('alpha', 'Alpha', false), new InMemoryTransport(topic, 'alpha'));
  const victim = new BridgeManager(cfg('beta', 'Beta', true), new InMemoryTransport(topic, 'beta'));
  return { attacker, victim, dir, vault };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return Boolean(await pred());
}

function note(p: string, content: string) {
  return { id: undefined, path: p, content, lastModified: new Date().toISOString(), hash: `h-${p}` };
}

/** Send a raw obsidian update from `from` to `to` (bypassing the sync manager). */
function sendUpdate(from: BridgeManager, to: string, notes: ReturnType<typeof note>[]): Promise<string> {
  return (from as any).hivesync.sendMessage({
    sender: 'alpha',
    recipient: to,
    type: MessageType.OBSIDIAN_UPDATE,
    content: { notes },
  });
}

describe('vault sync trust and path containment', () => {
  const cleanups: string[] = [];
  afterAll(() => cleanups.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  test('sync frames from an unapproved peer are rejected and write nothing', async () => {
    const { attacker, victim, dir, vault } = setup();
    cleanups.push(dir);
    try {
      await attacker.start();
      await victim.start();
      await attacker.waitForAgent('beta', 5000);

      const acks: { originalMessageId: string; status: string }[] = [];
      attacker.on('ack', (a: any) => acks.push(a));

      const id = await sendUpdate(attacker, 'beta', [note('from-untrusted.md', 'x'), note('../escape.md', 'x')]);
      expect(await waitFor(() => acks.some((a) => a.originalMessageId === id))).toBe(true);
      expect(acks.find((a) => a.originalMessageId === id)?.status).toBe('rejected');

      expect(fs.existsSync(path.join(vault, 'from-untrusted.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'escape.md'))).toBe(false);
    } finally {
      await attacker.stop();
      await victim.stop();
    }
  }, 20000);

  test('a confirmed contact cannot write outside the vault or into hidden paths', async () => {
    const { attacker, victim, dir, vault } = setup();
    cleanups.push(dir);
    try {
      await attacker.start();
      await victim.start();
      await attacker.waitForAgent('beta', 5000);

      // The victim approves the peer, so its sync frames pass the trust gate.
      await waitFor(async () => (await victim.getPendingApprovals()).some((a) => a.agentId === 'alpha'));
      await victim.approveHandshake('alpha');
      await waitFor(() => victim.getHandshakeStatus('alpha')?.status === 'confirmed');

      await sendUpdate(attacker, 'beta', [
        note('../escape.md', 'pwned'),
        note('../../../../../../../../tmp/hs-escape-probe.md', 'pwned'),
        note('.git/hooks/pre-commit.md', 'pwned'),
        note('ok.md', 'hello'),
      ]);

      // The safe note is processed in the same loop, after the unsafe ones.
      expect(await waitFor(() => fs.existsSync(path.join(vault, 'ok.md')))).toBe(true);
      expect(fs.readFileSync(path.join(vault, 'ok.md'), 'utf-8')).toBe('hello');
      expect(fs.existsSync(path.join(dir, 'escape.md'))).toBe(false);
      expect(fs.existsSync('/tmp/hs-escape-probe.md')).toBe(false);
      expect(fs.existsSync(path.join(vault, '.git'))).toBe(false);
    } finally {
      await attacker.stop();
      await victim.stop();
    }
  }, 20000);
});
