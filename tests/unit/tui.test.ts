import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { startTui } from '../../src/utils/tui';
import { Message, AgentIdentity } from '../../src/types';

/**
 * The TUI can't be rendered in a non-TTY test environment, but we can drive the
 * real blessed widgets against a fake bridge + piped streams to catch API
 * misuse, bad tag markup, and event-wiring regressions (it must not throw).
 */
function fakeBridge() {
  const agents: AgentIdentity[] = [];
  const sent: Array<{ to: string; text: string }> = [];
  const bridge: any = new EventEmitter();
  bridge.agentId = 'me';
  bridge.getKnownAgents = () => agents;
  bridge.getConversation = async () => [] as Message[];
  bridge.getBroadcasts = async () => [] as Message[];
  bridge.sendTextMessage = async (to: string, text: string) => {
    sent.push({ to, text });
    return { id: 'id', delivered: true };
  };
  bridge.broadcastMessage = async (text: string) => {
    sent.push({ to: 'broadcast', text });
    return 'id';
  };
  bridge.stop = async () => undefined;
  bridge.getQuarantine = async () => [];
  bridge.getQuarantineDir = () => '/tmp/quarantine';
  bridge.getQuarantineCount = async () => 0;
  bridge.getPendingApprovals = async () => [];
  const approved: string[] = [];
  const denied: string[] = [];
  bridge.approveHandshake = async (id: string) => {
    approved.push(id);
    return true;
  };
  bridge.denyHandshake = async (id: string) => {
    denied.push(id);
    return true;
  };
  bridge._agents = agents;
  bridge._sent = sent;
  bridge._approved = approved;
  bridge._denied = denied;
  return bridge;
}

function fakeScreenIO() {
  const output = new PassThrough();
  const input = new PassThrough();
  (output as any).columns = 80;
  (output as any).rows = 24;
  let buf = '';
  output.on('data', (c) => (buf += c.toString()));
  return { output, input, getBuf: () => buf, opts: { output, input, terminal: 'xterm', smartCSR: false } };
}

describe('TUI (headless smoke)', () => {
  test('renders contacts and survives live events without throwing', async () => {
    const bridge = fakeBridge();
    const { getBuf, input, opts } = fakeScreenIO();

    // startTui never resolves; just kick it off.
    void startTui(bridge, opts as any);
    await tick();

    // Something was drawn (the contacts view, incl. the Broadcast room).
    expect(getBuf().length).toBeGreaterThan(0);

    // A discovery event must not throw and should re-render.
    const agent: AgentIdentity = {
      id: 'agent-x',
      name: 'Agent X',
      publicKey: 'spk',
      encPublicKey: 'epk',
      keyId: 'kid',
      createdAt: new Date(),
      lastSeen: new Date(),
    };
    bridge._agents.push(agent);
    expect(() => bridge.emit('agentDiscovered', agent)).not.toThrow();
    await tick();

    // An incoming message (for a non-open chat) must not throw.
    const msg: Message = {
      id: 'm1',
      sender: 'agent-x',
      recipient: 'me',
      type: 'text' as any,
      content: { text: 'hi {with} braces' }, // tags must be escaped, not crash
      timestamp: new Date(),
      encrypted: true,
    };
    expect(() => bridge.emit('text', msg)).not.toThrow();
    await tick();

    // An incoming handshake request must pop the approval modal without throwing.
    expect(() =>
      bridge.emit('handshakeApprovalNeeded', {
        agentId: 'agent-x',
        agentName: 'Agent X',
        capabilities: ['text', 'sync'],
      })
    ).not.toThrow();
    await tick();

    // Pressing `y` must approve the pending handshake (regression: the modal's
    // keys didn't fire while a textbox held grabKeys, so `y` did nothing).
    input.write('y');
    await tick();
    expect(bridge._approved).toContain('agent-x');
  });

  test('pressing n denies the pending handshake', async () => {
    const bridge = fakeBridge();
    const { input, opts } = fakeScreenIO();
    void startTui(bridge, opts as any);
    await tick();
    bridge.emit('handshakeApprovalNeeded', {
      agentId: 'agent-y',
      agentName: 'Agent Y',
      capabilities: [],
    });
    await tick();
    input.write('n');
    await tick();
    expect(bridge._denied).toContain('agent-y');
  });
});

const tick = () => new Promise((r) => setTimeout(r, 50));
