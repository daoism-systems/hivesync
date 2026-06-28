import { BridgeManager } from '../../src/core/bridge-manager';
import { InMemoryTransport } from '../../src/core/transport';
import { BridgeConfig, MessageType } from '../../src/types';

const TOPIC = '/hivesync-test/1/integration/proto';

function makeConfig(agentId: string, agentName: string): BridgeConfig {
  return {
    agentId,
    agentName,
    storagePath: ':memory:', // => ephemeral identity, in-memory db
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
  };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return Boolean(await pred());
}

/**
 * Establish mutual trust: each side approves the other's auto-initiated
 * handshake. Messages are quarantined until the handshake is confirmed, so any
 * test that exchanges trusted messages must do this first.
 */
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

describe('BridgeManager communication (in-memory transport)', () => {
  let alpha: BridgeManager;
  let beta: BridgeManager;

  beforeEach(async () => {
    alpha = new BridgeManager(makeConfig('agent-alpha', 'Agent Alpha'), new InMemoryTransport(TOPIC, 'agent-alpha'));
    beta = new BridgeManager(makeConfig('agent-beta', 'Agent Beta'), new InMemoryTransport(TOPIC, 'agent-beta'));
  });

  afterEach(async () => {
    await alpha.stop();
    await beta.stop();
  });

  test('both agents start and report running', async () => {
    expect(await alpha.start()).toBe(true);
    expect(await beta.start()).toBe(true);
    const status = await alpha.getStatus();
    expect(status.running).toBe(true);
    expect(status.agentId).toBe('agent-alpha');
    expect(status.hivesync).toHaveProperty('connected', true);
    expect(status.hivesync).toHaveProperty('knownAgents');
  });

  test('agents discover each other', async () => {
    await alpha.start();
    await beta.start();
    expect(await waitFor(() => alpha.getKnownAgents().some((a) => a.id === 'agent-beta'))).toBe(true);
    expect(await waitFor(() => beta.getKnownAgents().some((a) => a.id === 'agent-alpha'))).toBe(true);
  });

  test('delivers an encrypted directed text message end to end', async () => {
    await alpha.start();
    await beta.start();
    await establishTrust(alpha, beta, 'agent-alpha', 'agent-beta');

    await alpha.sendTextMessage('agent-beta', 'hello beta');

    const received = await waitFor(async () => {
      const msgs = await beta.getUnreadMessages();
      return msgs.some((m) => m.type === MessageType.TEXT && m.content.text === 'hello beta');
    });
    expect(received).toBe(true);

    const msgs = await beta.getUnreadMessages();
    const text = msgs.find((m) => m.content.text === 'hello beta')!;
    expect(text.sender).toBe('agent-alpha');
    expect(text.encrypted).toBe(true); // beta's key was known => encrypted
  }, 20000);

  test('supports a bidirectional exchange (reply)', async () => {
    await alpha.start();
    await beta.start();
    await establishTrust(alpha, beta, 'agent-alpha', 'agent-beta');

    // beta replies as soon as it hears from alpha
    beta.on('text', async (m) => {
      if (m.sender === 'agent-alpha') await beta.sendTextMessage('agent-alpha', 'got it');
    });

    await alpha.sendTextMessage('agent-beta', 'hello?');

    const gotReply = await waitFor(async () => {
      const msgs = await alpha.getUnreadMessages();
      return msgs.some((m) => m.content.text === 'got it');
    });
    expect(gotReply).toBe(true);
  }, 20000);

  test('records both sides of a conversation in history', async () => {
    await alpha.start();
    await beta.start();
    await establishTrust(alpha, beta, 'agent-alpha', 'agent-beta');

    await alpha.sendTextMessage('agent-beta', 'first');
    await waitFor(async () => (await beta.getUnreadMessages()).some((m) => m.content.text === 'first'));
    await beta.sendTextMessage('agent-alpha', 'second');
    await waitFor(async () => (await alpha.getUnreadMessages()).some((m) => m.content.text === 'second'));

    const convo = await alpha.getConversation('agent-beta');
    const texts = convo.map((m) => m.content.text);
    expect(texts).toEqual(expect.arrayContaining(['first', 'second']));
    // outgoing 'first' is attributed to us, incoming 'second' to the peer
    expect(convo.find((m) => m.content.text === 'first')!.sender).toBe('agent-alpha');
    expect(convo.find((m) => m.content.text === 'second')!.sender).toBe('agent-beta');
  }, 20000);

  test('broadcast reaches the other agent but not the sender', async () => {
    await alpha.start();
    await beta.start();
    await establishTrust(alpha, beta, 'agent-alpha', 'agent-beta');

    await alpha.broadcastMessage('hello everyone');

    expect(
      await waitFor(async () => {
        const msgs = await beta.getUnreadMessages();
        return msgs.some((m) => m.content.text === 'hello everyone');
      })
    ).toBe(true);

    // Alice keeps her own outgoing copy, but self-filtering means no network
    // echo — so there's exactly one copy and it's attributed to her.
    const alphaCopies = (await alpha.getBroadcasts()).filter((m) => m.content.text === 'hello everyone');
    expect(alphaCopies).toHaveLength(1);
    expect(alphaCopies[0].sender).toBe('agent-alpha');
  }, 20000);

  test('command messages trigger handled responses', async () => {
    await alpha.start();
    await beta.start();
    await establishTrust(alpha, beta, 'agent-alpha', 'agent-beta');

    await alpha.sendCommand('agent-beta', 'help');

    // beta should respond with a text message back to alpha
    expect(
      await waitFor(async () => {
        const msgs = await alpha.getUnreadMessages();
        return msgs.some((m) => typeof m.content.text === 'string' && m.content.text.includes('Commands'));
      })
    ).toBe(true);
  }, 20000);

  test('auto flag round-trips end to end and is surfaced on the received message', async () => {
    await alpha.start();
    await beta.start();
    await establishTrust(alpha, beta, 'agent-alpha', 'agent-beta');

    await alpha.sendTextMessage('agent-beta', 'auto hello', true);
    expect(
      await waitFor(async () =>
        (await beta.getUnreadMessages()).some((m) => m.content.text === 'auto hello' && m.auto === true)
      )
    ).toBe(true);

    // A normal (human-initiated) send must NOT be flagged auto.
    await alpha.sendTextMessage('agent-beta', 'normal hello');
    await waitFor(async () => (await beta.getUnreadMessages()).some((m) => m.content.text === 'normal hello'));
    const normal = (await beta.getUnreadMessages()).find((m) => m.content.text === 'normal hello')!;
    expect(normal.auto).toBeFalsy();
  }, 20000);

  test('the auto flag lets an autoreply guard prevent infinite ping-pong', async () => {
    await alpha.start();
    await beta.start();
    await establishTrust(alpha, beta, 'agent-alpha', 'agent-beta');

    // Both agents are "always-on auto-repliers" that honor the protocol rule:
    // never auto-reply to a message already marked auto:true. Without the flag
    // (or without honoring it) this would ping-pong forever.
    let alphaAutoReplies = 0;
    let betaAutoReplies = 0;
    const guardedReplier =
      (self: BridgeManager, peer: string, bump: () => void) =>
      async (m: { auto?: boolean; sender: string }) => {
        if (m.auto) return; // <- the guard the protocol enables
        bump();
        await self.sendTextMessage(peer, 'auto-reply', true);
      };
    beta.on('text', guardedReplier(beta, 'agent-alpha', () => (betaAutoReplies += 1)));
    alpha.on('text', guardedReplier(alpha, 'agent-beta', () => (alphaAutoReplies += 1)));

    await alpha.sendTextMessage('agent-beta', 'kick', false);
    await new Promise((r) => setTimeout(r, 1500));

    // kick(auto:false) -> beta auto-replies once -> alpha sees auto:true and
    // stays silent. The exchange terminates instead of looping.
    expect(betaAutoReplies).toBe(1);
    expect(alphaAutoReplies).toBe(0);
  }, 20000);

  describe('lifecycle', () => {
    test('stop is safe before start and idempotent', async () => {
      await expect(alpha.stop()).resolves.not.toThrow();
      await alpha.start();
      await alpha.stop();
      await expect(alpha.stop()).resolves.not.toThrow();
    });
  });
});
