/**
 * Self-update (the CD half of issue #3).
 *
 * Every HiveSync instance runs from a git checkout on its own host (Mac
 * laptop, Steam Deck systemd, VPS cron). After a merge to main each host has
 * been updated by hand: pull, install, rebuild, restart. `hivesync update`
 * automates exactly that sequence — and nothing more:
 *
 *   check   git fetch, compare HEAD to <remote>/<branch>
 *   apply   ff-only merge → npm ci → npm run build → optional restart command
 *
 * Deliberate non-goals:
 *  - No mesh-triggered execution. A message on the mesh may ANNOUNCE that an
 *    update exists; it must never cause code to run. Each operator invokes
 *    `hivesync update` (or schedules it) on their own authority.
 *  - No history rewriting. A dirty tree, local commits, or a non-fast-forward
 *    remote are blockers that abort the update — this command never stashes,
 *    resets, or force-pulls an operator's checkout.
 *
 * The restart command (`update.restartCommand` in hivesync.yaml) is operator-
 * controlled config, same trust model as `hooks.onMessage`: run as-is via the
 * shell, with nothing interpolated into it. It is spawned detached so it can
 * restart the daemon (or even this process's own service) without being
 * killed mid-flight.
 */
import { execFile, spawn } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export interface UpdateOptions {
  /** git remote to update from. Default 'origin'. */
  remote?: string;
  /** Branch to follow. Default 'main'. */
  branch?: string;
  /** Shell command run (detached) after a successful update. */
  restartCommand?: string;
}

export interface UpdateCheck {
  repoRoot: string;
  remote: string;
  branch: string;
  currentSha: string;
  remoteSha: string;
  /** Commits on <remote>/<branch> that HEAD does not have. */
  behind: number;
  /** Local commits HEAD has that <remote>/<branch> does not (blocks ff). */
  ahead: number;
  dirty: boolean;
  updateAvailable: boolean;
  /** Human-readable reasons an apply would refuse to run. */
  blockers: string[];
}

export interface UpdateResult {
  updated: boolean;
  fromSha: string;
  toSha: string;
  restartSpawned: boolean;
}

async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', repoRoot, ...args]);
  return stdout.trim();
}

/**
 * The checkout this CLI was built from — resolved from the compiled file's
 * location (dist/core/ → repo root), NOT from cwd, so `hivesync update` always
 * updates the installation that is actually running, wherever it was invoked.
 */
export function defaultRepoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export async function checkForUpdate(
  repoRoot: string,
  opts: UpdateOptions = {}
): Promise<UpdateCheck> {
  const remote = opts.remote ?? 'origin';
  const branch = opts.branch ?? 'main';

  // Fail early with a clear error if this isn't a git checkout at all
  // (e.g. a tarball install — nothing for us to update).
  await git(repoRoot, 'rev-parse', '--git-dir').catch(() => {
    throw new Error(`${repoRoot} is not a git checkout — cannot self-update`);
  });

  await git(repoRoot, 'fetch', '--quiet', remote, branch);

  const ref = `${remote}/${branch}`;
  const currentSha = await git(repoRoot, 'rev-parse', 'HEAD');
  const remoteSha = await git(repoRoot, 'rev-parse', ref);
  const behind = parseInt(await git(repoRoot, 'rev-list', '--count', `HEAD..${ref}`), 10);
  const ahead = parseInt(await git(repoRoot, 'rev-list', '--count', `${ref}..HEAD`), 10);
  const dirty = (await git(repoRoot, 'status', '--porcelain')) !== '';

  const blockers: string[] = [];
  if (dirty) blockers.push('working tree has uncommitted changes');
  if (ahead > 0)
    blockers.push(`HEAD has ${ahead} local commit(s) not on ${ref} (fast-forward impossible)`);

  return {
    repoRoot,
    remote,
    branch,
    currentSha,
    remoteSha,
    behind,
    ahead,
    dirty,
    updateAvailable: behind > 0,
    blockers,
  };
}

/**
 * Fast-forward the checkout to the already-fetched <remote>/<branch>.
 * Split from the npm/build steps so tests can exercise the git safety rules
 * without a full dependency install.
 */
export async function fastForward(check: UpdateCheck): Promise<void> {
  if (check.blockers.length > 0) {
    throw new Error(`refusing to update: ${check.blockers.join('; ')}`);
  }
  await git(check.repoRoot, 'merge', '--ff-only', `${check.remote}/${check.branch}`);
}

/**
 * Apply an available update: ff-only merge, install, rebuild, then spawn the
 * operator's restart command (if configured). `runNpm` exists for tests.
 */
export async function applyUpdate(
  check: UpdateCheck,
  opts: UpdateOptions = {},
  runNpm: boolean = true
): Promise<UpdateResult> {
  if (!check.updateAvailable) {
    return {
      updated: false,
      fromSha: check.currentSha,
      toSha: check.currentSha,
      restartSpawned: false,
    };
  }

  await fastForward(check);

  if (runNpm) {
    const npmEnv = { ...process.env, HUSKY: '0' };
    await execFileP('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: check.repoRoot,
      env: npmEnv,
      maxBuffer: 32 * 1024 * 1024,
    });
    await execFileP('npm', ['run', 'build'], {
      cwd: check.repoRoot,
      env: npmEnv,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  let restartSpawned = false;
  if (opts.restartCommand) {
    // Detached + unref: the restart may well terminate this very process
    // (systemd restart of the service that ran us) — it must survive our exit.
    const child = spawn(opts.restartCommand, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      cwd: check.repoRoot,
    });
    child.unref();
    restartSpawned = true;
  }

  return {
    updated: true,
    fromSha: check.currentSha,
    toSha: check.remoteSha,
    restartSpawned,
  };
}
