import * as crypto from 'crypto';

/**
 * Cryptographic primitives for HiveSync.
 *
 * Identity uses two key pairs:
 *  - Ed25519 for message signing / verification (authenticity).
 *  - X25519 for ECDH key agreement, feeding AES-256-GCM (confidentiality).
 *
 * Keys are serialized as base64-encoded DER (SPKI for public, PKCS8 for
 * private) so they survive JSON storage and travel cleanly over the wire.
 * Everything here relies on Node's built-in `crypto` module — no extra deps.
 */

export interface KeyPairB64 {
  publicKey: string;
  privateKey: string;
}

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
  tag: string;
  /** Sender's X25519 public key (base64 DER), needed by the recipient for ECDH. */
  epk: string;
}

const HKDF_INFO = Buffer.from('hivesync/v1/aes-256-gcm');

function exportPub(key: crypto.KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

function exportPriv(key: crypto.KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}

function importPub(b64: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

function importPriv(b64: string): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
}

export function generateSigningKeyPair(): KeyPairB64 {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: exportPub(publicKey), privateKey: exportPriv(privateKey) };
}

export function generateEncryptionKeyPair(): KeyPairB64 {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey: exportPub(publicKey), privateKey: exportPriv(privateKey) };
}

/** Stable short fingerprint of a public key, used as a key id for TOFU pinning. */
export function fingerprint(publicKeyB64: string): string {
  return crypto.createHash('sha256').update(publicKeyB64).digest('base64url').slice(0, 24);
}

export function sign(privateKeyB64: string, data: Buffer): string {
  return crypto.sign(null, data, importPriv(privateKeyB64)).toString('base64');
}

export function verify(publicKeyB64: string, data: Buffer, signatureB64: string): boolean {
  try {
    return crypto.verify(null, data, importPub(publicKeyB64), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

function deriveSharedKey(myEncPrivB64: string, theirEncPubB64: string): Buffer {
  const shared = crypto.diffieHellman({
    privateKey: importPriv(myEncPrivB64),
    publicKey: importPub(theirEncPubB64),
  });
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32));
}

export function encrypt(
  myEncKeyPair: KeyPairB64,
  recipientEncPubB64: string,
  plaintext: Buffer
): EncryptedPayload {
  const key = deriveSharedKey(myEncKeyPair.privateKey, recipientEncPubB64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    epk: myEncKeyPair.publicKey,
  };
}

export function decrypt(myEncPrivB64: string, payload: EncryptedPayload): Buffer {
  const key = deriveSharedKey(myEncPrivB64, payload.epk);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

export interface PasswordHash {
  salt: string;
  hash: string;
}

/**
 * Hash an access password with scrypt. Only the salt + derived hash are stored
 * on disk — the password itself is never persisted and can't be recovered.
 */
export function hashPassword(password: string): PasswordHash {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

/** Constant-time verification of a password against a stored salt+hash. */
export function verifyPassword(password: string, stored: PasswordHash): boolean {
  try {
    const expected = Buffer.from(stored.hash, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(stored.salt, 'base64'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
