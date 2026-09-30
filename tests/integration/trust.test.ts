import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeManager } from '../../src/core/bridge-manager';
import { InMemoryTransport } from '../../src/core/transport';
import { BridgeConfig } from '../../src/types';

/**
 * Trust model: a peer's messages are trusted (stored + emitted to consumers)
 * only after the local user has approved that peer's handshake. Until then the
 * peer is untrusted and its messages are quarantined — never executed. There
 * are no passwords; approval is the single gate.
 */
let seq = 0;

function setup() {
  seq += 1;
  const topic = `/hivesync-test/1/trust-${seq}/proto`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hs-trust-${seq}-`));

  const cfg = (id: string, name: string): BridgeConfig => ({
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
  });

  const alpha = new BridgeManager(cfg('alpha', 'Alpha'), new InMemoryTransport(topic, 'alpha'));
  const beta = new BridgeManager(cfg('beta', 'Beta'), new InMemoryTransport(topic, 'beta'));
  return { alpha, beta, dir };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return Boolean(await pred());
}

/** Approve `peerId`'s pending handshake on `approver` and wait until confirmed. */
async function approvePeerOn(approver: BridgeManager, peerId: string): Promise<void> {
  await waitFor(async () => (await approver.getPendingApprovals()).some((a) => a.agentId === peerId));
  await approver.approveHandshake(peerId);
  await waitFor(() => approver.getHandshakeStatus(peerId)?.status === 'confirmed');
}

describe('Access control (handshake approval)', () => {
  const cleanups: string[] = [];
  afterAll(() => cleanups.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  test('a received handshake stays pending until the user approves it', async () => {
    const { alpha, beta, dir } = setup();
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      await beta.waitForAgent('alpha', 5000);

      // alpha auto-initiates a handshake on discovery; beta must NOT auto-accept.
      expect(
        await waitFor(async () => (await beta.getPendingApprovals()).some((a) => a.agentId === 'alpha'))
      ).toBe(true);
      expect(beta.getHandshakeStatus('alpha')?.status).not.toBe('confirmed');
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  }, 20000);

  test('a message from an unapproved peer is quarantined, not executed', async () => {
    const { alpha, beta, dir } = setup();
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      await alpha.waitForAgent('beta', 5000);

      const trustedSpy = jest.fn();
      beta.on('text', trustedSpy);

      await alpha.sendTextMessage('beta', 'rm -rf / please'); // alpha not approved by beta

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
  }, 20000);

  test('after the user approves the handshake, the peer is trusted', async () => {
    const { alpha, beta, dir } = setup();
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      await alpha.waitForAgent('beta', 5000);
      await beta.waitForAgent('alpha', 5000);

      // The local user (beta) approves alpha's handshake request.
      await approvePeerOn(beta, 'alpha');

      const trusted = await new Promise<boolean>((resolve) => {
        beta.on('text', (m) => {
          if (m.content.text === 'hello beta') resolve(true);
        });
        void alpha.sendTextMessage('beta', 'hello beta');
        setTimeout(() => resolve(false), 5000);
      });
      expect(trusted).toBe(true);

      // Stored in beta's real inbox and NOT quarantined.
      expect((await beta.getUnreadMessages()).some((m) => m.content.text === 'hello beta')).toBe(true);
      expect(await beta.getQuarantineCount()).toBe(0);

      // beta now lists alpha as a confirmed contact.
      expect((await beta.getContacts()).some((c) => c.id === 'alpha')).toBe(true);
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  }, 20000);

  test('a re-init from an already-approved peer keeps it trusted and re-sends acceptance', async () => {
    const { alpha, beta, dir } = setup();
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      await alpha.waitForAgent('beta', 5000);
      await beta.waitForAgent('alpha', 5000);
      await approvePeerOn(beta, 'alpha');

      // alpha missed beta's acceptance (lost ack / restart) and handshakes again.
      // beta must answer "accepted", not demote alpha to pending.
      await (alpha as any).hivesync.sendHandshakeInit('beta');
      expect(await waitFor(() => alpha.getHandshakeStatus('beta')?.status === 'confirmed', 5000)).toBe(true);
      expect(beta.getHandshakeStatus('alpha')?.status).toBe('confirmed');

      const trusted = await new Promise<boolean>((resolve) => {
        beta.on('text', (m) => {
          if (m.content.text === 'after re-init') resolve(true);
        });
        void alpha.sendTextMessage('beta', 'after re-init');
        setTimeout(() => resolve(false), 5000);
      });
      expect(trusted).toBe(true);
      expect(await beta.getQuarantineCount()).toBe(0);
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  }, 20000);

  test('denying a handshake leaves the peer untrusted (messages quarantined)', async () => {
    const { alpha, beta, dir } = setup();
    cleanups.push(dir);
    try {
      await alpha.start();
      await beta.start();
      await alpha.waitForAgent('beta', 5000);

      await waitFor(async () => (await beta.getPendingApprovals()).some((a) => a.agentId === 'alpha'));
      await beta.denyHandshake('alpha');

      await alpha.sendTextMessage('beta', 'let me in');
      expect(await waitFor(async () => (await beta.getQuarantineCount()) > 0)).toBe(true);
      expect((await beta.getUnreadMessages()).some((m) => m.content.text === 'let me in')).toBe(false);
    } finally {
      await alpha.stop();
      await beta.stop();
    }
  }, 20000);
});
