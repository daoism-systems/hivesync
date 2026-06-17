import * as blessed from 'blessed';
import { BridgeManager } from '../core/bridge-manager';
import { Message, AgentIdentity } from '../types';
import { logger } from './logger';

const BROADCAST = 'broadcast';
const QUARANTINE = 'quarantine';

/**
 * A small terminal messaging app over HiveSync.
 *
 *   Contacts list  --Enter-->  Chat  --Esc-->  back to Contacts
 *                  --?------>  Commands/help --Esc--> back
 *
 * Humans get an interactive UI; agents get the same capabilities via the
 * event-driven {@link BridgeManager} API (`on('text'|'agentDiscovered')`,
 * `sendTextMessage`, `getConversation`), so this view is purely additive.
 */
export async function startTui(
  bridge: BridgeManager,
  screenOptions: blessed.Widgets.IScreenOptions = {}
): Promise<void> {
  // blessed owns the screen — silence the logger so it can't corrupt the UI.
  silenceLogger();

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: 'HiveSync',
    ...screenOptions,
  });

  const unread = new Map<string, number>();
  let view: 'contacts' | 'chat' | 'help' | 'password' | 'quarantine' = 'contacts';
  let openPeer: string | null = null;
  let pendingPeer: string | null = null;
  // Maps a contacts-list row index to a peer id ('broadcast' or an agentId).
  let rowToPeer: string[] = [];

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    height: 1,
    width: '100%',
    tags: true,
    style: { fg: 'black', bg: 'cyan' },
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    height: 1,
    width: '100%',
    tags: true,
    style: { fg: 'white', bg: 'blue' },
  });

  // --- Contacts view -------------------------------------------------------
  const contacts = blessed.list({
    parent: screen,
    top: 1,
    bottom: 1,
    left: 0,
    width: '100%',
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    style: { selected: { bg: 'cyan', fg: 'black' }, item: { fg: 'white' } },
  });

  // --- Chat view -----------------------------------------------------------
  const chatLog = blessed.log({
    parent: screen,
    top: 1,
    left: 0,
    width: '100%',
    bottom: 4,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', style: { bg: 'cyan' } } as any,
    mouse: true,
    keys: true,
    hidden: true,
  });

  const input = blessed.textbox({
    parent: screen,
    bottom: 1,
    left: 0,
    width: '100%',
    height: 3,
    border: { type: 'line' },
    label: ' message (Enter to send · Esc to go back) ',
    inputOnFocus: true,
    keys: true,
    mouse: true,
    style: { border: { fg: 'cyan' } },
    hidden: true,
  });

  // --- Help view -----------------------------------------------------------
  const help = blessed.box({
    parent: screen,
    top: 1,
    bottom: 1,
    left: 0,
    width: '100%',
    tags: true,
    padding: { left: 2, top: 1 },
    hidden: true,
    content: helpText(),
  });

  // --- Quarantine view (read-only) ----------------------------------------
  const quarantineLog = blessed.log({
    parent: screen,
    top: 1,
    bottom: 1,
    left: 0,
    width: '100%',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    padding: { left: 1 },
    hidden: true,
  });

  // --- Password prompt overlay --------------------------------------------
  const pwPrompt = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: 7,
    border: { type: 'line' },
    tags: true,
    label: ' password ',
    style: { border: { fg: 'yellow' } },
    hidden: true,
  });
  const pwLabel = blessed.text({ parent: pwPrompt, top: 0, left: 1, right: 1, tags: true });
  const pwInput = blessed.textbox({
    parent: pwPrompt,
    bottom: 1,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    censor: true,
    keys: true,
    style: { fg: 'white', bg: 'black' },
  });

  // --- rendering helpers ---------------------------------------------------
  function setHeader(text: string): void {
    header.setContent(` {bold}HiveSync{/bold}  ${text}`);
  }

  function setFooter(text: string): void {
    footer.setContent(` ${text}`);
  }

  function shortId(id: string): string {
    return id.length > 22 ? `${id.slice(0, 19)}…` : id;
  }

  function nameFor(id: string): string {
    if (id === BROADCAST) return '📢 Broadcast';
    const a = bridge.getKnownAgents().find((x) => x.id === id);
    return a ? a.name : id;
  }

  function refreshContacts(): void {
    const agents = bridge
      .getKnownAgents()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    rowToPeer = [BROADCAST, QUARANTINE, ...agents.map((a) => a.id)];

    const items = [
      `{yellow-fg}📢 Broadcast{/yellow-fg}${badge(BROADCAST)}`,
      `{red-fg}🚫 Quarantine{/red-fg}${badge(QUARANTINE)}`,
      ...agents.map((a) => `{cyan-fg}${a.name}{/cyan-fg} {gray-fg}(${shortId(a.id)}){/gray-fg}${badge(a.id)}`),
    ];
    if (agents.length === 0) {
      items.push('{gray-fg}— no agents discovered yet, listening…{/gray-fg}');
    }
    contacts.setItems(items);
    screen.render();
  }

  function badge(peer: string): string {
    const n = unread.get(peer) || 0;
    return n > 0 ? `  {red-fg}{bold}(${n}){/bold}{red-fg}{/red-fg}` : '';
  }

  function escapeTags(s: string): string {
    return String(s).replace(/[{}]/g, '');
  }

  function renderMessage(m: Message): void {
    const me = m.sender === bridge.agentId;
    const who = me ? '{green-fg}you{/green-fg}' : `{cyan-fg}${escapeTags(nameFor(m.sender))}{/cyan-fg}`;
    const lock = m.encrypted ? '🔒' : '✉️ ';
    const t = new Date(m.timestamp);
    const time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    chatLog.add(`{gray-fg}${time}{/gray-fg} ${lock} ${who}: ${escapeTags(m.content?.text ?? '')}`);
  }

  // --- view switching ------------------------------------------------------
  function showContacts(): void {
    view = 'contacts';
    openPeer = null;
    pendingPeer = null;
    chatLog.hide();
    input.hide();
    help.hide();
    quarantineLog.hide();
    pwPrompt.hide();
    contacts.show();
    setHeader('Contacts');
    setFooter('{bold}↑/↓{/bold} move · {bold}Enter{/bold} open · {bold}?{/bold} commands · {bold}q{/bold} quit');
    contacts.focus();
    refreshContacts();
  }

  // Ask for the peer's password (session-only), then open the chat.
  function openAgent(peer: string): void {
    view = 'password';
    pendingPeer = peer;
    pwLabel.setContent(
      `Password for {cyan-fg}${escapeTags(nameFor(peer))}{/cyan-fg}\n` +
        '{gray-fg}Enter to confirm · blank = unauthenticated · Esc to cancel{/gray-fg}'
    );
    pwInput.clearValue();
    pwPrompt.show();
    pwInput.focus();
    screen.render();
  }

  async function showQuarantine(): Promise<void> {
    view = 'quarantine';
    unread.set(QUARANTINE, 0);
    contacts.hide();
    quarantineLog.show();
    quarantineLog.setContent('');
    const items = await bridge.getQuarantine();
    if (items.length === 0) {
      quarantineLog.add('{gray-fg}No quarantined messages.{/gray-fg}');
    } else {
      quarantineLog.add('{red-fg}{bold}UNTRUSTED — these messages were NOT executed.{/bold}{/red-fg}');
      quarantineLog.add('');
      for (const q of items) {
        const t = new Date(q.timestamp);
        const time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
        quarantineLog.add(
          `{gray-fg}${time}{/gray-fg} {cyan-fg}${escapeTags(q.sender)}{/cyan-fg} {red-fg}[${escapeTags(q.reason)}]{/red-fg}`
        );
        quarantineLog.add(`  ${escapeTags(textOf(q.content))}`);
      }
    }
    setHeader('Quarantine (read-only)');
    setFooter(`{bold}Esc{/bold} back · files: ${bridge.getQuarantineDir()}`);
    quarantineLog.focus();
    screen.render();
  }

  async function showChat(peer: string): Promise<void> {
    view = 'chat';
    openPeer = peer;
    unread.set(peer, 0);
    contacts.hide();
    help.hide();
    quarantineLog.hide();
    pwPrompt.hide();
    chatLog.show();
    input.show();
    chatLog.setContent('');

    const history = peer === BROADCAST ? await bridge.getBroadcasts() : await bridge.getConversation(peer);
    history.forEach(renderMessage);

    let note: string;
    if (peer === BROADCAST) {
      note = '{yellow-fg}broadcast — signed, not encrypted{/yellow-fg}';
    } else {
      const known = bridge.getKnownAgents().some((a) => a.id === peer && a.encPublicKey);
      const enc = known
        ? '{green-fg}🔒 encrypted{/green-fg}'
        : '{red-fg}peer key unknown — plaintext{/red-fg}';
      const auth = bridge.hasAgentPassword(peer)
        ? '{green-fg}🔑 authenticated{/green-fg}'
        : '{yellow-fg}⚠ no password — will be quarantined for them{/yellow-fg}';
      note = `${enc} · ${auth}`;
    }
    setHeader(`Chat · ${escapeTags(nameFor(peer))} · ${note}`);
    setFooter('{bold}Enter{/bold} send · {bold}Esc{/bold} back · {bold}Ctrl-C{/bold} quit');
    input.focus();
    screen.render();
  }

  function showHelp(): void {
    view = 'help';
    contacts.hide();
    chatLog.hide();
    input.hide();
    quarantineLog.hide();
    pwPrompt.hide();
    help.show();
    setHeader('Commands');
    setFooter('{bold}Esc{/bold} back to contacts · {bold}q{/bold} quit');
    help.focus();
    screen.render();
  }

  // --- events --------------------------------------------------------------
  contacts.on('select', (_item, index) => {
    const peer = rowToPeer[index];
    if (!peer) return;
    if (peer === QUARANTINE) void showQuarantine();
    else if (peer === BROADCAST) void showChat(BROADCAST);
    else openAgent(peer); // ask for password first
  });

  pwInput.on('submit', (value: string) => {
    if (pendingPeer) {
      bridge.setAgentPassword(pendingPeer, (value || '').trim());
      const peer = pendingPeer;
      pwInput.clearValue();
      pwPrompt.hide();
      void showChat(peer);
    }
  });
  pwInput.key('escape', () => {
    pwInput.clearValue();
    pwPrompt.hide();
    showContacts();
  });
  quarantineLog.key('escape', () => showContacts());

  input.on('submit', async (value: string) => {
    const text = (value || '').trim();
    input.clearValue();
    if (text && openPeer) {
      try {
        if (openPeer === BROADCAST) {
          await bridge.broadcastMessage(text);
          renderMessage(mkLocal(bridge.agentId, BROADCAST, text, false));
        } else {
          const encrypted = bridge.getKnownAgents().some((a) => a.id === openPeer && a.encPublicKey);
          await bridge.sendTextMessage(openPeer, text);
          renderMessage(mkLocal(bridge.agentId, openPeer, text, encrypted));
        }
      } catch (err) {
        chatLog.add(`{red-fg}failed to send: ${escapeTags((err as Error).message)}{/red-fg}`);
      }
    }
    if (view === 'chat') {
      input.focus();
      screen.render();
    }
  });

  input.key('escape', () => showContacts());
  help.key('escape', () => showContacts());
  contacts.key('?', () => showHelp());

  // Live updates from the network.
  bridge.on('agentDiscovered', (_a: AgentIdentity) => {
    if (view === 'contacts') refreshContacts();
  });

  bridge.on('text', (m: Message) => {
    const isForOpenChat =
      view === 'chat' &&
      ((openPeer !== BROADCAST && m.sender === openPeer && m.recipient === bridge.agentId) ||
        (openPeer === BROADCAST && m.recipient === BROADCAST));
    if (isForOpenChat) {
      renderMessage(m);
      screen.render();
    } else {
      const key = m.recipient === BROADCAST ? BROADCAST : m.sender;
      unread.set(key, (unread.get(key) || 0) + 1);
      if (view === 'contacts') refreshContacts();
    }
  });

  // Untrusted messages never enter a chat — only the Quarantine view.
  bridge.on('quarantine', () => {
    unread.set(QUARANTINE, (unread.get(QUARANTINE) || 0) + 1);
    if (view === 'contacts') refreshContacts();
    else if (view === 'quarantine') void showQuarantine();
  });

  // Global quit.
  screen.key(['q', 'C-c'], async () => {
    screen.destroy();
    await bridge.stop().catch(() => undefined);
    process.exit(0);
  });

  showContacts();
  screen.render();

  // Resolve only when the process exits.
  return new Promise<void>(() => undefined);
}

