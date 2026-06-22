# HiveSync Waku Bidirectional Communication Problem

## Current State

HiveSync uses `@waku/sdk@0.0.36` / `@waku/relay@0.0.23` (Waku v2 protocol) for P2P messaging.
Two nodes (everhomie and claw/vibecoder) need to send AND receive messages on testnet.

## History

1. **createLightNode** (original): Filter + LightPush + Store enabled. Filter for receiving worked
   when daemon ran long enough to accumulate Filter-capable full-node peers. Messages received
   via direct push from full-node peers.

2. **createRelayNode** (switch at commit 8839edc): Switched to Relay-only because LightPush
   sending was broken on testnet. BUT: `createRelayNode()` passes `{}` as protocolsEnabled,
   defaults to `{ filter: false }`. Lost Filter receive path. Relay mesh forms (3-5 peers)
   but nodes join random parts of mesh and messages don't cross.

3. **Hybrid Relay+Filter** (current, commit e1b51bc): Manually create node with both Relay and
   Filter. `Relay: true, Filter: true`. Filter has 0 peers on testnet. Relay mesh has 3+ peers
   but sender and receiver nodes are on different mesh partitions — messages published via
   one node's Relay never reach the other's Relay observers.

## Root Causes

### 1. Testnet Mesh Partitioning
Waku testnet has many bootstrap nodes. Each new node connects to a random subset via
`defaultBootstrap: true`. Two nodes starting at different times connect to DIFFERENT relay
peers and may never share mesh peers. Gossipsub is live-only — messages published by node A
only propagate through A's mesh. If node B is on a disjoint part of the mesh, B never sees
A's messages.

### 2. No Filter Peers After Restart
Filter V2 requires Filter-capable full nodes. When daemon restarts, all prior connections
are lost. Fresh daemon needs to re-discover Filter peers — may take hours or never succeed
on current testnet.

### 3. Daemon Restart Reset
Every daemon restart drops all established connections (Relay mesh peers, Filter peers, Store
peers). The daemon was restarted multiple times during debugging (createLightNode → createRelayNode
→ hybrid), each time losing accumulated peer connections.

### 4. No Direct Peer Configuration
HiveSync has no mechanism to specify known peers (peer ID + multiaddress). It relies entirely
on DHT/bootstrap discovery which is stochastic on testnet.

## Key Evidence

- Fresh relay node with `defaultBootstrap: true`: 3-5 mesh peers in 5s, but 0 messages in 60s
- Fresh light node: 0 connections after 15s (testnet discovery is slow/inconsistent)
- createLightNode daemon ran for hours before refactor — accumulated peers, messages flowed
- After each restart: 0 incoming messages (peer relationships reset)
- `send` CLI command works (publishes via relay) but messages never reach daemon because
  daemon's mesh peers ≠ send command's mesh peers
- Waku was rebranded to Logos Messaging (logos-messaging/logos-delivery-js) but npm packages
  still `@waku/sdk` — version 0.0.37 available

## Required Fix

The fix must ensure reliable bidirectional communication between HiveSync agents on the
Waku testnet without relying on long-running daemon sessions.

### Option A: Direct Peer Connections (Recommended)
- Add `directPeers` to HiveSync config: array of peer IDs with multiaddresses
- When starting, connect directly to known peers BEFORE relying on DHT discovery
- After handshake, exchange peer identities and add each other as direct peers
- Nodes maintain a persistent peer table in SQLite

### Option B: Bootstrapping from Known Relay
- Configure a shared bootstrap relay node that both agents connect to
- All traffic routes through the shared relay, guaranteeing mesh overlap
- Use Waku Relay's `peerExchange` to discover each other

### Option C: Reliable Channel Protocol
- Use Waku's Reliable Channel (added in @waku/sdk@0.0.37) for guaranteed delivery
- Combines relay publish + store retrieval for message reliability
- Messages survive daemon restarts via Store

### Minimum Viable Fix
1. Add `directPeers` config to `config/hivesync.yaml`
2. Modify `waku-transport.ts` to connect to direct peers on startup
3. Add mesh monitoring — log mesh peer count, retry if lost
4. Exchange peer IDs during handshake protocol
5. Update `@waku/sdk` to 0.0.37 for reliable channel support

## E2E Test Requirements

The fix MUST be validated with:
1. Start two independent Waku nodes on the same machine (different ports/peer IDs)
2. Node A sends message → Node B receives it via Relay callback
3. Node B sends message → Node A receives it via Relay callback
4. Both sides verify message content is intact
5. Test with default bootstrap (simulating real testnet conditions)
6. Test with direct peer connections (if implemented)
7. Verify delivery within 30 seconds of node startup
8. Log all steps for debugging