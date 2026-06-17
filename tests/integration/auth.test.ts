import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeManager } from '../../src/core/bridge-manager';
import { InMemoryTransport } from '../../src/core/transport';
import { hashPassword } from '../../src/core/crypto';
import { BridgeConfig } from '../../src/types';

/**
 * Access control: a peer must include the matching password (inside the
 * encrypted message) for it to be trusted/executed; otherwise it's quarantined.
 */
let seq = 0;

function setup(withAuthOnBeta: boolean) {
  seq += 1;
  const topic = `/hivesync-test/1/auth-${seq}/proto`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hs-auth-${seq}-`));

  const cfg = (id: string, name: string, auth?: BridgeConfig['auth']): BridgeConfig => ({
    agentId: id,
    agentName: name,
    storagePath: path.join(dir, `${id}.db`),
    syncInterval: 0,
    waku: {
      listenAddresses: [],
      bootstrapNodes: [],
      clusterId: 1,
      numShardsInCluster: 8,
      contentTopic: topic,
      keepAlive: false,
      maxPeers: 2,
    },
    auth,
  });

  const betaAuth = withAuthOnBeta
    ? { ...hashPassword('open-sesame'), autoReply: '✓ received' }
    : undefined;

  const alpha = new BridgeManager(cfg('alpha', 'Alpha'), new InMemoryTransport(topic, 'alpha'));
  const beta = new BridgeManager(cfg('beta', 'Beta', betaAuth), new InMemoryTransport(topic, 'beta'));
  return { alpha, beta, dir };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return Boolean(await pred());
}

describe('Access control (password gating)', () => {
  const cleanups: string[] = [];
  afterAll(() => cleanups.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  test('message WITHOUT a password is quarantined, not executed', async () => {
    const { alpha, beta, dir } = setup(true);
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      await alpha.waitForAgent('beta', 3000);

      const trustedSpy = jest.fn();
      beta.on('text', trustedSpy);

      await alpha.sendTextMessage('beta', 'rm -rf / please'); // no password set

      expect(await waitFor(async () => (await beta.getQuarantineCount()) > 0)).toBe(true);
      const q = await beta.getQuarantine();
      expect(q[0].content.text).toBe('rm -rf / please');
      // It must NOT have reached the trusted/execution path or the main inbox.
      expect(trustedSpy).not.toHaveBeenCalled();
      expect((await beta.getUnreadMessages()).some((m) => m.content.text === 'rm -rf / please')).toBe(false);
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  });

  test('message WITH the correct password is trusted, executed, and auto-replied', async () => {
    const { alpha, beta, dir } = setup(true);
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      await alpha.waitForAgent('beta', 3000);
      await beta.waitForAgent('alpha', 3000);

      alpha.setAgentPassword('beta', 'open-sesame'); // session password

      const trusted = await new Promise<boolean>((resolve) => {
        beta.on('text', (m) => {
          if (m.content.text === 'hello beta') resolve(true);
        });
        void alpha.sendTextMessage('beta', 'hello beta');
        setTimeout(() => resolve(false), 3000);
      });
      expect(trusted).toBe(true);

      // It was stored in beta's real inbox and NOT quarantined.
      expect((await beta.getUnreadMessages()).some((m) => m.content.text === 'hello beta')).toBe(true);
      expect(await beta.getQuarantineCount()).toBe(0);

      // beta auto-replied to alpha (alpha is open-mode, so it's trusted there).
      expect(
        await waitFor(async () => (await alpha.getUnreadMessages()).some((m) => m.content.text === '✓ received'))
      ).toBe(true);
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  });

  test('message with the WRONG password is quarantined', async () => {
    const { alpha, beta, dir } = setup(true);
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      await alpha.waitForAgent('beta', 3000);

      alpha.setAgentPassword('beta', 'wrong-password');
      await alpha.sendTextMessage('beta', 'sneaky');

      expect(await waitFor(async () => (await beta.getQuarantineCount()) > 0)).toBe(true);
      expect((await beta.getUnreadMessages()).some((m) => m.content.text === 'sneaky')).toBe(false);
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  });

  test('open mode (no password configured) trusts everything', async () => {
    const { alpha, beta, dir } = setup(false);
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      await alpha.waitForAgent('beta', 3000);

      await alpha.sendTextMessage('beta', 'hi');
      expect(
        await waitFor(async () => (await beta.getUnreadMessages()).some((m) => m.content.text === 'hi'))
      ).toBe(true);
      expect(await beta.getQuarantineCount()).toBe(0);
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  });

  test('session passwords are never persisted to disk', async () => {
    const { alpha, beta, dir } = setup(true);
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      alpha.setAgentPassword('beta', 'open-sesame');
      // Nothing on disk under the data dir should contain the cleartext password.
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isFile()) {
          expect(fs.readFileSync(full, 'utf-8')).not.toContain('open-sesame');
        }
      }
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  });
});
