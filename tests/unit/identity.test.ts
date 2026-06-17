import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Identity } from '../../src/core/identity';

describe('Identity', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-identity-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('persists keys across loads (stable identity)', () => {
    const first = Identity.loadOrCreate(dir, 'agent-x', 'Agent X');
    const second = Identity.loadOrCreate(dir, 'agent-x', 'Agent X');

    expect(second.signPublicKey).toBe(first.signPublicKey);
    expect(second.encPublicKey).toBe(first.encPublicKey);
    expect(second.keyId).toBe(first.keyId);
  });

  test('writes the identity file with restrictive permissions', () => {
    Identity.loadOrCreate(dir, 'agent-y', 'Agent Y');
    const file = path.join(dir, 'identity-agent-y.json');
    expect(fs.existsSync(file)).toBe(true);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('allows renaming without regenerating keys', () => {
    const first = Identity.loadOrCreate(dir, 'agent-z', 'Old Name');
    const renamed = Identity.loadOrCreate(dir, 'agent-z', 'New Name');
    expect(renamed.agentName).toBe('New Name');
    expect(renamed.keyId).toBe(first.keyId);
  });

  test('ephemeral identities are unique and not written to disk', () => {
    const a = Identity.ephemeral('a', 'A');
    const b = Identity.ephemeral('a', 'A');
    expect(a.keyId).not.toBe(b.keyId);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  test('sign/verify and encrypt/decrypt via identity helpers', () => {
    const alice = Identity.ephemeral('alice', 'Alice');
    const bob = Identity.ephemeral('bob', 'Bob');

    const data = Buffer.from('hello');
    const sig = alice.sign(data);
    expect(bob.verify(alice.signPublicKey, data, sig)).toBe(true);

    const payload = alice.encryptFor(bob.encPublicKey, Buffer.from('secret'));
    expect(bob.decrypt(payload).toString()).toBe('secret');
  });
});