function mkLocal(sender: string, recipient: string, text: string, encrypted: boolean): Message {
  return {
    id: 'local',
    sender,
    recipient,
    type: 'text' as any,
    content: { text },
    timestamp: new Date(),
    encrypted,
  };
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function textOf(content: any): string {
  if (content && typeof content.text === 'string') return content.text;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function helpText(): string {
  return [
    '{bold}HiveSync — commands & keys{/bold}',
    '',
    '{cyan-fg}Navigation{/cyan-fg}',
    '  ↑ / ↓ / j / k    move in the contacts list',
    '  Enter            open the selected chat',
    '  Esc              back to the contacts list',
    '  ?                show this commands screen',
    '  q  /  Ctrl-C     quit',
    '',
    '{cyan-fg}In a chat{/cyan-fg}',
    '  type + Enter     send a message',
    '  mouse / wheel    scroll history',
    '  🔒               message was end-to-end encrypted',
    '  ✉️                message was sent in plaintext (broadcast or unknown key)',
    '',
    '{cyan-fg}Access control{/cyan-fg}',
    '  Opening an agent asks for {bold}their password{/bold} (kept for this session',
    '  only, never saved). With the right password your messages are trusted',
    '  and trigger execution + an automated reply on their side.',
    '  Messages to you {bold}without{/bold} a valid password are NOT executed — they',
    '  go to {red-fg}🚫 Quarantine{/red-fg} (inert files) for safe review.',
    '',
    '{cyan-fg}Contacts{/cyan-fg}',
    '  Agents are auto-discovered over Waku and appear automatically.',
    '  “📢 Broadcast” is a room everyone on the topic can read.',
    '  A red (n) marks unread messages.',
    '',
    '{gray-fg}Press Esc to go back.{/gray-fg}',
  ].join('\n');
}

function silenceLogger(): void {
  for (const t of logger.transports) {
    (t as any).silent = true;
  }
}
