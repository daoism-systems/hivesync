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
  /** Handshake: sent on first discovery to negotiate capabilities/trust. */
  HANDSHAKE_INIT = 'handshake_init',
  /** Handshake: response to a HANDSHAKE_INIT. */
  HANDSHAKE_ACK = 'handshake_ack',
}

/** Lifecycle of a handshake with a peer. */
export type HandshakeStatus = 'none' | 'pending' | 'confirmed' | 'failed';

/** Payload of a HANDSHAKE_INIT message — sent on first discovery. */
export interface HandshakeInitPayload {
  agentName: string;
  agentVersion: string;
  capabilities: string[];
  timestamp: number;
}

/** Payload of a HANDSHAKE_ACK message — response to a HANDSHAKE_INIT. */
export interface HandshakeAckPayload {
  accepted: boolean;
  agentName: string;
  agentVersion: string;
  capabilities: string[];
  timestamp: number;
  reason?: string; // "pending_approval" when user approval is needed
}

/** A handshake request awaiting (or having received) the local user's decision. */
export interface HandshakeApproval {
  id: string;
  agentId: string;
  agentName: string;
  capabilities: string[];
  status: 'pending' | 'approved' | 'denied';
  createdAt: Date;
  respondedAt?: Date;
}

/** A peer with a completed (or in-progress) handshake. */
export interface Contact {
  id: string;
  name: string;
  capabilities: string[];
  handshakeStatus: HandshakeStatus;
  handshakeConfirmedAt?: Date;
  lastSeen?: Date;
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
  /**
   * Transport mode.
   * - 'light' (default): connect out to the public Waku fleet (LightPush +
   *   Filter + Store). Zero infra, but publishing depends on a public service
   *   node accepting our push — unreliable on some hosts/networks over time.
   * - 'relay': run a GossipSub relay node and connect all agents to a common
   *   reachable hub (one VPS listening on an open port). One connected mesh,
   *   no LightPush, no public-fleet dependency, no RLN. Reliable for 2-3 agents.
   */
  mode?: 'light' | 'relay';
  listenAddresses: string[];
  bootstrapNodes: string[];
  /**
   * Multiaddresses to dial on startup. In 'relay' mode this is how spokes reach
   * the hub, e.g. ['/ip4/1.2.3.4/tcp/443/ws/p2p/16Uiu2HA...'].
   */
  directPeers: string[];
  /** Waku cluster id (The Waku Network is cluster 1). */
  clusterId: number;
  /** Number of shards in the (auto-sharding) cluster. */
  numShardsInCluster: number;
  /** Application content topic, format: /{app}/{version}/{topic}/{encoding}. */
  contentTopic: string;
  keepAlive: boolean;
  maxPeers: number;
  /**
   * Optional TLS cert/key (PEM file paths) so a relay hub can listen over
   * secure WebSocket (wss) — needed when the dial path requires TLS (e.g. a
   * domain behind a proxy that TLS-terminates). Used only in relay mode with a
   * `/tls/ws` listen address.
   */
  tls?: { certPath: string; keyPath: string };
  /**
   * How many LightPush service nodes to send each message to in parallel.
   * The SDK default is 1, which fails entirely if that one peer can't relay
   * (status 505 NO_PEERS) or its stream is reset. Defaults to 3 here. Raise it
   * on flaky networks; a single accepting peer is enough for delivery.
   */
  lightPushPeers?: number;
}

export interface ObsidianConfig {
  vaultPath: string;
  enabled: boolean;
}

export interface BridgeConfig {
  agentId: string;
  agentName: string;
  storagePath: string;
  syncInterval: number;
  waku: WakuConfig;
  obsidian?: ObsidianConfig;
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
