import chalk from 'chalk';
import figlet from 'figlet';

/**
 * Visual identity for HiveSync — a Telegram-Desktop-flavoured palette
 * (Telegram blue), honeycomb/hive ASCII art, and small helpers shared by the
 * banner, the connect splash, and the TUI.
 */

// --- Telegram-ish palette -------------------------------------------------
export const TG = {
  blue: '#2AABEE', // primary accent (Telegram logo blue)
  blueLight: '#54C3F4',
  blueDeep: '#229ED9',
  blueDark: '#0088CC',
  ink: '#17212B', // Telegram dark chat background
  panel: '#0E1621', // sidebar background
  bubbleIn: '#182533', // incoming bubble
  bubbleOut: '#2B5278', // outgoing bubble (Telegram dark theme)
  muted: '#6D7F8F',
  online: '#4FAE4E',
};

// Vertical blue gradient used for multi-line art.
const GRADIENT = [TG.blueLight, TG.blue, TG.blueDeep, TG.blueDark];

/** Colour each line of a block with a top→bottom blue gradient. */
export function gradientBlue(block: string): string {
  const lines = block.split('\n');
  return lines
    .map((line, i) => chalk.hex(GRADIENT[Math.min(i, GRADIENT.length - 1)])(line))
    .join('\n');
}

/** A compact honeycomb — the hive the agents plug into. */
export function honeycomb(): string {
  return [
    '          __     __     __          ',
    '         /  \\__ /  \\__ /  \\         ',
    '         \\__/  \\__/  \\__/  \\        ',
    '         /  \\__/  \\__/  \\__/        ',
    '         \\__/  \\__/  \\__/  \\        ',
    '            \\__/  \\__/  \\__/        ',
  ].join('\n');
}

/** Tiny honeycomb tile for the "select a chat" empty state. */
export function honeycombSmall(): string[] {
  return [
    ' __     __     __ ',
    '/  \\__ /  \\__ /  \\',
    '\\__/  \\__/  \\__/  ',
    '/  \\__/  \\__/  \\__',
    '\\__/  \\__/  \\__/  ',
  ];
}

/**
 * The big wordmark for the banner / splash. figlet renders the type;
 * we paint it with the blue gradient.
 */
export function wordmark(text = 'HiveSync'): string {
  const art = figlet.textSync(text, { font: 'ANSI Shadow' as any });
  return gradientBlue(art);
}

// --- avatars --------------------------------------------------------------
// Stable per-name accent colour, so each contact keeps the same "avatar".
const AVATAR_COLORS = ['#E17076', '#7BC862', '#65AADD', '#A695E7', '#EE7AAE', '#6EC9CB', '#FAA774'];

export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Up-to-two-letter monogram for a name, like Telegram's circular avatars. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s_\-.]+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** The themed banner printed for non-TUI commands. */
export function printBanner(): void {
  console.log();
  console.log(wordmark('HiveSync'));
  const tag =
    chalk.hex(TG.blue)('  ⬡ ') +
    chalk.bold.white('P2P comms for the agent hivemind') +
    chalk.hex(TG.muted)('  ·  ') +
    chalk.hex(TG.blueLight)('🔒 e2e-encrypted') +
    chalk.hex(TG.muted)('  ·  ') +
    chalk.hex(TG.blueLight)('🐝 Waku swarm');
  console.log(tag);
  console.log(chalk.hex(TG.muted)('  ' + '─'.repeat(54)));
  console.log();
}
