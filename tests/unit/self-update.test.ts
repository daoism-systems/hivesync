import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyUpdate, checkForUpdate, fastForward } from '../../src/core/self-update';

/**
 * Exercises the git safety rules against real (temp) repositories: a bare
 * "origin" and a clone playing the role of a host's checkout. The npm/build
 * steps are skipped (runNpm=false) — they belong to the host, not the rules.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

function commitFile(repo: string, name: string, contents: string, message: string): string {
  fs.writeFileSync(path.join(repo, name), contents);
  git(repo, 'add', name);
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('self-update', () => {
  let dir: string;
  let origin: string; // bare remote
  let upstream: string; // working clone used to push new "releases"
  let checkout: string; // the host checkout under test

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-update-'));
    origin = path.join(dir, 'origin.git');
    upstream = path.join(dir, 'upstream');
    checkout = path.join(dir, 'checkout');

    execFileSync('git', ['init', '--bare', '--initial-branch=main', origin]);
    execFileSync('git', ['clone', origin, upstream], { stdio: 'ignore' });
    git(upstream, 'config', 'user.email', 'test@hivesync');
    git(upstream, 'config', 'user.name', 'test');
    commitFile(upstream, 'a.txt', 'v1', 'v1');
    git(upstream, 'push', 'origin', 'main');

    execFileSync('git', ['clone', origin, checkout], { stdio: 'ignore' });
    git(checkout, 'config', 'user.email', 'test@hivesync');
    git(checkout, 'config', 'user.name', 'test');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function pushRelease(name: string): string {
    const sha = commitFile(upstream, 'a.txt', name, name);
    git(upstream, 'push', 'origin', 'main');
    return sha;
  }

  it('reports up to date when HEAD matches the remote', async () => {
    const check = await checkForUpdate(checkout);
    expect(check.updateAvailable).toBe(false);
    expect(check.behind).toBe(0);
    expect(check.blockers).toEqual([]);
    expect(check.currentSha).toBe(check.remoteSha);
  });

  it('detects an available update and applies it as a fast-forward', async () => {
    const v2 = pushRelease('v2');

    const check = await checkForUpdate(checkout);
    expect(check.updateAvailable).toBe(true);
    expect(check.behind).toBe(1);
    expect(check.remoteSha).toBe(v2);

    const result = await applyUpdate(check, {}, false);
    expect(result.updated).toBe(true);
    expect(result.toSha).toBe(v2);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(v2);
    expect(fs.readFileSync(path.join(checkout, 'a.txt'), 'utf-8')).toBe('v2');
  });

  it('is a no-op when already up to date', async () => {
    const check = await checkForUpdate(checkout);
    const result = await applyUpdate(check, {}, false);
    expect(result.updated).toBe(false);
    expect(result.toSha).toBe(check.currentSha);
  });

  it('blocks on a dirty working tree and never touches it', async () => {
    pushRelease('v2');
    fs.writeFileSync(path.join(checkout, 'a.txt'), 'local edit');

    const check = await checkForUpdate(checkout);
    expect(check.updateAvailable).toBe(true);
    expect(check.dirty).toBe(true);
    expect(check.blockers.length).toBeGreaterThan(0);

    await expect(fastForward(check)).rejects.toThrow(/refusing to update/);
    expect(fs.readFileSync(path.join(checkout, 'a.txt'), 'utf-8')).toBe('local edit');
  });

  it('blocks on local commits (fast-forward impossible)', async () => {
    pushRelease('v2');
    commitFile(checkout, 'local.txt', 'mine', 'local work');

    const check = await checkForUpdate(checkout);
    expect(check.ahead).toBe(1);
    expect(check.blockers.some((b) => b.includes('local commit'))).toBe(true);
    await expect(fastForward(check)).rejects.toThrow(/refusing to update/);
  });

  it('rejects a non-git directory with a clear error', async () => {
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain);
    await expect(checkForUpdate(plain)).rejects.toThrow(/not a git checkout/);
  });
});
