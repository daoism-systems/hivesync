Remove the password auth system entirely. The handshake trust model replaces it.

## Changes needed

### 1. src/core/bridge-manager.ts — modify classify()

The classify() method currently:
- If no auth.hash → trusted=true (open mode)
- If auth.hash → checks __auth password field

Replace with:
- If auth.hash is set (legacy backward compat) → old password logic
- If NO auth.hash → check handshake status of the sender:
  - If sender has handshake_status='confirmed' → trusted=true
  - Otherwise → trusted=false (message quarantined)

Remove the AUTH_FIELD constant and all __auth references from bridge-manager.ts:
- Delete the AUTH_FIELD constant
- Remove __auth from outbox messages (in processOutbox(), sendText())
- Remove sessionPasswords map and setAgentPassword/clearAgentPassword/hasAgentPassword methods
- Remove peerPasswords loading from start()

Keep AUTO_FIELD (for auto-reply detection).

### 2. src/core/bridge-manager.ts — handle unknown sender in classify()

When hivesync.getHandshakeStatus() returns null (unknown agent), they should also be untrusted. It means the agent hasn't been discovered yet.

### 3. Config cleanup in hivesync.yaml
Remove the peerPasswords section — no longer needed.

### 4. src/utils/tui.ts — remove empty password guard
There was a bug fix that added an empty password guard. That's no longer relevant.

## IMPORTANT: Verify build compiles
Run `npm run build` after changes.

## Files to modify
- src/core/bridge-manager.ts (main logic)
- src/utils/tui.ts (if referenced by the old auth code)

Do NOT restart the daemon.