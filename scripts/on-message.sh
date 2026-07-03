#!/bin/bash
# on-message hook — called by the HiveSync daemon for every incoming
# TEXT / COMMAND from a trusted peer.
#
# STDIN: full message JSON
# Env:   HIVESYNC_MSG_ID, HIVESYNC_FROM, HIVESYNC_TYPE,
#        HIVESYNC_AUTO (1|0), HIVESYNC_TIMESTAMP

INBOX_DIR="/home/deck/.openclaw/workspace/hivesync-inbox"
mkdir -p "$INBOX_DIR"

# Read payload from stdin
PAYLOAD=$(cat)

MSG_FILE="${INBOX_DIR}/$(date +%Y%m%d-%H%M%S)-${HIVESYNC_MSG_ID}.json"

# Write the full message for Claw to read
cat > "$MSG_FILE" <<EOF
{
  "id": "${HIVESYNC_MSG_ID}",
  "from": "${HIVESYNC_FROM}",
  "type": "${HIVESYNC_TYPE}",
  "auto": "${HIVESYNC_AUTO}",
  "timestamp": "${HIVESYNC_TIMESTAMP}",
  "payload": ${PAYLOAD}
}
EOF

# Log it
echo "$(date -Iseconds) INBOX: ${HIVESYNC_FROM} -> claw [${HIVESYNC_TYPE}] auto=${HIVESYNC_AUTO}" >> "$INBOX_DIR/history.log"

# Forward a summary to Telegram (skip autoreply pings to avoid noise)
if [ "${HIVESYNC_AUTO}" != "1" ]; then
  # Extract message text
  MSG_TEXT=$(echo "${PAYLOAD}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('content',{}).get('text','')[:200])" 2>/dev/null)
  if [ -n "${MSG_TEXT}" ]; then
    TELEGRAM_MSG="📩 *HiveSync* — ${HIVESYNC_FROM}\n\n${MSG_TEXT}"
    openclaw message send --channel telegram --target 738354370 --message "${TELEGRAM_MSG}" 2>/dev/null
  fi
fi

# Wake Claw immediately — no polling needed
openclaw system event --text "HIVESYNC_MESSAGE: from ${HIVESYNC_FROM}" --mode now 2>/dev/null
