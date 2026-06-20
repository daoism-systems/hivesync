# HiveSync Protocol Specification

Version 2.0.0 · Protocol envelope version 1

---

## 1. Message Envelope Format

Every frame published to the Waku content topic is a UTF-8 JSON serialization of
the following `Envelope` object.  All fields are required unless marked optional.

```typescript
interface Envelope {
  v:    number;        // Protocol version — must be 1
  id:   string;        // UUID v4 — unique per message, used for dedup and ACK
  from: string;        // Sender's agentId (routing address)
  to:   string;        // Recipient's agentId, or "broadcast"
  type: MessageType;   // See §2
  ts:   number;        // Unix epoch milliseconds (Date.now())
  spk:  string;        // Sender's Ed25519 signing public key (base64 DER / SPKI)
  sig:  string;        // Ed25519 signature over canonicalBytes(envelope) — see below
  enc:  boolean;       // true = body is encrypted

  // Plaintext body (enc=false):
  body?: string;       // JSON.stringify(content)

  // Encrypted body fields (enc=true) — all four present together:
  iv?:  string;        // AES-GCM 96-bit IV (base64)
  ct?:  string;        // AES-256-GCM ciphertext (base64)
  tag?: string;        // AES-256-GCM 128-bit auth tag (base64)
  epk?: string;        // Sender's X25519 public key (base64 DER / SPKI)
}
```

### Canonical signature bytes

The signature `sig` is computed over a deterministic JSON serialization of the
security-relevant fields, **excluding** `spk` (the signing key itself) and `sig`
(the output):

```
canonicalBytes = UTF-8(JSON.stringify([
  env.v,
  env.id,
  env.from,
  env.to,
  env.type,
  env.ts,
  env.enc,
  env.body  ?? null,
  env.iv    ?? null,
  env.ct    ?? null,
  env.tag   ?? null,
  env.epk   ?? null,
]))
```

Both the sender (at sign time) and the receiver (at verify time) compute the same
bytes, so the signature covers the full routing and payload context.

---

## 2. Message Types and Protocol Flow

```typescript
enum MessageType {
  TEXT           = 'text',
  FILE           = 'file',
  SYNC_REQUEST   = 'sync_request',
  SYNC_RESPONSE  = 'sync_response',
  OBSIDIAN_UPDATE = 'obsidian_update',
  COMMAND        = 'command',
  ACK            = 'ack',
  ANNOUNCE       = 'announce',
}
```

### 2.1 ANNOUNCE

Broadcast presence and public keys.  Always sent plaintext (`enc=false`) to all
peers.  `to` field is `"broadcast"`.

**Content** (`body` field, JSON-parsed `AnnouncePayload`):

```typescript
interface AnnouncePayload {
  agentId:      string;   // routing address
  agentName:    string;   // human display name
  keyId:        string;   // SHA-256 fingerprint of signPublicKey (base64url, 24 chars)
  signPublicKey: string;  // Ed25519 public key (base64 DER)
  encPublicKey:  string;  // X25519 public key (base64 DER)
}
```

**Flow**:
1. On startup, an agent broadcasts ANNOUNCE immediately.
2. A second ANNOUNCE is sent 2 seconds later to ride out subscription propagation.
3. Periodic ANNOUNCEs follow at `syncInterval` seconds (default 30).
4. On receiving a new peer's ANNOUNCE, the local agent re-ANNOUNCEs so the
   newcomer discovers it without waiting for the next interval.

**Receiver validation**:
- `fingerprint(payload.signPublicKey)` must equal `fingerprint(envelope.spk)`.
  An announce that advertises a different key than the one it was signed with is
  silently dropped.

---

### 2.2 TEXT

A human-readable message from one agent to another, or to all agents.

**Content** (inside `body` or decrypted):

```json
{
  "text": "Hello from AI Agent!",
  "__auth": "optional-plaintext-password",   // present only when encrypted
  "__auto": true                             // present only for auto-replies
}
```

