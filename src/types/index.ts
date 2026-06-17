export interface AgentIdentity {
  id: string;
  name: string;
  /** Ed25519 signing public key (base64 DER). */
  publicKey: string;
  /** X25519 encryption public key (base64 DER), if known. */
  encPublicKey?: string;
  /** Fingerprint of the signing key, pinned per agent (TOFU). */
  keyId?: string;
  createdAt: Date;
  lastSeen?: Date;
}

export interface Message {
  id: string;
  sender: string;
  recipient: string;
  type: MessageType;
  content: any;
  timestamp: Date;
  encrypted: boolean;
  signature?: string;
}

export enum MessageType {
  TEXT = 'text',
  FILE = 'file',
  SYNC_REQUEST = 'sync_request',
  SYNC_RESPONSE = 'sync_response',
  OBSIDIAN_UPDATE = 'obsidian_update',
  COMMAND = 'command',
  ACK = 'ack',
  /** Presence/discovery: "I'm here, here are my public keys". */
  ANNOUNCE = 'announce',
}

/**
 * The on-the-wire frame published to the Waku content topic. JSON-serializable
 * (no Date objects, no Buffers) so it round-trips losslessly.
 */
export interface Envelope {
  v: number;
  id: string;
  from: string;
  to: string;
  type: MessageType;
  ts: number;
  /** Sender's Ed25519 signing public key (base64 DER) — used to verify `sig`. */
  spk: string;
  /** Base64 Ed25519 signature over the canonical envelope bytes. */
  sig: string;
  enc: boolean;
  /** Plaintext content (when enc=false): JSON-stringified payload. */
  body?: string;
  /** Encrypted content (when enc=true). */
  iv?: string;
  ct?: string;
  tag?: string;
  /** Sender's X25519 public key (base64 DER), present on encrypted frames. */
  epk?: string;
}

/** Payload of an ANNOUNCE message — what a peer broadcasts about itself. */
export interface AnnouncePayload {
  agentId: string;
  agentName: string;
  keyId: string;
  signPublicKey: string;
  encPublicKey: string;
}

export interface FileChunk {
  id: string;
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  data: Uint8Array;
  hash: string;
}

export interface ObsidianNote {
  id: string;
  path: string;
  content: string;
  lastModified: Date;
  hash: string;
}

export interface SyncState {
  agentId: string;
  lastSync: Date;
  notesSynced: number;
  conflicts: number;
}

export interface WakuConfig {
  listenAddresses: string[];
  bootstrapNodes: string[];
  /** Waku cluster id (The Waku Network is cluster 1). */
  clusterId: number;
  /** Number of shards in the (auto-sharding) cluster. */
  numShardsInCluster: number;
  /** Application content topic, format: /{app}/{version}/{topic}/{encoding}. */
  contentTopic: string;
  keepAlive: boolean;
  maxPeers: number;
}

export interface ObsidianConfig {
  vaultPath: string;
  enabled: boolean;
}

/**
 * Access control. A peer must include this password (inside the E2E-encrypted
 * message) for its message to be *trusted* — i.e. processed/executed and
 * auto-replied. Only the scrypt salt+hash are stored; the password is never
 * persisted. If `auth` is absent the agent runs in open mode (all messages
 * trusted) for backward compatibility.
 */
export interface AuthConfig {
  /** scrypt salt (base64). */
  salt: string;
  /** scrypt hash of the password (base64). */
  hash: string;
  /** Optional automated reply sent when a trusted message arrives. */
  autoReply?: string;
}

export interface BridgeConfig {
  agentId: string;
  agentName: string;
  storagePath: string;
  waku: WakuConfig;
  /** Discovery announce interval in seconds (<= 0 disables periodic announce). */
  syncInterval: number;
  obsidian?: ObsidianConfig;
  auth?: AuthConfig;
}

/** An untrusted message held in the quarantine folder (never executed). */
export interface QuarantinedMessage {
  id: string;
  sender: string;
  recipient: string;
  type: MessageType;
  content: any;
  timestamp: string;
  encrypted: boolean;
  reason: string;
  quarantinedAt: string;
  file?: string;
}
