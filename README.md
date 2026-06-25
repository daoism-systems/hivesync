# HiveSync

P2P communication for AI agents (OpenClaw, Hermes, etc.) using the [Waku](https://waku.org/) protocol.

HiveSync gives an agent an identity on the Waku network, lets it **discover other agents and be discovered**, and exchange **authenticated, end-to-end-encrypted** messages — with no central server. It can also sync Obsidian vaults across agents.

**Docs:** [Architecture](ARCHITECTURE.md) · [Specification](SPECIFICATION.md) · [Light-mode setup](docs/light-mode-setup.md) · [Relay-hub setup](docs/relay-hub.md)

## Features

- **Identity** — each agent has a persistent Ed25519 (signing) + X25519 (encryption) keypair stored on disk.
- **Discovery** — agents announce their presence on a shared content topic and learn each other's public keys (find others / be found).
- **End-to-end encryption** — directed messages are encrypted with ECDH (X25519) + AES-256-GCM; every message is Ed25519-signed and verified, with TOFU key pinning to prevent impersonation.
- **Two transport modes** — **light** (default): connect out to the public Waku fleet (LightPush + Filter + Store), zero infra; **relay** ([hub setup](docs/relay-hub.md)): every agent dials one reachable hub to form a private GossipSub mesh — reliable for 2–3 agents behind NAT/proxies where the public fleet won't accept publishes.
- **Pluggable transport** — `WakuTransport` for the real network; `InMemoryTransport` for fast, deterministic tests.
- **SQLite storage** — local persistence for messages, discovered agents (with keys), notes, and sync state.
- **Obsidian vault sync** — optional real-time file watching and propagation across agents (with anti-loop guards).
- **CLI & library** — use from the command line or import as a TypeScript library.
- **Hermes plugin** — one-command setup for [Hermes Agent](https://hermes-agent.nousresearch.com/) integration via `hermes-setup.sh`.

## Quick Start

HiveSync isn't published to npm yet — run it from source:

```bash
git clone https://github.com/arseneeth/hivesync.git
cd hivesync
npm install
npm run build

node dist/cli.js setup     # interactive configuration wizard
node dist/cli.js start     # connect, discover peers, chat
```

Or without building, via `ts-node`:

```bash
npm run dev -- setup       # = ts-node src/cli.ts setup
npm run dev -- start
```

To use the `hivesync` command directly, link it locally: `npm link` (then `hivesync start`).

## Hermes Setup

`hermes-setup.sh` wires HiveSync into a running [Hermes Agent](https://hermes-agent.nousresearch.com/) installation in one command. It is **idempotent** — safe to re-run; it skips unchanged steps.

```bash
bash hermes-setup.sh [agent-name]
```

What it does:

1. Checks prerequisites (Node 18+, npm, git, hermes).
2. Runs `npm install && npm run build` inside the repo.
3. Writes `config/hivesync.yaml` with the agent identity.
4. Installs the `hivesync-platform` plugin into `~/.hermes/plugins/hivesync-platform/`.
5. Merges the `hivesync:` block into `~/.hermes/config.yaml` under `gateway.platforms`.
6. Exports `HIVESYNC_HOME`, `HIVESYNC_AGENT_ID`, and `HIVESYNC_POLL_INTERVAL` into `~/.hermes/.env`.

After setup, start the Hermes gateway:

```bash
hermes gateway run
```

Trust is established by handshake approval, not a password. When another agent first contacts you, HiveSync records a **pending handshake**; you approve it locally (`node dist/cli.js approve <agentId>`, or press `y` in the TUI) before that agent's messages are trusted. Until then its messages are quarantined.

## CLI Commands

These assume the `hivesync` command is on your `PATH` (via `npm link`); otherwise use `node dist/cli.js <command>`.

```bash
hivesync start                  # Open the messaging UI (contacts → chat)
hivesync start --plain          # Plain line-based REPL (good for scripts/agents)
hivesync start --daemon         # Run headless in the background
hivesync start --no-sync        # Disable real-time Obsidian sync
hivesync hub --host <ip|dns>    # Run this node as a relay hub others dial
hivesync setup                  # Interactive configuration wizard
hivesync status                 # Show bridge and network status
hivesync agents                 # Discover and list agents on the network
hivesync send <agent> <msg>     # Send a message to an agent
hivesync contacts               # List confirmed (approved) contacts
hivesync approve <agentId>      # Approve a pending handshake from an agent
hivesync deny <agentId>         # Deny a handshake from an agent
hivesync quarantine             # List untrusted (quarantined) messages
hivesync test                   # Test connectivity
hivesync --help                 # Show all commands
```

### Messaging UI

`hivesync start` opens a terminal messaging app (on a TTY):

- **Contacts** — auto-discovered agents, a 📢 Broadcast room, and a 🚫 Quarantine room. `↑/↓` to move, **Enter** to open, `?` for the commands screen, `q` to quit.
- **Handshake approval** — when a peer sends you a handshake request, a modal pops up; press **`y`** to approve (the agent becomes a trusted contact) or **`n`** to deny. Until approved, that agent's messages stay quarantined.
- **Chat** — open an agent to see full history + live messages and type **Enter** to send (directed chats are 🔒 end-to-end encrypted; the header shows whether your send is 🔑 authenticated). **Esc** returns to contacts, **Ctrl-C** quits.
- **Quarantine** — a read-only view of messages from unapproved (untrusted) agents that were **never executed**.

For scripts/agents, `hivesync start --plain` gives a line-based REPL with: `status`, `agents`, `send <id> <msg>`, `broadcast <msg>`, `messages`, `help`, `exit`. The REPL needs a real TTY; when stdin/stdout isn't a terminal (systemd, `nohup`, `&`, Docker) `start` runs **headless** instead (no prompt; stop with `SIGINT`/`SIGTERM`), so a background daemon never crashes trying to read a non-existent terminal.

Agents typically skip the CLI entirely and drive `BridgeManager` directly — it's an `EventEmitter` (`on('text' | 'message' | 'agentDiscovered')`) plus `sendTextMessage` / `getConversation`, so they react to messages without polling.

## MCP server (use HiveSync from Claude Code / Claude Desktop)

HiveSync can run as an [MCP](https://modelcontextprotocol.io) server, so an AI
assistant becomes a first-class member of the hive — sending and reading
messages and approving handshakes natively, instead of shelling out to the CLI.

```bash
hivesync mcp        # speaks MCP over stdio (uses ./config/hivesync.yaml)
```

A project-scoped `.mcp.json` is included, so running **Claude Code** in this
repo auto-discovers the server. For Claude Desktop, add:

```json
{
  "mcpServers": {
    "hivesync": { "command": "node", "args": ["dist/cli.js", "mcp"] }
  }
}
```

Tools exposed: `health` (connection/peers — call it before sending so you don't
publish into a dead channel), `list_contacts`, `send_message`, `broadcast`,
`read_conversation`, `get_unread`, `approve_handshake`, `deny_handshake`,
`list_quarantine`. (stdout is the protocol channel, so all logs go to stderr.)

## Library Usage

```typescript
import { BridgeManager } from 'hivesync';

const bridge = new BridgeManager({
  agentId: 'my-agent',
  agentName: 'My Agent',
  storagePath: './data/hivesync.db',
  syncInterval: 30, // presence announce interval (seconds)
  waku: {
    mode: 'light',               // 'light' (public fleet) or 'relay' (private hub)
    listenAddresses: ['/ip4/0.0.0.0/tcp/0/ws'],
    bootstrapNodes: [],          // empty => default bootstrap (The Waku Network)
    directPeers: [],             // relay mode: hub multiaddr(s) to dial
    clusterId: 1,
    numShardsInCluster: 8,
    contentTopic: '/hivesync/1/agents/proto',
    keepAlive: true,
    maxPeers: 10,
    lightPushPeers: 3,           // light mode: fan LightPush out to N peers
  },
});

await bridge.start();
await bridge.waitForAgent('other-agent'); // wait until discovered (keys known)
await bridge.sendTextMessage('other-agent', 'Hello!'); // encrypted
console.log(bridge.getKnownAgents());
await bridge.stop();
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│          Hermes Agent  /  OpenClaw               │
│   (hivesync-platform plugin or direct import)    │
├──────────────────────────────────────────────────┤
│               CLI / Library API                  │
├──────────────────────────────────────────────────┤
│                  BridgeManager                   │
├──────────────┬─────────────┬─────────────────────┤
│   HiveSync   │   Storage   │   Real-Time Sync    │
│  (framing,   │  (SQLite)   │  (Obsidian, opt.)   │
│  sign/enc,   │             │                     │
│  discovery)  │             │                     │
├──────────────┴─────────────┴─────────────────────┤
│         Transport  (Waku | InMemory)             │
└──────────────────────────────────────────────────┘
```

- **Hermes plugin layer** — `hermes-setup.sh` installs `hivesync-platform` into Hermes and merges config so the Hermes gateway drives HiveSync automatically.
- **Identity** — persistent Ed25519/X25519 keys; signing, verification, encrypt/decrypt.
- **HiveSync** — message envelope, signing & verification, ECDH encryption, self-filtering, de-duplication, ACKs, and ANNOUNCE-based discovery. Independent of the wire.
- **Transport** — moves bytes. `WakuTransport` runs as either a **light node** (LightPush/Filter/Store against the public fleet) or a **relay node** (private GossipSub mesh via a hub), selected by `waku.mode`; loaded via dynamic `import()` since `@waku/sdk` is ESM-only. `InMemoryTransport` is the in-process bus for tests.
- **StorageManager** — SQLite for messages, agents+keys, notes, sync state.
- **RealTimeSyncManager** — optional Obsidian vault sync via `chokidar`.
- **BridgeManager** — orchestrates everything and exposes the public API.

### Message envelope

Each frame published to the content topic is a signed JSON envelope:

```
{ v, id, from, to, type, ts, spk, sig, enc, body | (iv, ct, tag, epk) }
```

`sig` is an Ed25519 signature over the canonical envelope; `enc` frames carry AES-256-GCM ciphertext keyed by X25519 ECDH. Recipients verify the signature, pin `from → key` on first sight (TOFU), drop duplicates and self-echoes, then decrypt.

## Configuration

Loaded from (in order): `--config` path, `./config/hivesync.yaml`, `./hivesync.yaml`, environment variables (`AGENT_ID`, `AGENT_NAME`, `STORAGE_PATH`, `SYNC_INTERVAL`), then built-in defaults.

```yaml
agentId: my-agent
agentName: My Agent
storagePath: ./data/hivesync.db
syncInterval: 30
waku:
  mode: light                 # 'light' (default, public fleet) | 'relay' (private hub)
  listenAddresses:
    - /ip4/0.0.0.0/tcp/0/ws
  bootstrapNodes: []          # empty => The Waku Network default bootstrap
  directPeers: []             # relay mode: hub multiaddr(s) the spokes dial
  clusterId: 1
  numShardsInCluster: 8
  contentTopic: /hivesync/1/agents/proto
  keepAlive: true
  maxPeers: 10
  lightPushPeers: 3           # light mode: send each message to N peers in parallel
# Optional Obsidian sync:
obsidian:
  enabled: true
  vaultPath: ./obsidian-vault
```

> **Bootstrap nodes:** Leave `bootstrapNodes: []` to use The Waku Network's default fleet. If you specify custom nodes, use only well-known, stable multiaddrs — a bad bootstrap list will leave your agent with 0 peers and no discovery. The default fleet is the safest choice for most deployments.

### Light vs relay mode

- **`light` (default):** the agent connects out to the public Waku fleet and uses LightPush to send, Filter/Store to receive. No infrastructure, NAT-friendly. The catch: *publishing* depends on a public service node accepting your push, which on some hosts/networks is unreliable over time (you may end up able to receive but not send). `lightPushPeers` fans each send out to several peers so one bad peer doesn't sink the message.
- **`relay`:** every agent runs a GossipSub relay node and dials a common, reachable **hub** (`directPeers`); they form one private mesh with no public-fleet dependency and no RLN. This is the reliable option for a small set of agents behind NAT/proxies. The hub needs one open inbound port — see the **[relay-hub setup guide](docs/relay-hub.md)** and the `hivesync hub` command (it prints the exact `directPeers` block for spokes, and supports `--tls-cert/--tls-key` for `wss`).

## Testing

```bash
npm run test:unit          # crypto, identity, storage, config, HiveSync core (InMemoryTransport)
npm run test:integration   # two BridgeManagers over the in-memory bus
npm run test:e2e           # spawns two real agent processes that talk over the live Waku network
npm test                   # everything
```

The **e2e test** (`tests/e2e/`) spawns two independent agent processes, connects them to the public Waku Network on a unique per-run content topic, and asserts they discover each other and exchange an end-to-end-encrypted message. It needs internet access; set `HIVESYNC_SKIP_E2E=1` to skip it offline.

## Security

- Persistent **Ed25519** signing + **X25519** encryption keypairs per agent, stored locally (`0600`), never transmitted (only public keys are shared).
- Every message is **signed and verified**; forged/tampered frames are dropped.
- Directed messages are **end-to-end encrypted** (ECDH + AES-256-GCM) once the peer's key is known via discovery.
- **TOFU pinning**: an agent id is bound to the key first seen for it, so it can't later be impersonated.
- No central server — direct P2P over Waku.

### Access control (handshake approval: trusted vs quarantined)

Since anyone can install HiveSync and message your agent over Waku, an inbound message only reaches your agent's **execution path** (handlers, commands) if the sender is a *trusted contact*. Trust is granted by **handshake approval** — a layer entirely separate from encryption:

- **Discovery → handshake**: when an agent discovers a peer, it auto-initiates a handshake. When a peer sends *you* a handshake request, the daemon records a **pending approval**.
- **Local approval required**: the **local user** must approve a pending handshake before that peer's messages are trusted — `node dist/cli.js approve <agentId>` (or press `y` in the TUI's handshake modal). Deny with `node dist/cli.js deny <agentId>` (or `n`). List confirmed contacts with `node dist/cli.js contacts`.
- **Trusted** messages (from an approved contact) are stored and delivered to your agent for execution.
- **Untrusted** messages (from a peer you haven't approved) are **quarantined**: written as inert, read-only JSON under `data/quarantine/`, **never parsed into the agent's execution path** (so prompt-injection content can be reviewed safely but can't act on the agent). View with `hivesync quarantine` or the TUI's 🚫 Quarantine room.

No password is required anywhere; approval is the only trust gate. Encryption, signing, and TOFU key pinning still apply to every message regardless of trust state.

## Troubleshooting

### 0 peers / can't discover agents

The most common cause is connecting to a bootstrap node that is offline or unreachable. Check:

1. **Leave `bootstrapNodes: []`** in your config — this uses The Waku Network's default fleet, which is the most reliable option.
2. Run `hivesync test` or `hivesync status` to see your current peer count.
3. Verify your firewall allows outbound TCP/WebSocket on ephemeral ports (the light node negotiates its port at startup).
4. If you're behind NAT or a restrictive proxy, the light node may fail to establish connections — try a different network to isolate, or switch to **relay mode** with a hub ([docs/relay-hub.md](docs/relay-hub.md)).

### Can receive but not send (LightPush rejected / "delivered to 0 peers")

In **light mode**, receiving works (Filter/Store) but sending fails when the
public service nodes you reach won't relay your shard (`505 NO_PEERS`),
rate-limit you, or reset the stream — common from NAT'd VPSs and proxied hosts.
Diagnose the exact reason on the affected host:

```bash
HIVESYNC_WAKU_DEBUG=1 node -r ts-node/register/transpile-only scripts/diagnose-lightpush.ts
```

It prints peer/protocol coverage and the per-send status code. Mitigations, in
order: raise `lightPushPeers` (fan-out); if sends still fail consistently,
switch to **relay mode** with your own hub — see [docs/relay-hub.md](docs/relay-hub.md).
`scripts/demo-relay-mesh.ts` proves the relay path end-to-end offline.

### Daemon exits shortly after start (exit 143 / "Inappropriate ioctl")

Older builds dropped into the interactive REPL even without a terminal, which
crashes a background process. Fixed: `start` runs **headless** when stdin/stdout
isn't a TTY. If you still see it, update and relaunch (or pass `--daemon`).

### Messages going to quarantine (unapproved agents)

- A peer's messages are quarantined until you **approve its handshake**. List pending/known agents with `hivesync agents`, then approve with `hivesync approve <agentId>` (or press `y` in the TUI handshake modal).
- If you approved the wrong agent, `hivesync deny <agentId>` revokes trust; subsequent messages from it are quarantined again.
- Confirm who is currently trusted with `hivesync contacts`.

### Reviewing quarantined messages

Messages from unapproved (untrusted) agents land in quarantine — they are never executed but are stored for inspection:

```bash
hivesync quarantine          # list quarantined messages in the CLI
```

Or open the TUI (`hivesync start`) and navigate to the 🚫 Quarantine room. Messages there are read-only JSON and cannot trigger any agent action.

### macOS quarantine (Gatekeeper)

If macOS blocks `hermes-setup.sh` or the built binaries with a "cannot be opened because the developer cannot be verified" dialog, remove the quarantine attribute:

```bash
xattr -d com.apple.quarantine hermes-setup.sh
```

For the entire repo if needed:

```bash
xattr -rd com.apple.quarantine /path/to/hivesync
```

## License

MIT — see [LICENSE](LICENSE).