- `__auth` and `__auto` are stripped by `BridgeManager.classify()` before the
  message reaches any handler or is stored.
- Direct messages (`to` ≠ `"broadcast"`) are always sent encrypted when the
  recipient's encryption key is known.
- Broadcast messages (`to = "broadcast"`) are always plaintext.

**Access control**:
- If `auth` is configured in `BridgeManager`, a TEXT message is **trusted** only
  when `enc=true` AND the embedded `__auth` value passes `verifyPassword`.
- Untrusted TEXT messages are quarantined (see §5.3).

**Auto-reply anti-loop**: BridgeManager checks `isAuto` (the `__auto` field).
Auto-replies are not themselves auto-replied to, preventing infinite loops.

**ACK**: after delivering a trusted direct TEXT message, the receiver sends an ACK.
Broadcast messages do not generate ACKs (avoids storm).

---

### 2.3 COMMAND

A structured remote-procedure call.  Always encrypted for direct recipients.

**Content**:

```json
{
  "command": "status",
  "args": {}
}
```

Built-in commands handled by `BridgeManager.handleCommand`:

| Command | Response |
|---------|----------|
| `status` | JSON status object |
| `agents` | Newline-separated list of known agents |
| `sync` | "Sync initiated" (triggers Obsidian sync) |
| `help` | "Commands: status, agents, sync, help" |

Unknown commands receive `"Unknown command: <cmd>"`.

---

### 2.4 ACK

Acknowledgement for a received direct message.

**Content**:

```json
{ "originalMessageId": "<uuid>" }
```

- Sent automatically after every trusted non-ACK direct message.
- Never triggers a further ACK (would create an infinite loop).

---

### 2.5 OBSIDIAN_UPDATE

Real-time vault note push from one agent to another.  Always encrypted.

**Content**:

```json
{
  "notes": [
    {
      "id": "<uuid>",
      "path": "relative/path.md",
      "content": "# Note content",
      "lastModified": "2025-06-18T10:00:00.000Z",
      "hash": "<sha256-hex>"
    }
  ],
  "timestamp": "2025-06-18T10:00:00.000Z"
}
```

`hash = "DELETED"` signals the note was removed.

---

### 2.6 SYNC_REQUEST / SYNC_RESPONSE

On-demand full sync of vault notes modified since a given timestamp.

**SYNC_REQUEST content**:
```json
{ "since": "2025-06-18T00:00:00.000Z", "requestId": "<uuid>" }
```

**SYNC_RESPONSE content**:
```json
{
  "requestId": "<uuid>",
  "notes": [ /* same format as OBSIDIAN_UPDATE */ ],
  "timestamp": "2025-06-18T10:00:00.000Z"
}
```

---

## 3. Authentication

### 3.1 Password-based trust model

HiveSync uses a **shared-secret access control** model.  Each agent configures a
password in `config/hivesync.yaml`.  A remote agent must include that password
inside an E2E-encrypted message for its messages to be trusted.

Trust conditions (all must be true):
1. The envelope has `enc=true` (message was encrypted, not signed plaintext).
2. The decrypted content contains `__auth` equal to the expected password.
3. `verifyPassword(__auth, {salt, hash})` returns `true` (constant-time scrypt
   comparison).

If any condition fails, or if no `auth` block is configured (open mode), the
message is either trusted unconditionally (open mode) or quarantined.

### 3.2 Password storage

Only a salt and scrypt-derived hash are stored on disk — the plaintext password is
**never persisted**.

```yaml
auth:
  salt: "<base64 random 16 bytes>"
  hash: "<base64 scrypt output, 32 bytes>"
  autoReply: "✓ received"   # optional
```

scrypt parameters: `N=16384, r=8, p=1, keyLen=32` (Node.js `crypto.scryptSync`
defaults).

### 3.3 Password setup

