import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
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

  test('queues a message when the transport is down and the outbox delivers it on recovery', async () => {
    // Regression: a publish that reaches no peer used to be marked delivered
    // anyway — silently dropped while the caller saw success.
    const flaky = new InMemoryTransport(TOPIC, 'agent-alpha');
    const realPublish = flaky.publish.bind(flaky);
    let failing = false;
    flaky.publish = async (payload: Uint8Array): Promise<void> => {
      if (failing) throw new Error('LightPush delivered to 0 peers after 5 attempts');
      return realPublish(payload);
    };
    await alpha.stop();
    alpha = new BridgeManager(makeConfig('agent-alpha', 'Agent Alpha'), flaky);

    await alpha.start();
    await beta.start();
    await establishTrust(alpha, beta, 'agent-alpha', 'agent-beta');

    failing = true;
    const { delivered } = await alpha.sendTextMessage('agent-beta', 'delayed hello');
    expect(delivered).toBe(false);

    // While the transport is down the message must be queued, not dropped.
    await new Promise((r) => setTimeout(r, 500));
    expect((await beta.getUnreadMessages()).some((m) => m.content.text === 'delayed hello')).toBe(false);

    failing = false; // network recovers; the outbox poller (2s) should resend
    const received = await waitFor(async () => {
      const msgs = await beta.getUnreadMessages();
      return msgs.some((m) => m.type === MessageType.TEXT && m.content.text === 'delayed hello');
    }, 10000);
    expect(received).toBe(true);
  }, 30000);

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

  test('receive-side rate cap sheds a flooding sender with a rate_limited ACK', async () => {
    // Isolated topic + a low cap on the receiver so we don't need 30+ sends.
    const RC_TOPIC = '/hivesync-test/1/ratecap/proto';
    const flooderCfg = makeConfig('rc-alpha', 'RC Alpha');
    flooderCfg.waku.contentTopic = RC_TOPIC;
    const cappedCfg = makeConfig('rc-beta', 'RC Beta');
    cappedCfg.waku.contentTopic = RC_TOPIC;
    cappedCfg.rateLimitPerWindow = 3;
    cappedCfg.rateLimitWindowMs = 60000;
    const flooder = new BridgeManager(flooderCfg, new InMemoryTransport(RC_TOPIC, 'rc-alpha'));
    const capped = new BridgeManager(cappedCfg, new InMemoryTransport(RC_TOPIC, 'rc-beta'));

    try {
      await flooder.start();
      await capped.start();
      await establishTrust(flooder, capped, 'rc-alpha', 'rc-beta');

      let rateLimitedAcks = 0;
      flooder.on('ack', (r: { status?: string }) => {
        if (r.status === 'rate_limited') rateLimitedAcks += 1;
      });

      for (let i = 0; i < 6; i++) await flooder.sendTextMessage('rc-beta', `flood ${i}`);
      await new Promise((r) => setTimeout(r, 1500));

      // cap = 3 → at most 3 of the 6 land; the rest are shed before storage.
      const delivered = (await capped.getConversation('rc-alpha')).filter((m) =>
        /^flood /.test(m.content.text)
      );
      expect(delivered.length).toBeLessThanOrEqual(3);
      expect(rateLimitedAcks).toBeGreaterThanOrEqual(1);
    } finally {
      await flooder.stop();
      await capped.stop();
    }
  }, 25000);

  describe('lifecycle', () => {
    test('stop is safe before start and idempotent', async () => {
      await expect(alpha.stop()).resolves.not.toThrow();
      await alpha.start();
      await alpha.stop();
      await expect(alpha.stop()).resolves.not.toThrow();
    });
  });

  describe('hooks.onMessage', () => {
    // The hook writes what it observed to a temp file; the test asserts on it.
    // MESSAGE data must arrive via env + stdin — never the command line. (The
    // out-file path below is test-controlled config, so embedding it is fine.)
    test('spawns for trusted TEXT with metadata in env and JSON on stdin, not for ACKs', async () => {
      const HOOK_TOPIC = '/hivesync-test/1/hook/proto';
      const outFile = nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'hs-hook-')), 'hook.out');
      const hookCmd =
        `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>` +
        `require('fs').appendFileSync('${outFile}',` +
        `JSON.stringify({from:process.env.HIVESYNC_FROM,type:process.env.HIVESYNC_TYPE,` +
        `auto:process.env.HIVESYNC_AUTO,stdin:JSON.parse(d)})+'\\n'))"`;

      const senderCfg = makeConfig('hk-alpha', 'Hook Alpha');
      senderCfg.waku.contentTopic = HOOK_TOPIC;
      const receiverCfg = makeConfig('hk-beta', 'Hook Beta');
      receiverCfg.waku.contentTopic = HOOK_TOPIC;
      receiverCfg.hooks = { onMessage: hookCmd };
      const sender = new BridgeManager(senderCfg, new InMemoryTransport(HOOK_TOPIC, 'hk-alpha'));
      const receiver = new BridgeManager(receiverCfg, new InMemoryTransport(HOOK_TOPIC, 'hk-beta'));

      try {
        await sender.start();
        await receiver.start();
        await establishTrust(sender, receiver, 'hk-alpha', 'hk-beta');

        await sender.sendTextMessage('hk-beta', 'wake up, brain');
        await sender.sendTextMessage('hk-beta', 'automated one', true);

        const ran = await waitFor(() => {
          if (!fs.existsSync(outFile)) return false;
          return fs.readFileSync(outFile, 'utf-8').trim().split('\n').length >= 2;
        }, 8000);
        expect(ran).toBe(true);

        const lines = fs
          .readFileSync(outFile, 'utf-8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        // Both actionable messages fired the hook — and nothing else did (the
        // ACKs each send generates flow back to the SENDER, whose config has
        // no hook; the receiver only sees the two TEXTs).
        expect(lines).toHaveLength(2);
        const [manual, auto] = lines;
        expect(manual.from).toBe('hk-alpha');
        expect(manual.type).toBe('text');
        expect(manual.auto).toBe('0');
        expect(manual.stdin.content.text).toBe('wake up, brain');
        expect(auto.auto).toBe('1');
        expect(auto.stdin.content.text).toBe('automated one');
      } finally {
        delete process.env.HOOK_OUT;
        await sender.stop();
        await receiver.stop();
      }
    }, 25000);
  });
});
