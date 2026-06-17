import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  sign,
  verify,
  encrypt,
  decrypt,
  fingerprint,
  hashPassword,
  verifyPassword,
} from '../../src/core/crypto';

describe('crypto', () => {
  describe('signing', () => {
    test('verifies a valid signature', () => {
      const kp = generateSigningKeyPair();
      const data = Buffer.from('the quick brown fox');
      const sig = sign(kp.privateKey, data);
      expect(verify(kp.publicKey, data, sig)).toBe(true);
    });

    test('rejects a tampered payload', () => {
      const kp = generateSigningKeyPair();
      const sig = sign(kp.privateKey, Buffer.from('original'));
      expect(verify(kp.publicKey, Buffer.from('tampered'), sig)).toBe(false);
    });

    test('rejects a signature from another key', () => {
      const a = generateSigningKeyPair();
      const b = generateSigningKeyPair();
      const data = Buffer.from('payload');
      const sig = sign(a.privateKey, data);
      expect(verify(b.publicKey, data, sig)).toBe(false);
    });

    test('does not throw on malformed inputs', () => {
      expect(verify('not-a-key', Buffer.from('x'), 'not-a-sig')).toBe(false);
    });
  });

  describe('encryption (ECDH + AES-256-GCM)', () => {
    test('round-trips a message between two parties', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();
      const plaintext = Buffer.from('top secret coordinates');

      const payload = encrypt(alice, bob.publicKey, plaintext);
      const recovered = decrypt(bob.privateKey, payload);

      expect(recovered.toString()).toBe('top secret coordinates');
      // Ciphertext must not leak the plaintext.
      expect(Buffer.from(payload.ciphertext, 'base64').toString()).not.toContain('secret');
    });

    test('a third party cannot decrypt', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();
      const eve = generateEncryptionKeyPair();
      const payload = encrypt(alice, bob.publicKey, Buffer.from('for bob only'));
      expect(() => decrypt(eve.privateKey, payload)).toThrow();
    });

    test('detects ciphertext tampering via the GCM tag', () => {
      const alice = generateEncryptionKeyPair();
      const bob = generateEncryptionKeyPair();
      const payload = encrypt(alice, bob.publicKey, Buffer.from('integrity'));
      const tampered = { ...payload, ciphertext: Buffer.from('evil-bytes').toString('base64') };
      expect(() => decrypt(bob.privateKey, tampered)).toThrow();
    });
  });

  describe('fingerprint', () => {
    test('is stable and key-specific', () => {
      const kp = generateSigningKeyPair();
      expect(fingerprint(kp.publicKey)).toBe(fingerprint(kp.publicKey));
      expect(fingerprint(kp.publicKey)).not.toBe(fingerprint(generateSigningKeyPair().publicKey));
    });
  });

  describe('password hashing (scrypt)', () => {
    test('verifies the correct password', () => {
      const stored = hashPassword('correct horse battery staple');
      expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    });

    test('rejects the wrong password', () => {
      const stored = hashPassword('s3cret');
      expect(verifyPassword('guess', stored)).toBe(false);
      expect(verifyPassword('', stored)).toBe(false);
    });

    test('uses a random salt (same password hashes differently)', () => {
      const a = hashPassword('same');
      const b = hashPassword('same');
      expect(a.salt).not.toBe(b.salt);
      expect(a.hash).not.toBe(b.hash);
      expect(verifyPassword('same', a)).toBe(true);
      expect(verifyPassword('same', b)).toBe(true);
    });

    test('does not store the password in cleartext', () => {
      const stored = hashPassword('plaintextpw');
      expect(JSON.stringify(stored)).not.toContain('plaintextpw');
    });
  });
});