Use the setup wizard (`hivesync setup`) or `hermes-setup.sh`.  The script generates
a 32-character random alphanumeric password and stores it in `~/.hermes/.env` as
`HIVESYNC_PASSWORD`.

### 3.4 Encryption flow

```
plaintext (Buffer)
  │
  ├── Sender X25519 private key  ─┐
  │                               ├─ ECDH shared secret
  └── Recipient X25519 public key─┘
              │
         HKDF-SHA256
         info = 'hivesync/v1/aes-256-gcm'
         length = 32 bytes
              │
        AES-256-GCM
        random 12-byte IV
              │
      {iv, ciphertext, tag, epk=sender_x25519_pub}
```

The recipient reverses this: uses its own X25519 private key + the sender's `epk`
to derive the same shared key, then decrypts with AES-256-GCM.

### 3.5 Key fingerprint and TOFU

```
keyId = sha256(signPublicKey_base64) → base64url → first 24 chars
```

On first contact, `keyId` is pinned per `agentId`.  If a later message from the
same `agentId` uses a different key, it is silently dropped.  This prevents
impersonation even if an `agentId` string is stolen.

---

## 4. Storage Schema (SQLite)

Database file: configured as `storagePath` (default `data/hivesync.db`).

### 4.1 `messages`

```sql
CREATE TABLE messages (
  id         TEXT     PRIMARY KEY,           -- UUID v4
  sender     TEXT     NOT NULL,
  recipient  TEXT     NOT NULL,              -- agentId or "broadcast"
  type       TEXT     NOT NULL,              -- MessageType enum value
  content    TEXT     NOT NULL,              -- JSON-serialized content
  timestamp  DATETIME NOT NULL,             -- ISO 8601
  encrypted  INTEGER  NOT NULL,             -- 0 or 1
  signature  TEXT,                          -- Ed25519 sig (base64), nullable
  delivered  INTEGER  DEFAULT 0,
  read       INTEGER  DEFAULT 0
);

CREATE INDEX idx_messages_sender    ON messages(sender);
CREATE INDEX idx_messages_recipient ON messages(recipient);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
```

`INSERT OR IGNORE` is used on save; the network can redeliver frames and we never
want duplicates.  Only **trusted** messages reach this table; quarantined messages
go to JSON files instead.

### 4.2 `agents`

```sql
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,     -- agentId
  name          TEXT NOT NULL,
  public_key    TEXT NOT NULL,        -- Ed25519 signing pub (base64 DER)
  enc_public_key TEXT,                -- X25519 enc pub (base64 DER)
  key_id        TEXT,                 -- fingerprint (24-char base64url)
  created_at    DATETIME NOT NULL,
  last_seen     DATETIME,
  trusted       INTEGER DEFAULT 0
);
```

`INSERT … ON CONFLICT DO UPDATE` preserves the original `created_at` and the
`trusted` flag across re-announcements.

### 4.3 `obsidian_notes`

```sql
CREATE TABLE obsidian_notes (
  id             TEXT PRIMARY KEY,    -- UUID v4
  path           TEXT NOT NULL,       -- vault-relative path (e.g. "folder/note.md")
  content        TEXT NOT NULL,       -- full markdown content
  last_modified  DATETIME NOT NULL,
  hash           TEXT NOT NULL,       -- SHA-256 hex of content, or "DELETED"
  synced         INTEGER DEFAULT 0,
  sync_timestamp DATETIME

);

CREATE INDEX idx_notes_path ON obsidian_notes(path);
CREATE INDEX idx_notes_hash ON obsidian_notes(hash);
```

### 4.4 `sync_state`

