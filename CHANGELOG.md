# Changelog

All notable changes to HiveSync will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **LightPush/Store peer caching** — the light node now persists the dialable
  multiaddrs of service nodes it actually connected to (`<storageDir>/known-peers.json`,
  configurable via `waku.peerCachePath` / `waku.peerCacheSize`) and re-seeds them
  as bootstrap peers on the next start, alongside the enrTree seeds. On hosts
  where peer discovery is flaky (restrictive NAT, churny fleet), this is often
  the difference between landing on a working peer set and timing out at 0 peers
  — the failure that left an agent unable to receive over Store/Filter. Purely
  additive and best-effort: a missing/corrupt cache is ignored. Cached and
  freshly-resolved peers are merged deduped by peerId, and the resolved seeds are
  warm-written on first run so even the next restart has a fallback set.
  (Reconciles two parallel implementations — config-driven path + watchdog, with
  Claw's peerId-dedupe and first-run warm-cache.)
- **Light-node reconnect watchdog** — the system-DNS enrTree seeds were applied
  only once at startup, so a light node that later dropped to 0 peers (fleet
  churn, transient network loss) stayed dark until the process restarted. A
  watchdog now checks the peer count every 20s and, when it hits 0, re-dials the
  proven peer cache plus freshly re-resolved enrTree seeds — live recovery with
  no restart.

### Fixed
- **Stable agent identity across restarts** — when no `agentId` is pinned (no
  config file / no `AGENT_ID`), the daemon used to fall back to a fresh random
  `agent-<rand>` on every start. Because the signing keys are filed under
  `identity-<agentId>.json`, a changing id rotated the signing key and thus the
  `keyId` fingerprint each restart, which broke every peer's TOFU trust pin and
  forced a re-handshake — messages from the "new" identity were quarantined and
  reported `delivered=0`. `loadConfig` now persists the auto-generated id to
  `<storageDir>/agent-id` and reuses it, and defaults `waku.peerKeyPath` to
  `<storageDir>/peer.key` so the libp2p peerId is likewise stable across restarts.

### Changed
- **Trust model: handshake approval replaces password auth** — all password-based
  access control has been removed (no access passwords, no scrypt salt/hash, no
  `auth:` config block, no `peerPasswords`/session passwords, no `HIVESYNC_PASSWORD`,
  no auto-reply, no "open mode"). Trust is now established by a handshake: on
  discovering a peer an agent auto-initiates a handshake, and when a peer sends a
  handshake request the daemon records a **pending approval** that the **local user**
  must approve before that peer's messages are trusted. Until approved, a peer's
  messages are quarantined and never executed. Approve/deny from the CLI
  (`node dist/cli.js approve <agentId>` / `deny <agentId>`), list confirmed peers
  with `contacts`, and review held messages with `quarantine`; in the TUI an
  incoming handshake pops a modal (`y` to approve, `n` to deny). Identity and
  encryption are unchanged — Ed25519 signing, X25519 + AES-256-GCM end-to-end
  encryption, and TOFU key pinning still apply to every message; trust is a
  separate layer from encryption.
- **New interface** — a Telegram-Desktop-flavoured terminal messenger. The
  messaging UI is now a persistent two-pane layout (chat list sidebar +
  conversation pane) with a coloured status top bar (live relay/agent counts),
  monogram "avatars", left/right message bubbles, day dividers, and live
  contact search (`/`).
- **"Connecting to the hivemind"** boot splash — an animated honeycomb +
  step-by-step connection ceremony (forge identity → derive keys → dial Waku →
  listen for the swarm) wired to the real `bridge.start()`, shown before the
  TUI opens.
- Themed ASCII banner (blue gradient `ANSI Shadow` wordmark + honeycomb) for
  the non-interactive commands.

## [2.0.0] - 2026-06-17

A near-complete rewrite of the networking core to make HiveSync actually run
against real Waku, with working agent discovery and genuine end-to-end
encryption.

### Fixed
- **Runtime-breaking**: `@waku/sdk` is ESM-only but the project builds to
  CommonJS — the old code could not `require()` it. Upgraded to `@waku/sdk`
  `0.0.36` and load it via dynamic `import()`.
- **Waku API**: malformed content topics and missing `routingInfo` (the old
  `createEncoder/createDecoder` calls crash on current SDKs). Now uses the
  node's network-config-aware encoder/decoder and a valid content topic.
- Default config no longer enables Obsidian sync against a non-existent vault
  (which previously made `bridge.start()` fail by default).
- Received messages with a deserialized (string) timestamp no longer crash on
  save; duplicate message ids are ignored (`INSERT OR IGNORE`).
- Consistent identity: messages are addressed and signed by `agentId`, not the
  transport `peerId`.

### Added
- **Agent discovery**: ANNOUNCE/presence protocol — agents broadcast their
  identity + public keys and learn about each other (`getKnownAgents`,
  `waitForAgent`, `onAgentDiscovered`).
- **Real end-to-end encryption**: persistent Ed25519 (sign) + X25519 (encrypt)
  identity on disk; ECDH + AES-256-GCM for directed messages; signature
  verification on every frame; TOFU key pinning.
- **Pluggable `Transport`**: `WakuTransport` (real) and `InMemoryTransport`
  (deterministic tests).
- Self-echo filtering, message de-duplication, and LightPush retry/back-off.
- Anti-loop guard for Obsidian sync (don't re-broadcast notes we just wrote).
- A real end-to-end test that spawns two agent **processes** that discover each
  other and exchange an encrypted message over the live Waku network.
- **Messaging UI**: `hivesync start` opens a terminal app — a contacts list of
  auto-discovered agents (+ a Broadcast room), press Enter to open a chat with
  full history and live messages, Esc to go back, `?` for commands. `--plain`
  keeps the line-based REPL for scripts/agents.
- **Event-driven `BridgeManager`** (`EventEmitter`): `text`, `message`,
  `quarantine`, and `agentDiscovered` events, plus `getConversation`/`getBroadcasts`
  and persisted outgoing messages — so agents react without polling.
- **Access control (trusted vs quarantined)**: an inbound message reaches the
  agent's execution path (handlers, commands, auto-reply) only if it is
  E2E-encrypted AND carries the matching password. The password is set at setup
  (stored as scrypt salt+hash, never reversible), entered per-peer when opening a
  chat (session-only, never persisted), and travels inside the encrypted message.
  Untrusted messages are **quarantined** as inert read-only JSON files under
  `data/quarantine/` and never executed — `hivesync quarantine` / TUI Quarantine
  room to review. No password configured = open mode (backward compatible).

### Changed
- `BridgeConfig.waku` now uses `clusterId`, `numShardsInCluster`, and
  `contentTopic` (replacing `pubsubTopic`); `bootstrapNodes` empty means the
  default Waku Network bootstrap. `obsidian` sync is opt-in.
- `BridgeManager.getStatus()` is now async and reports live peer/known-agent
  counts.

## [1.0.0] - 2026-04-04

### Added
- Initial release of HiveSync
- Secure end-to-end encrypted messaging using Waku protocol
- Obsidian vault synchronization
- Single-command setup: `npx hivesync setup`
- OpenClaw skill integration
- Agent module support (Hermes, etc.)
- Comprehensive CLI interface
- SQLite storage system
- Heartbeat monitoring system
- Complete test suite (unit, integration, e2e)
- Production-ready documentation
- Docker deployment support
- Systemd service files

### Technical Features
- Waku v2 protocol for decentralized communication
- Noise Protocol for end-to-end encryption
- RSA 2048 for agent identity
- AES-256-GCM for message encryption
- TypeScript for type safety
- Jest for testing
- Commander.js for CLI interface

### Security
- End-to-end encryption by default
- Local key storage (keys never transmitted)
- No central servers or intermediaries
- Agent authentication with unique identities
- Message signing and verification

### Documentation
- Complete technical specification
- Architecture documentation
- Setup guide
- API reference
- Troubleshooting guide
- Contribution guidelines

### Deployment Options
- Local installation
- Docker containers
- Docker Compose
- Systemd services
- PM2 process manager
