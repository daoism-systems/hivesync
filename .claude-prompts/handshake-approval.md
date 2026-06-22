I need to implement a handshake approval system in HiveSync. Here are the exact changes needed across 5 files.

## Background
Currently when handleHandshakeInit() receives a handshake_init, it auto-accepts. We need to replace this with user-approval: the agent asks the user for permission before accepting. The daemon writes to a "handshake_approvals" table, the Hermes adapter surfaces it, user approves via CLI, daemon polls for completion.

## Changes Required

### 1. src/types/index.ts
Add "reason?: string" to HandshakeAckPayload:
```
export interface HandshakeAckPayload {
  accepted: boolean;
  agentName: string;
  agentVersion: string;
  capabilities: string[];
  timestamp: number;
  reason?: string; // "pending_approval" when user approval is needed
}
```

Add HandshakeApproval interface:
```
export interface HandshakeApproval {
  id: string;
  agent_id: string;
  agent_name: string;
  capabilities: string[];
  status: "pending" | "approved" | "denied";
  created_at: Date;
  responded_at?: Date;
}
```

### 2. src/storage/storage-manager.ts
Add this import at top: `import { v4 as uuidv4 } from 'uuid';`

Inside createTables() after the sync_state table creation, add:
```
await this.db.exec(`
  CREATE TABLE IF NOT EXISTS handshake_approvals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    agent_name TEXT,
    capabilities TEXT,
    status TEXT DEFAULT "pending",
    created_at DATETIME,
    responded_at DATETIME
  )
`);
```

Add these methods to StorageManager class:

Method createHandshakeApproval(agentId, agentName, capabilities):
- Creates uuidv4() id
- INSERT INTO handshake_approvals with status='pending'
- Returns the id

Method getPendingApprovals():
- SELECT * FROM handshake_approvals WHERE status = 'pending' ORDER BY created_at ASC
- Map rows to HandshakeApproval objects (parse capabilities JSON)

Method approveHandshakeByAgent(agentId):
- UPDATE handshake_approvals SET status = 'approved', responded_at = NOW WHERE agent_id = ? AND status = 'pending'
- Returns boolean (true if any row affected)

Method denyHandshakeByAgent(agentId):
- UPDATE handshake_approvals SET status = 'denied', responded_at = NOW WHERE agent_id = ? AND status = 'pending'
- Returns boolean

Method getRecentlyApproved():
- SELECT * FROM handshake_approvals WHERE status = 'approved' AND responded_at > (NOW - 30 seconds)
- Returns HandshakeApproval[]

Need a private rowToApproval(row) helper.

Also add a private migrateHandshakeApprovals() method (idempotent, for future migrations) and call it at end of createTables().

### 3. src/core/hivesync-bridge.ts

Modify sendHandshakeAck() to accept optional reason param:
- Add parameter `reason?: string`
- If reason is provided, add it to the payload

Modify handleHandshakeInit():
- Instead of auto-accepting, send ack with accepted=false, reason='pending_approval'
- Set known.handshakeStatus = 'pending'
- Emit handshakeApprovalNeeded event with {agentId, agentName, capabilities}
- Do NOT mark as confirmed

Add handler storage and registration for handshakeApprovalNeeded:
- Add `private readonly handshakeApprovalNeededHandlers` array
- Add `onHandshakeApprovalNeeded(handler)` method
- In handleHandshakeInit, call all handlers

Add completeHandshakeApproval(agentId):
- Mark known.handshakeStatus = 'confirmed'
- Send handshakeAck with accepted=true
- Notify handshake confirmed

Modify handleHandshakeAck():
- When !accepted and reason === 'pending_approval', set status='pending' (not 'failed')
- Log appropriately for each case

### 4. src/core/bridge-manager.ts

Add private field: `private approvalTimer: NodeJS.Timeout | null = null;`

In start(), after outboxTimer setup:
- Subscribe to hivesync.onHandshakeApprovalNeeded() -> call storage.createHandshakeApproval()
- Set up approvalTimer (3s interval) polling getRecentlyApproved() -> calling hivesync.completeHandshakeApproval()
- Process any pending approvals on startup (re-emit events)

In stop(), clear approvalTimer.

Add methods:
- getPendingApprovals() -> storage.getPendingApprovals()
- approveHandshake(agentId) -> storage.approveHandshakeByAgent() + hivesync.completeHandshakeApproval()
- denyHandshake(agentId) -> storage.denyHandshakeByAgent()

### 5. src/cli.ts

Add two new commands:

```
approve <agentId> - Approve a pending handshake request
```
Starts bridge, calls bridge.approveHandshake(), stops bridge, shows green checkmark or "no pending" message.

```
deny <agentId> - Deny a pending handshake request
```
Starts bridge, calls bridge.denyHandshake(), stops bridge, shows yellow X or "no pending" message.

### BUILD AND VERIFY
After all changes, run `npm run build` and fix any TypeScript errors.

IMPORTANT: Do NOT restart the daemon. The daemon is already running (PID 52034).

## Constraints
- Keep existing auto-initiation on discovery (handleAnnounce still triggers sendHandshakeInit)
- ONLY change what happens when handshake_init is RECEIVED - now it waits for approval
- When the initiator receives handshake_ack with reason='pending_approval', it should set status='pending' not 'failed'
- All existing functionality (outbox, sync, send, etc.) must remain intact
- The approve/deny CLI commands start a bridge, approve/deny, then stop