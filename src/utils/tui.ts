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
 * left/right message bubbles, live search, and modal overlays for help and
 * incoming handshake approval requests.
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
    // Merge adjacent box borders so junctions render as single clean glyphs
    // instead of leaving stray coloured cells where two borders meet.
    dockBorders: true,
    ...screenOptions,
  });

  screen.program.alternateBuffer();
  screen.program.clear();
  screen.enableMouse();

  // Debounced render: network events (agentDiscovered, text bursts) can fire
  // many times in one tick. Repainting synchronously on each one paints partial
  // frames — the source of stray, differently-coloured cells. Coalesce them into
  // a single repaint on the next tick instead.
  let renderPending = false;
  function schedRender(): void {
    if (renderPending) return;
    renderPending = true;
    setImmediate(() => {
      renderPending = false;
      screen.render();
    });
  }

  // Recompute layout cleanly after a terminal resize (debounced).
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  screen.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      screen.render();
    }, 150);
  });

  const unread = new Map<string, number>();
  const lastMsg = new Map<string, string>(); // peer → last message preview
  let view: 'chat' | 'quarantine' | 'empty' = 'empty';
  let openPeer: string | null = null;
  let filter = '';
  let rowToPeer: string[] = [];
  // Messages rendered in the currently-open chat, kept so we can redraw when a
  // delivery receipt (ACK) upgrades a ✓ to ✓✓.
  let shown: Message[] = [];
  let shownBroadcast = false;
  const delivered = new Set<string>();

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
    vi: true,
    mouse: true,
    style: { fg: 'white', bg: TG.ink, border: { fg: TG.blue } },
  });

  // blessed's textbox cannot move the cursor mid-line: its keypress handler
  // has a literal no-op for the arrow keys (see "TODO: Handle directional
  // keys" in node_modules/blessed/lib/widgets/textarea.js) and always anchors
  // the cursor to the end of the buffer. We layer a minimal single-line cursor
  // editor on top so left/right (and home/end/delete) edit at the caret.
  {
    const ib = input as any;
    ib._cursor = 0; // caret offset into ib.value (0..length)

    // Re-render the visible slice and place the terminal cursor at the caret,
    // scrolling horizontally so the caret is always on screen.
    ib._updateCursor = function (this: any): void {
      if (this.screen.focused !== this) return;
      const lpos = this._getCoords();
      if (!lpos) return;
      const value: string = this.value || '';
      this._cursor = Math.max(0, Math.min(this._cursor ?? value.length, value.length));
      const win = Math.max(1, (this.width as number) - this.iwidth - 1);
      let start: number = this._scroll || 0;
      if (this._cursor < start) start = this._cursor;
      if (this._cursor > start + win) start = this._cursor - win;
      this._scroll = start;
      const shown = value.slice(start, start + win + 1);
      this.setContent(this.censor ? Array(shown.length + 1).join('*') : shown);
      const cy = lpos.yi + this.itop;
      const cx = lpos.xi + this.ileft + (this._cursor - start);
      const program = this.screen.program;
      if (cy !== program.y || cx !== program.x) program.cup(cy, cx);
    };

    ib._listener = function (this: any, ch: string, key: any): void {
      const value: string = this.value || '';
      const c: number = Math.max(0, Math.min(this._cursor ?? value.length, value.length));
      if (key.name === 'return') return;
      if (key.name === 'enter') return this._done(null, this.value);
      if (key.name === 'escape') return this._done(null, null);
      if (key.name === 'up' || key.name === 'down') return;
      if (key.name === 'left') {
        this._cursor = Math.max(0, c - 1);
      } else if (key.name === 'right') {
        this._cursor = Math.min(value.length, c + 1);
      } else if (key.name === 'home') {
        this._cursor = 0;
      } else if (key.name === 'end') {
        this._cursor = value.length;
      } else if (key.name === 'backspace') {
        if (c > 0) {
          this.value = value.slice(0, c - 1) + value.slice(c);
          this._cursor = c - 1;
        }
      } else if (key.name === 'delete') {
        if (c < value.length) this.value = value.slice(0, c) + value.slice(c + 1);
      } else if (ch) {
        const cp = ch.codePointAt(0) || 0;
        if (cp >= 32 && cp !== 127) {
          this.value = value.slice(0, c) + ch + value.slice(c);
          this._cursor = c + 1;
        }
      }
      this._updateCursor();
      this.screen.render();
    };

    // Start the caret at the end of whatever is in the box each time it focuses.
    input.on('focus', () => {
      ib._cursor = (ib.value || '').length;
    });
  }

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

  // Modal asking the user to approve/deny an incoming handshake request. A peer
  // can't send us trusted messages until we approve their handshake here.
  const approvalQueue: Array<{ agentId: string; agentName: string; capabilities: string[] }> = [];
  const approval = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: 64,
    height: 11,
    border: { type: 'line' },
    tags: true,
    label: ' 🤝 handshake request ',
    hidden: true,
    style: { fg: 'white', bg: TG.panel, border: { fg: TG.blue } },
  });
  const approvalLabel = blessed.text({
    parent: approval,
    top: 1,
    left: 2,
    right: 2,
    height: 5,
    tags: true,
    style: { bg: TG.panel },
  });
  // approvalHint — rendered as child of approval box, not directly referenced
  void blessed.text({
    parent: approval,
    bottom: 1,
    left: 2,
    right: 2,
    height: 1,
    tags: true,
    content: `{${TG.online}-fg}{bold}y{/bold} approve{/}   {#E17076-fg}{bold}n{/bold} deny{/}   {${TG.muted}-fg}Esc later{/}`,
    style: { bg: TG.panel },
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
    // Coalesce rapid network-driven updates into one repaint to avoid the
    // partial-frame colour artifacts that synchronous per-event renders cause.
    schedRender();
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

  // Re-render every bubble in the open chat from `shown` (used after a delivery
  // receipt flips a checkmark, so we don't have to mutate individual lines).
  function redrawChat(): void {
    chatLog.setContent('');
    if (shown.length) dayDivider();
    shown.forEach((m) => renderMessage(m, shownBroadcast, true));
    chatLog.setScrollPerc(100);
    screen.render();
  }

  // Render one message as a Telegram-style bubble inside the chat log.
  function renderMessage(m: Message, showName = false, replaying = false): void {
    const me = m.sender === bridge.agentId;
    const paneW = (chatLog.width as number) || 50;
    const innerW = Math.max(20, paneW - 4);
    const maxContent = Math.max(12, Math.min(56, Math.floor(innerW * 0.62)));

    // Remember live/new messages so a later ACK can trigger a faithful redraw.
    if (!replaying) shown.push(m);

    const text = escapeTags(m.content?.text ?? '');
    const wrapped = wrapText(text, maxContent);
    const t = new Date(m.timestamp);
    // For our own messages: ✓ = sent, ✓✓ = delivered (peer ACK received).
    const receipt = me ? (delivered.has(m.id) ? ' ✓✓' : ' ✓') : '';
    const route = me ? `→ ${m.recipient}` : `${m.sender} →`;
    const meta = `${pad(t.getHours())}:${pad(t.getMinutes())} ${route}${receipt}${m.encrypted ? ' 🔒' : ''}`;

    const contentW = Math.min(
      maxContent,
      Math.max(meta.length, ...wrapped.map((l) => l.length))
    );
    const bubbleW = contentW + 2; // 1 space padding each side
    const bg = me ? TG.imBlue : TG.imGreen;
    const pad0 = me ? ' '.repeat(Math.max(0, innerW - bubbleW)) : '';

    // Pad every line out to the full inner width with trailing spaces. blessed's
    // diff renderer only repaints the cells a line actually writes, so a short
    // coloured bubble leaves the cells to its right "untouched" — on scroll or
    // redraw those stale cells keep their old bubble background, which is the
    // green/blue smear. Writing real spaces across the whole row forces every
    // cell to be rewritten each render, so nothing bleeds.
    const fill = (visibleWidth: number): string => ' '.repeat(Math.max(0, innerW - visibleWidth));

    if (showName && !me) {
      const nm = nameFor(m.sender);
      const shownName = escapeTags(nm).slice(0, contentW);
      chatLog.add(
        `${pad0}{${avatarColor(nm)}-fg}{bold}${shownName}{/bold}{/}${fill(pad0.length + shownName.length)}`
      );
    }

    const bubbleLine = (s: string): string =>
      `${pad0}{${bg}-bg}{white-fg} ${s.padEnd(contentW)} {/}${fill(pad0.length + bubbleW)}`;

    for (const l of wrapped.length ? wrapped : ['']) chatLog.add(bubbleLine(l));
    // The meta line (time · ✓ · lock) sits on the coloured bubble, so use a
    // plain white fg — TG.muted grey is unreadable on both the green outgoing
    // and blue incoming backgrounds.
    chatLog.add(`${pad0}{${bg}-bg}{white-fg} ${meta.padStart(contentW)} {/}${fill(pad0.length + bubbleW)}`);
    chatLog.add(' '.repeat(innerW)); // breathing room between bubbles
  }

  function dayDivider(): void {
    const w = ((chatLog.width as number) || 50) - 4;
    const label = ' today ';
    const side = Math.max(0, Math.floor((w - label.length) / 2));
    const bar = `${'─'.repeat(side)}${label}${'─'.repeat(side)}`;
    chatLog.add(`{${TG.muted}-fg}${bar}{/}${' '.repeat(Math.max(0, w - bar.length))}`);
  }

  // ===================================================== view switching
  function showEmptyState(): void {
    view = 'empty';
    openPeer = null;
    shown = [];
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

  function openAgent(peer: string): void {
    void showChat(peer);
  }

  async function showQuarantine(): Promise<void> {
    view = 'quarantine';
    openPeer = null;
    shown = [];
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
    shown = [];
    shownBroadcast = peer === BROADCAST;
    input.show();

    const nm = nameFor(peer);
    let status: string;
    if (peer === BROADCAST) {
      status = `{${TG.blueLight}-fg}everyone on the topic · signed, not encrypted{/}`;
    } else {
      const known = bridge.getKnownAgents().some((a) => a.id === peer && a.encPublicKey);
      status = known ? `{${TG.online}-fg}🔒 encrypted{/}` : `{red-fg}plaintext (key unknown){/}`;
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

  // --- handshake approval modal ------------------------------------------

  // While a chat is open the message box runs in blessed's `inputOnFocus`
  // "reading" mode, which sets screen.grabKeys = true and funnels every keypress
  // into the textbox. A modal that merely calls .focus() doesn't escape that —
  // blessed's own blur→rewindFocus bounces focus straight back to the box, so
  // `y`/`n` get typed into the draft instead of approving. Tear the read down
  // first: this releases grabKeys and lets rewindFocus settle on the chat list,
  // after which the modal can take focus cleanly. The half-typed draft is kept.
  function releaseInput(): void {
    const ib = input as any;
    if (ib._reading && typeof ib._done === 'function') ib._done(null, null);
  }

  // Return focus to wherever the user was once the approval queue drains.
  function restoreFocusAfterApproval(): void {
    if (view === 'chat') {
      input.show();
      input.focus();
    } else {
      focusList();
    }
    screen.render();
  }

  function showNextApproval(): void {
    const next = approvalQueue[0];
    if (!next) {
      approval.hide();
      restoreFocusAfterApproval();
      return;
    }
    const caps = next.capabilities.length ? next.capabilities.join(', ') : 'none';
    approvalLabel.setContent(
      `{bold}${escapeTags(next.agentName)}{/bold} {${TG.muted}-fg}(${escapeTags(next.agentId)}){/}\n` +
        `wants to start chatting with you.\n\n` +
        `{${TG.muted}-fg}capabilities:{/} ${escapeTags(caps)}`
    );
    // End any in-progress textbox read and explicitly drop grabKeys, otherwise
    // blessed keeps funneling every keypress into the chat draft and the modal's
    // y/n never fire (the "press y does nothing" bug, esp. on macOS terminals).
    releaseInput();
    (screen as any).grabKeys = false;
    (screen.program as any).grabKeys = false;
    approval.show();
    approval.setFront();
    approval.focus();
    screen.render();
  }

  function resolveApproval(approved: boolean): void {
    const current = approvalQueue.shift();
    if (current) {
      const action = approved
        ? bridge.approveHandshake(current.agentId)
        : bridge.denyHandshake(current.agentId);
      void action.catch(() => undefined);
    }
    showNextApproval();
  }

  // Bind at the SCREEN level (not the element) so the keys fire reliably across
  // blessed builds/terminals regardless of which element holds focus. Gate on
  // the modal being visible so a `y` typed in a normal chat can't approve a
  // queued/deferred request (while a chat input is reading, blessed funnels the
  // keys to the textbox and these don't fire anyway).
  screen.key(['y', 'Y'], () => {
    if (!approval.hidden) resolveApproval(true);
  });
  screen.key(['n', 'N'], () => {
    if (!approval.hidden) resolveApproval(false);
  });
  screen.key('escape', () => {
    if (approval.hidden) return;
    // Defer the decision — keep it queued so the CLI/`approve` can handle it.
    approval.hide();
    restoreFocusAfterApproval();
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
          const { id: msgId } = await bridge.sendTextMessage(openPeer, text);
          const local = mkLocal(bridge.agentId, openPeer, text, encrypted);
          // Use the real message id so the peer's ACK upgrades ✓ → ✓✓.
          if (msgId) local.id = msgId;
          renderMessage(local);
        }
        lastMsg.set(openPeer, text);
        refreshContacts();
      } catch (err) {
        chatLog.add(`{red-fg}failed to send: ${escapeTags((err as Error).message)}{/}`);
      }
    }
    if (view === 'chat') {
      // Defer the refocus: blessed's submit handling (with inputOnFocus) tears
      // down and rewinds focus on this same tick. Refocusing synchronously here
      // races that teardown and leaves a second keypress listener attached — the
      // cause of every character being typed twice after the first send.
      chatLog.setScrollPerc(100);
      screen.render();
      setImmediate(() => {
        if (view === 'chat') input.focus();
      });
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

  // --- scroll-artifact fix -------------------------------------------------
  // blessed scrolls with terminal CSR/insert-line sequences that fill the
  // newly exposed rows with the terminal's DEFAULT background, not the widget's
  // (the classic "bce" smear). With smartCSR on, scrolling our colour-heavy
  // chat log leaves streaks of stale bubble background behind. Forcing a full
  // reallocation + repaint after a scroll rewrites every cell, clearing them.
  // Debounced so a wheel burst coalesces into one redraw (no flicker).
  let scrollRedraw: ReturnType<typeof setTimeout> | null = null;
  const repaintAfterScroll = (): void => {
    if (scrollRedraw) clearTimeout(scrollRedraw);
    scrollRedraw = setTimeout(() => {
      scrollRedraw = null;
      screen.realloc(); // drop the diff cache so every cell is repainted
      screen.render();
    }, 40);
  };
  chatLog.on('scroll', repaintAfterScroll);
  chats.on('scroll', repaintAfterScroll);

  // --- copy/paste ---------------------------------------------------------
  // Mouse tracking lets the terminal scroll/click, but it also swallows native
  // click-drag selection, so text can't be copied. Ctrl-X toggles mouse capture
  // off: while off, select with the mouse and copy as usual, then toggle back.
  let mouseOn = true;
  function toggleMouse(): void {
    mouseOn = !mouseOn;
    if (mouseOn) screen.program.enableMouse();
    else screen.program.disableMouse();
    setFooter(
      mouseOn
        ? `{${TG.muted}-fg}mouse on · {bold}Ctrl-X{/bold} to select & copy text{/}`
        : `{${TG.online}-fg}📋 select-and-copy mode — drag to select · {bold}Ctrl-X{/bold} to resume{/}`
    );
    screen.render();
  }
  screen.key(['C-x'], () => toggleMouse());

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

  // Delivery receipt: the peer ACKed one of our messages → flip ✓ to ✓✓.
  bridge.on('ack', (originalMessageId: string) => {
    if (delivered.has(originalMessageId)) return;
    delivered.add(originalMessageId);
    if (view === 'chat' && shown.some((m) => m.id === originalMessageId)) redrawChat();
  });

  bridge.on('quarantine', () => {
    unread.set(QUARANTINE, (unread.get(QUARANTINE) || 0) + 1);
    if (view === 'quarantine') void showQuarantine();
    else refreshContacts();
  });

  // A peer wants to handshake — ask the user to approve before they're trusted.
  bridge.on(
    'handshakeApprovalNeeded',
    (info: { agentId: string; agentName: string; capabilities: string[] }) => {
      if (approvalQueue.some((a) => a.agentId === info.agentId)) return;
      approvalQueue.push(info);
      if (!approval.hidden) return; // already showing one; this is queued
      showNextApproval();
    }
  );

  // Global quit + periodic status refresh.
  screen.key(['C-c'], async () => quit());
  const statusTimer = setInterval(() => void refreshTopBar(), 5000);

  async function quit(): Promise<void> {
    clearInterval(statusTimer);
    if (resizeTimer) clearTimeout(resizeTimer);
    screen.program.normalBuffer();
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

  // Surface any handshake requests that arrived before this view attached its
  // listener (emitted once during bridge.start()).
  void bridge
    .getPendingApprovals()
    .then((pending) => {
      for (const p of pending) {
        if (!approvalQueue.some((a) => a.agentId === p.agentId)) {
          approvalQueue.push({ agentId: p.agentId, agentName: p.agentName, capabilities: p.capabilities });
        }
      }
      if (approvalQueue.length && approval.hidden) showNextApproval();
    })
    .catch(() => undefined);

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
    '  wheel          scroll history',
    '  ✓ sent  ·  ✓✓ delivered (peer acknowledged)',
    '  Ctrl-X         select-and-copy mode (frees the mouse)',
    '',
    `{${TG.blueLight}-fg}Access control{/}`,
    '  New agents must complete a {bold}handshake{/bold} you approve.',
    '  On a request: {bold}y{/bold} approve · {bold}n{/bold} deny.',
    '  Until approved, their messages wait in {#E17076-fg}(!) Quarantine{/}.',
    '',
    `{${TG.muted}-fg}Press Esc to close.{/}`,
  ].join('\n');
}

function silenceLogger(): void {
  for (const t of logger.transports) {
    (t as any).silent = true;
  }
}
