import * as blessed from 'blessed';
import { BridgeManager } from '../core/bridge-manager';
import { Message, AgentIdentity } from '../types';
import { logger } from './logger';
import { TG, avatarColor, initials, honeycombSmall } from './ascii';

const BROADCAST = 'broadcast';
const QUARANTINE = 'quarantine';
const SIDEBAR_W = 30;

/**
 * A Telegram-Desktop-flavoured terminal messenger over HiveSync.
 *
 * Two persistent panes — a chat list on the left, the open conversation on the
 * right — with a coloured top bar (connection status), monogram "avatars",
 * left/right message bubbles, live search, and modal overlays for help and the
 * per-peer password prompt.
 *
 * Humans get this UI; agents get the same capabilities through the
 * event-driven {@link BridgeManager} API, so this view is purely additive.
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
    autoPadding: true,
    ...screenOptions,
  });

  const unread = new Map<string, number>();
  const lastMsg = new Map<string, string>(); // peer → last message preview
  let view: 'chat' | 'quarantine' | 'empty' = 'empty';
  let openPeer: string | null = null;
  let pendingPeer: string | null = null;
  let filter = '';
  let rowToPeer: string[] = [];

  // ===================================================================== bars
  const topBar = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    height: 1,
    width: '100%',
    tags: true,
    style: { fg: 'white', bg: TG.blueDark },
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    height: 1,
    width: '100%',
    tags: true,
    style: { fg: TG.muted, bg: TG.panel },
  });

  // ================================================================= sidebar
  const sidebar = blessed.box({
    parent: screen,
    top: 1,
    bottom: 1,
    left: 0,
    width: SIDEBAR_W,
    style: { bg: TG.panel },
  });

  const search = blessed.textbox({
    parent: sidebar,
    top: 0,
    left: 0,
    width: SIDEBAR_W,
    height: 1,
    inputOnFocus: true,
    keys: true,
    style: { fg: 'white', bg: TG.ink },
  });

  const chats = blessed.list({
    parent: sidebar,
    top: 1,
    bottom: 0,
    left: 0,
    width: SIDEBAR_W,
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    scrollbar: { ch: ' ', style: { bg: TG.blueDark } } as any,
    style: {
      bg: TG.panel,
      selected: { bg: TG.blueDark, fg: 'white' },
      item: { fg: 'white' },
    },
  });

  // ============================================================== chat pane
  const chatHeader = blessed.box({
    parent: screen,
    top: 1,
    left: SIDEBAR_W,
    right: 0,
    height: 1,
    tags: true,
    style: { fg: 'white', bg: TG.ink },
  });

  const chatLog = blessed.log({
    parent: screen,
    top: 2,
    left: SIDEBAR_W,
    right: 0,
    bottom: 4,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', style: { bg: TG.blueDark } } as any,
    mouse: true,
    keys: true,
    padding: { left: 1, right: 1 },
    style: { bg: TG.ink },
  });

  const input = blessed.textbox({
    parent: screen,
    bottom: 1,
    left: SIDEBAR_W,
    right: 0,
    height: 3,
    border: { type: 'line' },
    label: ' write a message ',
    inputOnFocus: true,
    keys: true,
    mouse: true,
    style: { fg: 'white', bg: TG.ink, border: { fg: TG.blue } },
  });

  // ============================================================== overlays
  const help = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: 64,
    height: 22,
    border: { type: 'line' },
    tags: true,
    padding: { left: 2, right: 2, top: 1 },
    label: ' HiveSync · keys ',
    hidden: true,
    style: { fg: 'white', bg: TG.panel, border: { fg: TG.blue } },
    content: helpText(),
  });

  const pwPrompt = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: 60,
    height: 8,
    border: { type: 'line' },
    tags: true,
    label: ' 🔑 password ',
    hidden: true,
    style: { fg: 'white', bg: TG.panel, border: { fg: TG.blue } },
  });
  const pwLabel = blessed.text({
    parent: pwPrompt,
    top: 0,
    left: 1,
    right: 1,
    height: 3,
    tags: true,
    style: { bg: TG.panel },
  });
  const pwInput = blessed.textbox({
    parent: pwPrompt,
    bottom: 1,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    censor: true,
    keys: true,
    style: { fg: 'white', bg: TG.ink },
  });

  // ===================================================== rendering helpers
  function nameFor(id: string): string {
    if (id === BROADCAST) return 'Hive Broadcast';
    if (id === QUARANTINE) return 'Quarantine';
    const a = bridge.getKnownAgents().find((x) => x.id === id);
    return a ? a.name : id;
  }

  function escapeTags(s: string): string {
    return String(s).replace(/[{}]/g, '');
  }

  function badge(peer: string): string {
    const n = unread.get(peer) || 0;
    return n > 0 ? ` {${TG.blue}-bg}{white-fg} ${n} {/}` : '';
  }

  // One contact "card" — single row (blessed lists count one item per row):
  // a coloured monogram "avatar", the name, and an unread badge.
  function chatRow(id: string, opts: { glyph?: string; color?: string } = {}): string {
    const name = nameFor(id);
    const color = opts.color || avatarColor(name);
    const mono = opts.glyph || initials(name);
    const av = `{${color}-fg}({bold}${mono}{/bold}){/}`;
    const room = SIDEBAR_W - 7; // minus avatar + padding
    const label = escapeTags(name).slice(0, room);
    return `${av} ${label}${badge(id)}`;
  }

  function refreshContacts(): void {
    const q = filter.trim().toLowerCase();
    const agents = bridge
      .getKnownAgents()
      .slice()
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));

    rowToPeer = [];
    const items: string[] = [];

    if (!q) {
      rowToPeer.push(BROADCAST, QUARANTINE);
      items.push(chatRow(BROADCAST, { glyph: '#', color: TG.blueLight }));
      items.push(chatRow(QUARANTINE, { glyph: '!', color: '#E17076' }));
    }

    for (const a of agents) {
      rowToPeer.push(a.id);
      items.push(chatRow(a.id));
    }

    if (agents.length === 0 && q) {
      items.push(`{${TG.muted}-fg}  no matches{/}`);
    } else if (bridge.getKnownAgents().length === 0) {
      items.push(`{${TG.muted}-fg}  listening for agents…{/}`);
    }

    chats.setItems(items);
    screen.render();
  }

  function setFooter(text: string): void {
    footer.setContent(` ${text}`);
  }

  async function refreshTopBar(): Promise<void> {
    let dot = `{${TG.muted}-fg}●{/}`;
    let info = 'connecting…';
    try {
      const s = await bridge.getStatus();
      const peers = s?.hivesync?.peers ?? 0;
      const agents = bridge.getKnownAgents().length;
      dot = s?.hivesync?.connected ? `{${TG.online}-fg}●{/}` : `{red-fg}●{/}`;
      info = `${peers} relay${peers === 1 ? '' : 's'} · ${agents} agent${agents === 1 ? '' : 's'}`;
    } catch {
      /* best-effort */
    }
    topBar.setContent(
      ` ${dot} {bold}HiveSync{/bold}  {/}` +
        `{|}{white-fg}🐝 the hivemind{/}  ` +
        `{${TG.blueLight}-fg}${info}{/} `
    );
    screen.render();
  }

  function wrapText(text: string, width: number): string[] {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      if (para.length === 0) {
        out.push('');
        continue;
      }
      let line = '';
      for (const word of para.split(' ')) {
        if (line.length === 0) line = word;
        else if ((line + ' ' + word).length <= width) line += ' ' + word;
        else {
          out.push(line);
          line = word;
        }
        // hard-break very long words
        while (line.length > width) {
          out.push(line.slice(0, width));
          line = line.slice(width);
        }
      }
      if (line.length) out.push(line);
    }
    return out;
  }

  // Render one message as a Telegram-style bubble inside the chat log.
  function renderMessage(m: Message, showName = false): void {
    const me = m.sender === bridge.agentId;
    const paneW = (chatLog.width as number) || 50;
    const innerW = Math.max(20, paneW - 4);
    const maxContent = Math.max(12, Math.min(56, Math.floor(innerW * 0.62)));

    const text = escapeTags(m.content?.text ?? '');
    const wrapped = wrapText(text, maxContent);
    const t = new Date(m.timestamp);
    const meta = `${pad(t.getHours())}:${pad(t.getMinutes())}${me ? ' ✓' : ''}${m.encrypted ? ' 🔒' : ''}`;

    const contentW = Math.min(
      maxContent,
      Math.max(meta.length, ...wrapped.map((l) => l.length))
    );
    const bubbleW = contentW + 2; // 1 space padding each side
    const bg = me ? TG.bubbleOut : TG.bubbleIn;
    const pad0 = me ? ' '.repeat(Math.max(0, innerW - bubbleW)) : '';

    if (showName && !me) {
      const nm = nameFor(m.sender);
      chatLog.add(`${pad0}{${avatarColor(nm)}-fg}{bold}${escapeTags(nm)}{/bold}{/}`);
    }

    const bubbleLine = (s: string): string =>
      `${pad0}{${bg}-bg}{white-fg} ${s.padEnd(contentW)} {/}`;

    for (const l of wrapped.length ? wrapped : ['']) chatLog.add(bubbleLine(l));
    chatLog.add(`${pad0}{${bg}-bg}{${TG.muted}-fg} ${meta.padStart(contentW)} {/}`);
    chatLog.add(''); // breathing room between bubbles
  }

  function dayDivider(): void {
    const w = ((chatLog.width as number) || 50) - 4;
    const label = ' today ';
    const side = Math.max(0, Math.floor((w - label.length) / 2));
    chatLog.add(`{${TG.muted}-fg}${'─'.repeat(side)}${label}${'─'.repeat(side)}{/}`);
  }

  // ===================================================== view switching
  function showEmptyState(): void {
    view = 'empty';
    openPeer = null;
    chatLog.setContent('');
    chatHeader.setContent(`{${TG.muted}-fg}  no chat selected{/}`);
    input.hide();
    const w = (chatLog.width as number) || 50;
    const art = honeycombSmall();
    const top = Math.max(1, Math.floor(((chatLog.height as number) || 12) / 2) - 4);
    for (let i = 0; i < top; i++) chatLog.add('');
    const center = (s: string): string => ' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s;
    for (const l of art) chatLog.add(`{${TG.blueDeep}-fg}${center(l)}{/}`);
    chatLog.add('');
    chatLog.add(`{${TG.blueLight}-fg}{bold}${center('Welcome to the hive')}{/bold}{/}`);
    chatLog.add(`{${TG.muted}-fg}${center('Pick a chat on the left to start messaging')}{/}`);
    chatLog.scrollTo(0);
    screen.render();
  }

  // Ask for the peer's password (session-only), then open the chat.
  function openAgent(peer: string): void {
    pendingPeer = peer;
    const nm = nameFor(peer);
    pwLabel.setContent(
      `Their password for {${avatarColor(nm)}-fg}{bold}${escapeTags(nm)}{/bold}{/}\n` +
        `{${TG.muted}-fg}Enter to confirm · blank = unauthenticated · Esc to cancel{/}`
    );
    pwInput.clearValue();
    pwPrompt.show();
    pwPrompt.setFront();
    pwInput.focus();
    screen.render();
  }

  async function showQuarantine(): Promise<void> {
    view = 'quarantine';
    openPeer = null;
    unread.set(QUARANTINE, 0);
    input.hide();
    chatLog.setContent('');
    chatHeader.setContent(`{#E17076-fg}{bold} (!) Quarantine{/bold}{/}  {${TG.muted}-fg}untrusted · read-only{/}`);
    const items = await bridge.getQuarantine();
    if (items.length === 0) {
      chatLog.add(`{${TG.muted}-fg}  No quarantined messages.{/}`);
    } else {
      chatLog.add(`{red-fg}{bold}  ⚠ These messages were NOT executed.{/bold}{/}`);
      chatLog.add('');
      for (const q of items) {
        const t = new Date(q.timestamp);
        const time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
        chatLog.add(
          `  {${TG.muted}-fg}${time}{/} {#E17076-fg}${escapeTags(q.sender)}{/} {red-fg}[${escapeTags(q.reason)}]{/}`
        );
        chatLog.add(`    {white-fg}${escapeTags(textOf(q.content))}{/}`);
        chatLog.add('');
      }
    }
    setFooter(`{bold}Esc{/bold} back · files: ${bridge.getQuarantineDir()}`);
    chatLog.scrollTo(0);
    screen.render();
  }

  async function showChat(peer: string): Promise<void> {
    view = 'chat';
    openPeer = peer;
    unread.set(peer, 0);
    chatLog.setContent('');
    input.show();

    const nm = nameFor(peer);
    let status: string;
    if (peer === BROADCAST) {
      status = `{${TG.blueLight}-fg}everyone on the topic · signed, not encrypted{/}`;
    } else {
      const known = bridge.getKnownAgents().some((a) => a.id === peer && a.encPublicKey);
      const enc = known ? `{${TG.online}-fg}🔒 encrypted{/}` : `{red-fg}plaintext (key unknown){/}`;
      const auth = bridge.hasAgentPassword(peer)
        ? `{${TG.online}-fg}🔑 authenticated{/}`
        : `{#E8B339-fg}⚠ no password{/}`;
      status = `${enc} · ${auth}`;
    }
    const av = peer === BROADCAST ? '#' : initials(nm);
    const avColor = peer === BROADCAST ? TG.blueLight : avatarColor(nm);
    chatHeader.setContent(
      ` {${avColor}-fg}({bold}${av}{/bold}){/} {bold}${escapeTags(nm)}{/bold}   {${TG.muted}-fg}${status}{/}`
    );

    const history = peer === BROADCAST ? await bridge.getBroadcasts() : await bridge.getConversation(peer);
    if (history.length) dayDivider();
    history.forEach((m) => renderMessage(m, peer === BROADCAST));
    if (history.length) lastMsg.set(peer, history[history.length - 1].content?.text ?? '');

    setFooter(`{bold}Tab{/bold} type · {bold}Enter{/bold} send · {bold}Esc{/bold} chats · {bold}?{/bold} keys`);
    refreshContacts();
    input.focus();
    chatLog.setScrollPerc(100);
    screen.render();
  }

  function showHelp(): void {
    help.show();
    help.setFront();
    help.focus();
    screen.render();
  }
  function hideHelp(): void {
    help.hide();
    chats.focus();
    screen.render();
  }

  // ===================================================== focus helpers
  function focusList(): void {
    pwPrompt.hide();
    help.hide();
    chats.focus();
    setFooter(`{bold}↑↓{/bold} move · {bold}Enter{/bold} open · {bold}/{/bold} search · {bold}?{/bold} keys · {bold}q{/bold} quit`);
    screen.render();
  }

  // ===================================================== events
  chats.on('select', (_item, index) => {
    const peer = rowToPeer[index];
    if (!peer) return;
    if (peer === QUARANTINE) void showQuarantine();
    else if (peer === BROADCAST) void showChat(BROADCAST);
    else openAgent(peer);
  });

  // Live search filtering.
  search.on('keypress', () => {
    setTimeout(() => {
      filter = (search.getValue() || '').trim();
      refreshContacts();
    }, 0);
  });
  search.key('escape', () => {
    search.clearValue();
    filter = '';
    refreshContacts();
    focusList();
  });
  search.on('submit', () => {
    chats.focus();
    screen.render();
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
    focusList();
  });

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
        lastMsg.set(openPeer, text);
        refreshContacts();
      } catch (err) {
        chatLog.add(`{red-fg}failed to send: ${escapeTags((err as Error).message)}{/}`);
      }
    }
    if (view === 'chat') {
      input.focus();
      chatLog.setScrollPerc(100);
      screen.render();
    }
  });

  input.key('escape', () => focusList());

  // Sidebar / global keys.
  chats.key('/', () => {
    search.focus();
    screen.render();
  });
  chats.key('?', () => showHelp());
  chats.key(['q'], async () => quit());
  chats.key('tab', () => {
    if (view === 'chat') input.focus();
    screen.render();
  });
  input.key('tab', () => focusList());
  help.key(['escape', 'q', '?'], () => hideHelp());
  chatLog.key('escape', () => focusList());

  // ===================================================== live network feed
  bridge.on('agentDiscovered', (_a: AgentIdentity) => {
    refreshContacts();
    void refreshTopBar();
  });

  bridge.on('text', (m: Message) => {
    const isForOpenChat =
      view === 'chat' &&
      ((openPeer !== BROADCAST && m.sender === openPeer && m.recipient === bridge.agentId) ||
        (openPeer === BROADCAST && m.recipient === BROADCAST));
    const key = m.recipient === BROADCAST ? BROADCAST : m.sender;
    lastMsg.set(key, m.content?.text ?? '');
    if (isForOpenChat) {
      renderMessage(m, openPeer === BROADCAST);
      chatLog.setScrollPerc(100);
      screen.render();
    } else {
      unread.set(key, (unread.get(key) || 0) + 1);
    }
    refreshContacts();
  });

  bridge.on('quarantine', () => {
    unread.set(QUARANTINE, (unread.get(QUARANTINE) || 0) + 1);
    if (view === 'quarantine') void showQuarantine();
    else refreshContacts();
  });

  // Global quit + periodic status refresh.
  screen.key(['C-c'], async () => quit());
  const statusTimer = setInterval(() => void refreshTopBar(), 5000);

  async function quit(): Promise<void> {
    clearInterval(statusTimer);
    screen.destroy();
    await bridge.stop().catch(() => undefined);
    process.exit(0);
  }

  // ===================================================== boot
  void refreshTopBar();
  refreshContacts();
  showEmptyState();
  focusList();
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
    '{bold}HiveSync — a terminal hivemind{/bold}',
    '',
    `{${TG.blueLight}-fg}Navigation{/}`,
    '  ↑ ↓ / j k      move through chats',
    '  Enter          open the selected chat',
    '  /              search contacts',
    '  Tab            jump between list ⇄ message box',
    '  Esc            back to the chat list',
    '  ?              this screen   ·   q / Ctrl-C  quit',
    '',
    `{${TG.blueLight}-fg}Messaging{/}`,
    '  type + Enter   send   ·   🔒 end-to-end encrypted',
    '  wheel / drag   scroll history',
    '',
    `{${TG.blueLight}-fg}Access control{/}`,
    '  Opening an agent asks for {bold}their password{/bold} (session-only).',
    '  Right password → your messages are trusted & executed.',
    '  Wrong/none → routed to {#E17076-fg}(!) Quarantine{/} on their side.',
    '',
    `{${TG.muted}-fg}Press Esc to close.{/}`,
  ].join('\n');
}

function silenceLogger(): void {
  for (const t of logger.transports) {
    (t as any).silent = true;
  }
}
