# HiveSync Waku Fix: Direct Peers + E2E Test

## Context
HiveSync uses @waku/sdk for P2P messaging via Waku Relay protocol. Two nodes of the same app should be able to send and receive messages bidirectionally.

Our daemon (agentId: everhomie) now runs as a Waku relay node:
- PeerID: 12D3KooWFF9yuHk9egcSxb7tCAiheu5jqsjtpp4Dw29dac3KmYbK
- Listening on: /ip4/0.0.0.0/tcp/16000/ws
- Full multiaddress: /ip4/0.0.0.0/tcp/16000/ws/p2p/12D3KooWFF9yuHk9egcSxb7tCAiheu5jqsjtpp4Dw29dac3KmYbK
- Config: config/hivesync.yaml (clusterId: 1, numShardsInCluster: 8, contentTopic: /hivesync/1/agents/proto)
- Uses hybrid node (Relay + Filter) with createRelayNode-style construction in src/core/waku-transport.ts

## Working directory
/root/hivesync

## Build command
npm run build (runs tsc)

## Problem
Two Waku nodes on the testnet discover random bootstrap peers and end up in different parts of the gossipsub mesh. Messages published by node A via relay never reach node B because they're on different meshes.

## Partial fix already done
1. Added `listenAddresses: ['/ip4/0.0.0.0/tcp/16000/ws']` to config
2. Added `addresses.listen` to libp2p options in waku-transport.ts
3. Added `filterMultiaddrs: false` to allow plain WebSocket (was previously filtered to WSS only)
4. Added `directPeers: string[]` to WakuConfig type and defaults
5. Added `this.config.directPeers` dialing after node.start() in waku-transport.ts
6. Port 16000 now works and the daemon listens on it

## What needs to be fixed

### 1. Fix direct peer multiaddress format
The `node.libp2p.dial(peerAddr)` call expects a libp2p multiaddress. Test that dialing works with the format:
```
/ip4/0.0.0.0/tcp/16000/ws/p2p/12D3KooWFF9yuHk9egcSxb7tCAiheu5jqsjtpp4Dw29dac3KmYbK
```

### 2. Create E2E test: scripts/test-waku-e2e.mjs
Create a self-contained test that:
- Creates TWO separate Waku nodes on the same machine (different agentIds)
- Both nodes connect to our daemon's relay address as a directPeer
- Node A subscribes and listens for messages on the content topic
- Node B sends a message to Node A
- Verify Node A receives it via the Relay callback
- Then reverse: Node B subscribes, Node A sends, verify Node B receives
- Both nodes use the hybrid node approach (Relay + Filter) with createRelayNode-style construction
- Test must be fully automated with timeout after 60 seconds
- Log every step with timestamps

### 3. Alternatively: standalone E2E test
If direct dial to our daemon doesn't work (firewall, etc.), create an E2E test that:
- Starts two relay nodes on localhost with DIFFERENT ports (e.g., 16001 and 16002)
- Both using the same content topic and cluster config
- Node A subscribes, Node B sends via relay, verify Node A receives
- Uses `@waku/relay`'s `createRelayNode` or the same hybrid approach
- Both nodes use `wakuGossipSub` for gossipsub
- Both nodes use `defaultBootstrap: true` for peer discovery

## Key APIs from @waku/sdk and @waku/relay:
```
import { createRelayNode, Relay, wakuGossipSub } from '@waku/relay'
import { createLibp2pAndUpdateOptions, WakuNode, waitForRemotePeer, Protocols } from '@waku/sdk'
import { createRoutingInfo } from '@waku/utils'
```

For the hybrid node approach:
```
const opts = { 
  defaultBootstrap: true,
  networkConfig: { clusterId: 1, numShardsInCluster: 8 },
  routingInfos: [routingInfo],
  libp2p: { 
    addresses: { listen: ['/ip4/0.0.0.0/tcp/16001/ws'] },
    filterMultiaddrs: false,
    services: { pubsub: wakuGossipSub({ defaultBootstrap: true }) }
  }
}
const libp2p = await createLibp2pAndUpdateOptions(opts)
const pubsubTopics = [routingInfo.pubsubTopic]
const relay = new Relay({ pubsubTopics, libp2p })
const node = new WakuNode(opts, libp2p, { filter: true }, relay)
await node.start()

const encoder = node.createEncoder({ contentTopic })
const decoder = node.createDecoder({ contentTopic })
node.relay.subscribeWithUnsubscribe([decoder], (msg) => { ... })
await node.relay.send(encoder, { payload: new TextEncoder().encode('hello') })
```

## Verification
1. `npm run build` must pass (tsc with no errors)
2. The e2e test must print PASS/FAIL at the end with clear diagnostics
3. Run: `node scripts/test-waku-e2e.mjs`
4. Report the test result