```sql
CREATE TABLE sync_state (
  agent_id     TEXT PRIMARY KEY,
  last_sync    DATETIME NOT NULL,
  notes_synced INTEGER DEFAULT 0,    -- running total
  conflicts    INTEGER DEFAULT 0,    -- running total
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

Updated with `INSERT OR REPLACE … COALESCE(SELECT …) + delta` so counters
accumulate rather than reset.

### 4.5 Quarantine store (filesystem)

Untrusted messages are written as **read-only** (`mode 0444`) JSON files in:

```
data/quarantine/<ISO-timestamp>_<sender>_<msgId-prefix8>.json
```

Format:

```json
{
  "id": "<uuid>",
  "sender": "<agentId>",
  "recipient": "<agentId>",
  "type": "text",
  "content": { "text": "..." },
  "timestamp": "2025-06-18T10:00:00.000Z",
  "encrypted": false,
  "reason": "unauthenticated (not encrypted)",
  "quarantinedAt": "2025-06-18T10:00:00.000Z"
}
```

`reason` values: `"missing or invalid password"`, `"unauthenticated (not encrypted)"`,
`"quarantined"` (open-mode fallback).

---

## 5. Security Model

### 5.1 Signatures

Every envelope is signed with the sender's Ed25519 private key over
`canonicalBytes(envelope)` (§1).  The receiver verifies the signature against the
`spk` public key embedded in the same envelope before any further processing.

**What is covered by the signature**: all routing fields (`v, id, from, to, type,
ts, enc`) plus the complete payload (`body` or `iv+ct+tag+epk`).

**What a signature guarantees**: the message was created by whoever holds the
private key corresponding to `spk`.  Combined with TOFU pinning, this prevents
replay attacks and identity spoofing.

### 5.2 End-to-end encryption

Direct messages to known agents are encrypted with X25519 ECDH + HKDF + AES-256-GCM
(see §3.4).  The shared key is never transmitted; only the sender's ephemeral
public key (`epk`) is included so the recipient can reproduce it.

GCM authentication tag protects against ciphertext tampering.

Broadcast messages (`to = "broadcast"`) are **not** encrypted — they are public
by design and visible to every subscriber of the content topic.

### 5.3 Quarantine

Messages that fail the trust check (wrong/missing password, or unencrypted when
auth is required) are written to isolated read-only files that are:

- **Never inserted into the main database** — no SQL query path touches quarantine
  content after the initial write.
- **Never executed** — no handler is invoked; commands inside quarantined messages
  are not processed.
- **Read-only on disk** (`0444`) — a mild deterrent against accidental execution.
- **Viewable in the TUI** quarantine panel or via `hivesync quarantine` — for human
  inspection only.

### 5.4 Auto-reply safety

`BridgeManager` embeds `__auto: true` in automated reply messages.  On receive,
this flag prevents the local agent from sending yet another auto-reply, breaking
any potential reply loop between two agents that both have `autoReply` configured.

### 5.5 Deduplication

A sliding window of 5000 seen message IDs (`seenIds` Set + `seenOrder` queue in
`HiveSync`) prevents the same frame from being delivered twice even when Waku
relay nodes re-deliver it.  Self-originated frames are also filtered here.

---

## 6. CLI Commands

Invoked as `hivesync <command> [options]`.  Built with `commander`.

| Command | Description | Notable options |
|---------|-------------|-----------------|
| `start` | Start the bridge (TUI, REPL, or daemon) | `-c/--config <path>`, `-d/--daemon`, `-p/--plain`, `-v/--verbose`, `--no-sync` |
| `setup` | Interactive setup wizard | — |
| `status` | Print bridge + sync status and exit | `-c/--config <path>` |
| `send <recipient> <message>` | Send a single text message and exit | — |
| `sync` | Trigger manual Obsidian sync and exit | — |
| `sync-status` | Print per-agent sync counters and exit | — |
| `agents` | Listen for 8 s and list discovered agents | — |
| `quarantine` | List quarantined messages (read-only) | — |
| `watch` | Informational; file watching starts with `start` | — |
| `test` | Run connectivity, storage, FS, and crypto self-tests | — |

### `start` mode selection

```
process.stdout.isTTY
    && !--plain
    && !--daemon
        → animated splash + TUI

    --plain  OR  !isTTY
        → readline REPL (interactive.ts)

    --daemon
        → logger output only, SIGINT handler, no REPL
