import * as fs from 'fs';
import * as path from 'path';
import {
  KeyPairB64,
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  fingerprint,
  sign,
  verify,
  encrypt,
  decrypt,
  EncryptedPayload,
} from './crypto';

/**
 * A HiveSync agent's stable, on-disk identity.
 *
 * `agentId` is the human/config-chosen routing address. `keyId` is the
 * fingerprint of the signing key and is what we pin per agent (TOFU) so a
 * stolen/forged `agentId` can't be impersonated without the matching key.
 */
export interface IdentityFile {
  agentId: string;
  agentName: string;
  signing: KeyPairB64;
  encryption: KeyPairB64;
  createdAt: string;
}

export class Identity {
  readonly agentId: string;
  readonly agentName: string;
  readonly keyId: string;
  private readonly signing: KeyPairB64;
  private readonly encryption: KeyPairB64;
  readonly createdAt: Date;

  private constructor(file: IdentityFile) {
    this.agentId = file.agentId;
    this.agentName = file.agentName;
    this.signing = file.signing;
    this.encryption = file.encryption;
    this.keyId = fingerprint(file.signing.publicKey);
    this.createdAt = new Date(file.createdAt);
  }

  get signPublicKey(): string {
    return this.signing.publicKey;
  }

  get encPublicKey(): string {
    return this.encryption.publicKey;
  }

  /**
   * Load the identity for `agentId` from `dir`, creating and persisting a fresh
   * one if none exists. Keeping keys on disk is what makes an agent's identity
   * stable across restarts.
   */
  static loadOrCreate(dir: string, agentId: string, agentName: string): Identity {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, `identity-${sanitize(agentId)}.json`);

    if (fs.existsSync(filePath)) {
      const file = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as IdentityFile;
      // Allow renaming an agent without regenerating keys.
      if (file.agentName !== agentName) {
        file.agentName = agentName;
        fs.writeFileSync(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
      }
      return new Identity(file);
    }

    const file: IdentityFile = {
      agentId,
      agentName,
      signing: generateSigningKeyPair(),
      encryption: generateEncryptionKeyPair(),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
    return new Identity(file);
  }

  /** In-memory identity, used by tests that don't want to touch disk. */
  static ephemeral(agentId: string, agentName: string): Identity {
    return new Identity({
      agentId,
      agentName,
      signing: generateSigningKeyPair(),
      encryption: generateEncryptionKeyPair(),
      createdAt: new Date().toISOString(),
    });
  }

  sign(data: Buffer): string {
    return sign(this.signing.privateKey, data);
  }

  verify(signPublicKeyB64: string, data: Buffer, signatureB64: string): boolean {
    return verify(signPublicKeyB64, data, signatureB64);
  }

  encryptFor(recipientEncPublicKeyB64: string, plaintext: Buffer): EncryptedPayload {
    return encrypt(this.encryption, recipientEncPublicKeyB64, plaintext);
  }

  decrypt(payload: EncryptedPayload): Buffer {
    return decrypt(this.encryption.privateKey, payload);
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_');
}
