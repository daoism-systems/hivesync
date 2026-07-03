#!/bin/bash
# on-message hook — called by the HiveSync daemon for every incoming
# TEXT / COMMAND from a trusted peer.
#
# STDIN: full message JSON
# Env:   HIVESYNC_MSG_ID, HIVESYNC_FROM, HIVESYNC_TYPE,
#        HIVESYNC_AUTO (1|0), HIVESYNC_TIMESTAMP

INBOX_DIR="/home/deck/.openclaw/workspace/hivesync-inbox"
mkdir -p "$INBOX_DIR"

MSG_FILE="${INBOX_DIR}/$(date +%Y%m%d-%H%M%S)-${HIVESYNC_MSG_ID}.json"

# Write the full message for Claw to read
cat > "$MSG_FILE" <<EOF
{
  "id": "${HIVESYNC_MSG_ID}",
  "from": "${HIVESYNC_FROM}",
  "type": "${HIVESYNC_TYPE}",
  "auto": "${HIVESYNC_AUTO}",
  "timestamp": "${HIVESYNC_TIMESTAMP}",
  "payload": $(cat)
}
EOF

# Log it
echo "$(date -Iseconds) INBOX: ${HIVESYNC_FROM} -> claw [${HIVESYNC_TYPE}] auto=${HIVESYNC_AUTO}" >> "$INBOX_DIR/history.log"

# Wake Claw immediately — no polling needed
openclaw system event --text "HIVESYNC_MESSAGE: from ${HIVESYNC_FROM}" --mode now 2>/dev/null
