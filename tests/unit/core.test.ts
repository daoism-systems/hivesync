import { HiveSync } from '../../src/core/hivesync-bridge';
import { Identity } from '../../src/core/identity';
import { InMemoryTransport } from '../../src/core/transport';
import { BridgeConfig, MessageType, Message, AgentIdentity } from '../../src/types';

const TOPIC = '/hivesync-test/1/core/proto';

function makeConfig(agentId: string): BridgeConfig {
  return {
    agentId,
    agentName: agentId,
    storagePath: ':memory:',
    syncInterval: 0, // no periodic announce noise during tests
    waku: {
      listenAddresses: [],
      bootstrapNodes: [],
      clusterId: 1,
      numShardsInCluster: 8,
      contentTopic: TOPIC,
      keepAlive: false,
      maxPeers: 1,
    },
  };
}

function makeNode(agentId: string): { node: HiveSync; transport: InMemoryTransport } {
  const transport = new InMemoryTransport(TOPIC, agentId);
  const node = new HiveSync(makeConfig(agentId), Identity.ephemeral(agentId, agentId), transport);
  return { node, transport };
}

const tick = () => new Promise((r) => setTimeout(r, 30));
async function waitFor(pred: () => boolean, ms = 1000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await tick();
  }
  return pred();
}

describe('HiveSync core', () => {
  let alice: HiveSync;
  let bob: HiveSync;

  beforeEach(async () => {
    alice = makeNode('alice').node;
    bob = makeNode('bob').node;
    await alice.initialize(0);
    await bob.initialize(0);
  });

  afterEach(async () => {
    await alice.disconnect();
    await bob.disconnect();
  });

  test('agents discover each other via ANNOUNCE', async () => {
    expect(await waitFor(() => bob.getKnownAgents().some((a) => a.id === 'alice'))).toBe(true);
    expect(await waitFor(() => alice.getKnownAgents().some((a) => a.id === 'bob'))).toBe(true);

    const known = bob.getKnownAgents().find((a) => a.id === 'alice')!;
    expect(known.publicKey).toBeDefined();
    expect(known.encPublicKey).toBeDefined();
  });

  test('directed text message reaches only the addressee', async () => {
    await waitFor(() => alice.getKnownAgents().some((a) => a.id === 'bob'));

    const received: Message[] = [];
    bob.onMessage(MessageType.TEXT, (m) => received.push(m));

    await alice.sendMessage({
      sender: 'alice',
      recipient: 'bob',
      type: MessageType.TEXT,
      content: { text: 'hi bob' },
      encrypted: false,
    });

    expect(await waitFor(() => received.length === 1)).toBe(true);
    expect(received[0].sender).toBe('alice');
    expect(received[0].content.text).toBe('hi bob');
  });

  test('a node does not receive its own broadcasts (self-filter)', async () => {
    const aliceGot: Message[] = [];
    alice.onMessage(MessageType.TEXT, (m) => aliceGot.push(m));

    await alice.sendMessage({
      sender: 'alice',
      recipient: 'broadcast',
      type: MessageType.TEXT,
      content: { text: 'anyone there?' },
      encrypted: false,
    });

    await tick();
    await tick();
    expect(aliceGot).toHaveLength(0);
  });

  test('end-to-end encrypts directed messages once keys are known', async () => {
    await waitFor(() => alice.getKnownAgents().some((a) => a.id === 'bob'));

    const got: Message[] = [];
    bob.onMessage(MessageType.TEXT, (m) => got.push(m));

    await alice.sendMessage({
      sender: 'alice',
      recipient: 'bob',
      type: MessageType.TEXT,
      content: { text: 'classified' },
      encrypted: true,
    });

    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got[0].encrypted).toBe(true);
    expect(got[0].content.text).toBe('classified');
  });

  test('drops frames with an invalid signature', async () => {
    const transport = new InMemoryTransport(TOPIC, 'attacker');
    await transport.start();

    const got: Message[] = [];
    bob.onMessage(MessageType.TEXT, (m) => got.push(m));

    // A forged envelope: signed field present but bogus.
    const forged = {
      v: 1,
      id: 'forged-1',
      from: 'mallory',
      to: 'bob',
      type: MessageType.TEXT,
      ts: Date.now(),
      spk: Identity.ephemeral('mallory', 'M').signPublicKey,
      sig: Buffer.from('garbage').toString('base64'),
      enc: false,
      body: JSON.stringify({ text: 'spoofed' }),
    };
    await transport.publish(Buffer.from(JSON.stringify(forged)));

    await tick();
    await tick();
    expect(got).toHaveLength(0);
    await transport.stop();
  });

  test('de-duplicates redelivered frames', async () => {
    await waitFor(() => alice.getKnownAgents().some((a) => a.id === 'bob'));
    const got: Message[] = [];
    bob.onMessage(MessageType.TEXT, (m) => got.push(m));

    // Capture a real signed frame Alice emits, then replay it twice.
    const sniffer = new InMemoryTransport(TOPIC, 'sniffer');
    await sniffer.start();
    let frame: Uint8Array | null = null;
    await sniffer.subscribe((p) => {
      const env = JSON.parse(Buffer.from(p).toString());
      if (env.type === MessageType.TEXT && env.from === 'alice') frame = p;
    });

    await alice.sendMessage({
      sender: 'alice',
      recipient: 'bob',
      type: MessageType.TEXT,
      content: { text: 'dupe-me' },
      encrypted: false,
    });

    expect(await waitFor(() => frame !== null)).toBe(true);
    await sniffer.publish(frame!);
    await sniffer.publish(frame!);
    await tick();
    await tick();

    expect(got.filter((m) => m.content.text === 'dupe-me')).toHaveLength(1);
    await sniffer.stop();
  });

  test('fires onAgentDiscovered exactly once per new agent', async () => {
    const carol = makeNode('carol').node;
    const discovered: AgentIdentity[] = [];
    carol.onAgentDiscovered((a) => discovered.push(a));
    await carol.initialize(0);

    await waitFor(() => discovered.length >= 2, 2000);
    const ids = discovered.map((d) => d.id).sort();
    // Discovered alice & bob, each once.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['alice', 'bob']));

    await carol.disconnect();
  });
});