```

### Global config resolution

Config is loaded by `loadConfig()` in the following order:
1. Explicit `-c <path>` argument
2. `./config/hivesync.yaml`
3. `./hivesync.yaml`
4. `./config.yaml`
5. `./config/config.yaml`
6. Environment variables (`AGENT_ID`, `AGENT_NAME`, `STORAGE_PATH`, `SYNC_INTERVAL`)
7. Built-in defaults

---

## 7. Configuration Format

File: `config/hivesync.yaml` (YAML, merged with `DEFAULT_CONFIG`).

```yaml
# Routing identity
agentId: everhomie              # unique string used for routing
agentName: "everhomie"          # human display name

# SQLite database location
storagePath: /root/hivesync/data/hivesync.db

# Seconds between ANNOUNCE broadcasts (≤0 disables periodic announce)
syncInterval: 30

waku:
  listenAddresses:
    - /ip4/0.0.0.0/tcp/0/ws    # local WebSocket listen address
  bootstrapNodes: []            # empty = use @waku/sdk default bootstrap fleet
  clusterId: 1                  # The Waku Network
  numShardsInCluster: 8
  contentTopic: /hivesync/1/agents/proto   # /{app}/{version}/{topic}/{encoding}
  keepAlive: true
  maxPeers: 10

# Optional: require a matching password for trust
auth:
  salt: "<base64 random bytes>"
  hash: "<base64 scrypt hash>"
  autoReply: "✓ received"       # optional automated reply for trusted messages

# Optional: Obsidian vault sync
obsidian:
  enabled: true
  vaultPath: /root/everdao-knowledge
```

### Environment variable overrides (subset)

| Variable | Effect |
|----------|--------|
| `AGENT_ID` | `agentId` |
| `AGENT_NAME` | `agentName` |
| `STORAGE_PATH` | `storagePath` |
| `SYNC_INTERVAL` | `syncInterval` (parsed as integer) |

---

## 8. Hermes Integration

### 8.1 Overview

The Hermes adapter (`hermes-setup/adapter.py`) is a **polling gateway plugin**
that bridges the Hermes AI agent framework to a running HiveSync daemon.  It does
not embed a Node.js runtime; instead it:

- Reads messages by querying the SQLite database directly (read-only).
- Sends messages by invoking `node dist/cli.js send` as a subprocess.

### 8.2 Inbound message flow

```
HiveSync daemon
    └── writes trusted messages → data/hivesync.db (messages table)

HiveSyncAdapter._poll_loop()   (every poll_interval seconds, default 30)
    └── _read_db(db_path, last_seen_ts, our_agent)
            SELECT id, sender, content, timestamp
            FROM messages
            WHERE timestamp > :last_seen_ts AND sender != :our_agent
            ORDER BY timestamp ASC

    for each row:
        if sender not in allowed_users → drop
        extract text from content JSON
        build MessageEvent(text, source, timestamp)
        await handle_message(event)   → Hermes processes & responds

    update last_seen_ts → data/.hermes-last-ts   (persistence across restarts)
```

On the very first run (no `last_seen_ts`), only the single most recent message
is fetched to avoid replaying history.

### 8.3 Outbound message flow

```
Hermes.send(chat_id, content)
    └── HiveSyncAdapter.send(chat_id, content)
            └── _send_hivesync(cli_path, recipient, message)
                    → asyncio.create_subprocess_exec(
                          "node", "dist/cli.js", "send", "--no-sync",
                          recipient, message,
                          cwd=hivesync_home,
                          timeout=60s
                      )
                    parse stdout for "Message sent! ID: <id>"
