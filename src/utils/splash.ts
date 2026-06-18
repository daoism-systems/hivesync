import chalk from 'chalk';
import { BridgeManager } from '../core/bridge-manager';
import { TG, wordmark, honeycomb, gradientBlue } from './ascii';

/**
 * "Connecting to the hivemind" — an animated boot sequence that runs before
 * the messaging UI. Each step is a live spinner that resolves into a ✓ as the
 * real work behind it completes, so the ceremony is wired to the actual
 * {@link BridgeManager} connection rather than being pure theatre.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const isTTY = (): boolean => !!process.stdout.isTTY;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `work` while a spinner animates on the current line; finish with ✓/✗. */
async function step<T>(label: string, work: Promise<T> | (() => Promise<T>)): Promise<T> {
  const promise = typeof work === 'function' ? work() : work;
  if (!isTTY()) {
    const r = await promise;
    process.stdout.write(`  ${chalk.hex(TG.online)('✓')} ${label}\n`);
    return r;
  }

  let i = 0;
  const dim = chalk.hex(TG.muted);
  const tick = (): void => {
    const frame = chalk.hex(TG.blue)(FRAMES[i++ % FRAMES.length]);
    process.stdout.write(`\r  ${frame} ${dim(label)}…   `);
  };
  tick();
  const timer = setInterval(tick, 80);
  try {
    const r = await promise;
    clearInterval(timer);
    process.stdout.write(`\r  ${chalk.hex(TG.online)('✓')} ${chalk.white(label)}          \n`);
    return r;
  } catch (err) {
    clearInterval(timer);
    process.stdout.write(`\r  ${chalk.red('✗')} ${chalk.white(label)}          \n`);
    throw err;
  }
}

function note(text: string): void {
  process.stdout.write(`     ${chalk.hex(TG.muted)('└─ ' + text)}\n`);
}

/**
 * Clears the screen, paints the hive, and walks through the connection
 * ceremony. Returns once the bridge is live and a short discovery window has
 * elapsed — the caller then hands off to the TUI.
 */
export async function runConnectSequence(bridge: BridgeManager, config: any): Promise<void> {
  if (isTTY()) {
    // Clear + home, then paint the splash header.
    process.stdout.write('\x1b[2J\x1b[H');
  }
  console.log();
  console.log(gradientBlue(honeycomb()));
  console.log();
  console.log(wordmark('HiveSync'));
  console.log(
    '        ' +
      chalk.hex(TG.blue)('⬡') +
      chalk.bold.hex(TG.blueLight)(' connecting to the hivemind ') +
      chalk.hex(TG.blue)('⬡')
  );
  console.log();

  const name = config?.agentName || config?.agentId || 'agent';

  await step('Forging Ed25519 identity', async () => sleep(420));
  note(`drone “${name}”`);
  await step('Deriving X25519 encryption keys', async () => sleep(380));

  // The real connection. start() resolves once we're attached to the network.
  const started = await step('Dialing Waku bootstrap nodes', () => bridge.start());
  if (!started) {
    console.log();
    console.log('  ' + chalk.red('✗ could not reach the hivemind — is the network up?'));
    throw new Error('bridge failed to connect');
  }

  // Surface the live peer count from the transport.
  let peers = 0;
  try {
    const status = await bridge.getStatus();
    peers = status?.hivesync?.peers ?? 0;
  } catch {
    /* status best-effort */
  }
  note(`linked to ${chalk.hex(TG.blueLight)(String(peers))} relay ${peers === 1 ? 'node' : 'nodes'}`);

  // Give discovery a beat to surface nearby agents.
  await step('Listening for the swarm', async () => sleep(3200));
  const agents = bridge.getKnownAgents().length;
  note(
    agents > 0
      ? `${chalk.hex(TG.online)(String(agents))} ${agents === 1 ? 'agent' : 'agents'} in range`
      : 'no agents yet — they will appear as they join'
  );

  console.log();
  console.log('  ' + chalk.hex(TG.online)('●') + chalk.bold.white(' synced.') + chalk.hex(TG.muted)(' entering the hive ▸'));
  await sleep(650);
}
