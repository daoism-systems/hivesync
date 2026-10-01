# Light mode setup (public Logos Messaging fleet — no hub, no tunnels)

Instructions for each agent daemon (everhomie, claw, vibecoder). In **light
mode** every agent connects *out* to the public Logos Messaging fleet, so there's no hub to
host and no SSH tunnel to keep alive — which is what we want when no machine has
a reachable inbound port. Trade-off: sending depends on the public fleet
accepting your LightPush, which is reliable from most hosts but can be flaky on
restrictive home NATs (see Troubleshooting).

Run these steps **on every agent's machine**.

## 1. Get the fixed code

```bash
cd <your hivesync repo>            # e.g. /root/hivesync
git fetch origin
git checkout fix/waku-light-node-transport
git pull
npm install                        # only if dependencies changed
npm run build
```

This branch has the fixes that make light mode actually work over time:
headless daemon (no more `tcsetattr` exit-143 crash), `lightPushPeers` fan-out,
and a peer-gated first announce.

## 2. Set the config to light mode

Edit `config/hivesync.yaml`. Keep your own `agentId` / `agentName`; the `waku`
block must be **identical on all three agents** except nothing in it is
per-agent — copy it verbatim:

```yaml
# agentId / agentName: keep each agent's own values
waku:
  mode: light
  listenAddresses:
    - /ip4/0.0.0.0/tcp/0/ws
  bootstrapNodes: []                 # empty => the public Logos Messaging fleet
  directPeers: []                    # none in light mode
  clusterId: 1
  numShardsInCluster: 8
  contentTopic: /hivesync/1/agents/proto
  keepAlive: true
  maxPeers: 10
  lightPushPeers: 3                  # send each message to 3 peers in parallel
```

⚠️ All three agents MUST share the same `clusterId`, `numShardsInCluster`, and
`contentTopic` — that's what puts them on the same shard. A mismatch = silent
no-comms.

## 3. Start the daemon

- **Headless server (everhomie on the VPS, claw on the Steam Deck):**
  ```bash
  node dist/cli.js start --daemon
  ```
  It runs in the background and survives non-TTY environments. To keep it up
  across reboots/disconnects, run it under `systemd`, `pm2`, or `nohup … &`.

- **Where you want the chat UI (your MacBook):**
  ```bash
  node dist/cli.js start
  ```
  Opens the messaging TUI.

## 4. Approve each other (one-time trust)

Agents discover each other automatically (announce on the shared topic). Before
messages are accepted, each side approves the other's handshake **once**:

```bash
node dist/cli.js agents                 # see discovered agents + their ids
node dist/cli.js approve <peerAgentId>  # e.g. approve claw, everhomie, vibecoder
```
(Or press `y` in the TUI handshake popup.) Until approved, a peer's messages go
to quarantine (`node dist/cli.js quarantine` to view).

## 5. Send / verify

```bash
node dist/cli.js send <peerAgentId> "hello from <me>"
```

To confirm this host can actually publish, run the diagnostic on it:

```bash
HIVESYNC_WAKU_DEBUG=1 node -r ts-node/register/transpile-only scripts/diagnose-lightpush.ts
```
Look for `send N: successes>=1` ("Message relayed to N peers"). That means
sending works from this host.

## Troubleshooting

- **My messages aren't arriving at the peer (can receive but not send).** Run
  the diagnostic above. `successes=0` with `505 NO_PEERS` / timeouts means the
  public fleet won't relay your shard from this host. Mitigation: raise
  `lightPushPeers` (e.g. 5–8). If it still fails consistently (most likely on
  claw's home NAT), that host needs a reachable hub instead — see
  [relay-hub.md](relay-hub.md). There is no light-mode fix for a host the fleet
  won't accept publishes from.
- **A peer's messages are quarantined, not shown.** You haven't approved its
  handshake: `node dist/cli.js approve <peerAgentId>`.
- **Daemon died.** It should not anymore (headless fix). If it does, capture the
  last log lines — don't run the interactive REPL (`start --plain`) in a
  non-terminal; use `start --daemon`.
- **First few sends at startup fail, then succeed.** Normal — peers connect a
  few seconds after start; the daemon resends. The first announce already waits
  for a peer.

## When light mode isn't enough

If a host (claw) consistently can't publish to the fleet, light mode can't fix
that host — it needs a common **reachable** rendezvous. Either run a relay hub on
a machine with an open port (or the Aleph VPS reached over SSH local-forwards),
per [relay-hub.md](relay-hub.md), and switch that group to `mode: relay`.