```

### 8.4 Configuration

**`~/.hermes/config.yaml`** (written by `hermes-setup.sh`):

```yaml
gateway:
  platforms:
    hivesync:
      enabled: true
      extra:
        home: /root/hivesync
        agent_id: everhomie
        db_path: /root/hivesync/data/hivesync.db
        poll_interval: 15
        allow_all: true
```

**`~/.hermes/.env`** (sourced by Hermes on startup):

```bash
export HIVESYNC_HOME=/root/hivesync
export HIVESYNC_AGENT_ID=everhomie
export HIVESYNC_PASSWORD=<32-char random>
export HIVESYNC_POLL_INTERVAL=15
```

Environment variables take precedence over `config.yaml` values.

### 8.5 `hermes-setup.sh` steps

1. **Prerequisites** — checks `node ≥18`, `npm`, `git`, warns if `hermes` absent.
2. **Build** — `npm install && npm run build` (idempotent).
3. **Credentials** — generates or reuses a 32-char alphanumeric password; computes
   `scrypt(password, randomSalt, 64)` and formats `salt:hash` (base64).
4. **Config** — writes `config/hivesync.yaml` if it doesn't exist or the
   `agentId` changed.
5. **Plugin** — copies `adapter.py`, writes `__init__.py` and `plugin.yaml` to
   `~/.hermes/plugins/hivesync-platform/`.
6. **Hermes config** — upserts the `hivesync:` block under `gateway.platforms`
   in `~/.hermes/config.yaml`.
7. **Env** — writes/updates four `HIVESYNC_*` vars in `~/.hermes/.env`.

### 8.6 Authorization in the adapter

| Setting | Behaviour |
|---------|-----------|
| `allow_all: true` | All senders accepted |
| `allowed_users: [agentA, agentB]` | Only listed senders accepted |
| `allowed_users: []` and `allow_all: false` | All senders accepted (empty = open) |

Blocked senders are logged and silently dropped; they receive no error response.

### 8.7 State persistence

The cursor file `data/.hermes-last-ts` stores the ISO timestamp of the last
processed message.  On adapter restart this prevents re-delivering old messages
to Hermes.  The file is written after every successful poll that produced at least
one new message.

---

## 9. Identity File Format

Location: `data/identity-{sanitized-agentId}.json`, mode `0600`.

```json
{
  "agentId": "everhomie",
  "agentName": "everhomie",
  "signing": {
    "publicKey":  "<base64 DER Ed25519 SPKI>",
    "privateKey": "<base64 DER Ed25519 PKCS8>"
  },
  "encryption": {
    "publicKey":  "<base64 DER X25519 SPKI>",
    "privateKey": "<base64 DER X25519 PKCS8>"
  },
  "createdAt": "2025-06-01T00:00:00.000Z"
}
```

`Identity.loadOrCreate` generates fresh key pairs on first run and reuses them on
subsequent starts.  Renaming the agent (changing `agentName` while keeping
`agentId`) updates only the `agentName` field; keys are preserved.

An **ephemeral identity** (`Identity.ephemeral`) generates keys in-memory without
touching disk.  Used when `storagePath = ':memory:'` (test / throwaway mode).

---

## 10. Waku Network Configuration

HiveSync targets **The Waku Network** (cluster 1, 8 shards).

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `clusterId` | 1 | The Waku Network cluster |
| `numShardsInCluster` | 8 | Auto-sharding shard count |
| `contentTopic` | `/hivesync/1/agents/proto` | Application namespace |
| `defaultBootstrap` | `true` (when `bootstrapNodes` is empty) | Use `@waku/sdk`'s built-in bootstrap fleet |

The pubsub topic and shard are derived automatically by the SDK from
`{clusterId, numShardsInCluster, contentTopic}`.

### Protocol selection

- **LightPush** — for publishing (no need to run a full relay).
- **Filter** — for subscribing (server-side filtering by content topic).

Both are negotiated during `waitForRemotePeer` with a configurable timeout
(default 30 s).
