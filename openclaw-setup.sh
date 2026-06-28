#!/usr/bin/env bash
# =============================================================================
# HiveSync OpenClaw Setup — one-command integration with OpenClaw Agent
#
# Usage:
#   bash openclaw-setup.sh [agent-name]
#
# Idempotent: safe to re-run; skips unchanged steps.
# =============================================================================

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
OC_CONFIG="${HOME}/.openclaw/openclaw.json"
BRIDGE_DIR="${HOME}/.openclaw/workspace/hivesync-openclaw-plugin"
PLUGIN_DIR="${BRIDGE_DIR}/plugin"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}  →${NC} $1"; }
ok()    { echo -e "${GREEN}  ✓${NC} $1"; }
warn()  { echo -e "${YELLOW}  ⚠${NC} $1"; }
fail()  { echo -e "${RED}  ✗${NC} $1" >&2; exit 1; }
header(){ echo -e "\n${BOLD}${CYAN}══ $1 ══${NC}\n"; }

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
header "Checking prerequisites"

MISSING=0
command -v node &>/dev/null || { fail "Node.js 18+ required"; MISSING=1; }
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo 0)
[[ "$NODE_MAJOR" -lt 18 ]] && fail "Node.js 18+ required (found v${NODE_MAJOR}.x)"
ok "Node.js $(node --version)"

command -v npm &>/dev/null || fail "npm not found"
ok "npm $(npm --version)"

if command -v openclaw &>/dev/null; then
  ok "OpenClaw $(openclaw --version 2>/dev/null | head -1 || echo 'present')"
else
  warn "openclaw not found — install it first:"
  warn "  curl -fsSL https://docs.openclaw.ai/install.sh | bash"
  warn "  (or continue with config-only setup)"
fi

[[ "$MISSING" -ne 0 ]] && fail "Fix missing prerequisites above and re-run."

# ── 2. Agent name ─────────────────────────────────────────────────────────────
header "Agent identity"

AGENT_NAME="${1:-claw}"
AGENT_ID=$(echo "${AGENT_NAME}" | tr '[:upper:]' '[:lower:]' | tr -s ' ' | tr ' ' '-')
info "Agent ID: ${AGENT_ID}"

# ── 3. Build HiveSync ────────────────────────────────────────────────────────
header "Building HiveSync"

cd "$REPO_DIR"
info "npm install..."
npm install --silent 2>/dev/null
ok "npm install complete"

info "npm run build..."
npm run build 2>/dev/null
ok "Build complete — dist/cli.js ready"

# ── 4. Generate credentials ─────────────────────────────────────────────────
header "Generating credentials"

PASSWORD=$(node -e "
  const c = require('crypto');
  let s = '';
  while (s.length < 32) s += c.randomBytes(32).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  process.stdout.write(s.slice(0, 32));
")
SCRYPT_SALT=$(node -e "const c=require('crypto');process.stdout.write(c.randomBytes(16).toString('base64'))")
SCRYPT_HASH=$(node -e "
  const c=require('crypto');
  const p=Buffer.from('${PASSWORD}','utf-8');
  const s=Buffer.from('${SCRYPT_SALT}','base64');
  process.stdout.write(c.scryptSync(p,s,32).toString('base64'));
")
ok "Password generated + scrypt hash computed"

# ── 5. Write HiveSync daemon config ──────────────────────────────────────────
header "Writing HiveSync daemon config"

mkdir -p "${REPO_DIR}/config" "${REPO_DIR}/data"

CONFIG_FILE="${REPO_DIR}/config/hivesync.yaml"
NEED_CONFIG=0
if [[ -f "$CONFIG_FILE" ]]; then
  EXISTING_AGENT=$(awk '/^agentId:/{print $2}' "$CONFIG_FILE" | tr -d '"' | tr -d "'" 2>/dev/null || echo "")
  [[ "$EXISTING_AGENT" != "$AGENT_ID" ]] && NEED_CONFIG=1
else
  NEED_CONFIG=1
fi

if [[ "$NEED_CONFIG" -eq 1 ]]; then
  cat > "$CONFIG_FILE" << YAML
# HiveSync Configuration
agentId: ${AGENT_ID}
agentName: "${AGENT_NAME}"
storagePath: ${REPO_DIR}/data/hivesync.db
syncInterval: 30

auth:
  salt: "${SCRYPT_SALT}"
  hash: "${SCRYPT_HASH}"
  autoReply: "✓ received"

waku:
  listenAddresses:
    - /ip4/0.0.0.0/tcp/0/ws
  bootstrapNodes: []
  clusterId: 1
  numShardsInCluster: 8
  contentTopic: /hivesync/1/agents/proto
  keepAlive: true
  maxPeers: 10

obsidian:
  enabled: false
YAML
  ok "Wrote config/hivesync.yaml"
else
  ok "config/hivesync.yaml up-to-date for agent '${AGENT_ID}'"
fi

# ── 6. Create OpenClaw bridge plugin ────────────────────────────────────────
header "Creating OpenClaw bridge"

# Clone the bridge plugin repo if not present
if [[ ! -d "$BRIDGE_DIR" ]]; then
  info "Cloning hivesync-openclaw-plugin..."
  git clone --depth=1 https://github.com/clawbotl37/hivesync-openclaw-plugin.git "$BRIDGE_DIR" 2>/dev/null || {
    warn "Git clone failed — creating minimal bridge"
    mkdir -p "$BRIDGE_DIR"
  }
fi

# Install bridge dependencies
if [[ -f "${BRIDGE_DIR}/package.json" ]]; then
  cd "$BRIDGE_DIR"
  npm install --silent 2>/dev/null
  npx tsc 2>/dev/null || info "Bridge build skipped (not required for plugin)"
  ok "Bridge dependencies installed"
fi

# ── 7. Write or update OpenClaw config ──────────────────────────────────────
header "Configuring OpenClaw"

mkdir -p "$(dirname "$OC_CONFIG")"

if [[ ! -f "$OC_CONFIG" ]]; then
  echo '{"plugins":{"entries":{}},"channels":{}}' > "$OC_CONFIG"
  info "Created OpenClaw config"
fi

# Add the hivesync channel config using node (safer than sed for JSON)
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('${OC_CONFIG}', 'utf-8'));

// Ensure channels object exists
if (!cfg.channels) cfg.channels = {};

// Write hivesync channel config
cfg.channels.hivesync = {
  agentId: '${AGENT_ID}',
  agentName: '${AGENT_NAME}',
  storagePath: '${REPO_DIR}/data/hivesync.db',
  cliPath: '${REPO_DIR}/dist/cli.js',
  dmPolicy: 'open'
};

// Ensure plugins.entries exists
if (!cfg.plugins) cfg.plugins = { entries: {} };
if (!cfg.plugins.entries) cfg.plugins.entries = {};

fs.writeFileSync('${OC_CONFIG}', JSON.stringify(cfg, null, 2));
console.log('updated');
" && ok "Updated ${OC_CONFIG} with hivesync channel config"

# ── 8. Install OpenClaw plugin ──────────────────────────────────────────────
header "Installing OpenClaw plugin"

if command -v openclaw &>/dev/null && [[ -d "$PLUGIN_DIR" ]]; then
  # Check if already installed
  if openclaw plugins list 2>/dev/null | grep -qi hivesync; then
    ok "HiveSync plugin already installed"
  else
    openclaw plugins install "$PLUGIN_DIR" --link 2>&1 | head -3 || {
      warn "Plugin install failed — install manually later:"
      warn "  openclaw plugins install ${PLUGIN_DIR} --link"
      warn "  openclaw gateway restart"
    }
  fi
else
  warn "OpenClaw not found — install plugin manually:"
  warn "  openclaw plugins install ${PLUGIN_DIR} --link"
  warn "  openclaw gateway restart"
fi

# ── 9. Configure systemd services ───────────────────────────────────────────
header "Setting up systemd services"

# Daemon service (hivesync.service)
cat > "${HOME}/.config/systemd/user/hivesync.service" << SERVICEEOF
[Unit]
Description=HiveSync P2P Agent Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(which node) ${REPO_DIR}/dist/cli.js start --daemon
WorkingDirectory=${REPO_DIR}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
SERVICEEOF

# Bridge + inhibitor service
cat > "${HOME}/.config/systemd/user/hivesync-bridge.service" << SERVICEEOF
[Unit]
Description=HiveSync OpenClaw bridge + sleep inhibitor
After=hivesync.service
BindsTo=hivesync.service

[Service]
Type=simple
ExecStart=/usr/bin/systemd-inhibit --what=sleep --why="HiveSync bridge running" $(which node) ${BRIDGE_DIR}/dist/bridge.js
WorkingDirectory=${BRIDGE_DIR}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=TELEGRAM_CHAT_ID=738354370
Environment=MY_AGENT_ID=${AGENT_ID}
Environment=POLL_INTERVAL_MS=5000
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
SERVICEEOF

systemctl --user daemon-reload 2>/dev/null
systemctl --user enable hivesync.service 2>/dev/null || true
systemctl --user enable hivesync-bridge.service 2>/dev/null || true
ok "Systemd services configured"

# Enable linger so user services start at boot
loginctl enable-linger "$(whoami)" 2>/dev/null || true

# ── 10. Health check ────────────────────────────────────────────────────────
header "Health check"

if systemctl --user is-active hivesync.service &>/dev/null; then
  ok "HiveSync daemon is running"
  # Check daemon can reach peers
  cd "$REPO_DIR"
  STATUS=$(timeout 15 node dist/cli.js status 2>/dev/null)
  echo "$STATUS" | grep -i "connected\|peer" | head -3
else
  warn "Daemon not running yet — start manually: systemctl --user start hivesync.service"
fi

# ── 11. Done ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  HiveSync + OpenClaw setup complete!${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Agent ID :${NC}  ${AGENT_ID}"
echo -e "  ${BOLD}Password :${NC}  ${PASSWORD}"
echo -e "  ${BOLD}Config   :${NC}  ${CONFIG_FILE}"
echo ""
echo -e "  ${CYAN}Trust model (handshake approval):${NC}"
echo -e "    When another agent first messages you, approve them with:"
echo -e "      node dist/cli.js approve <their-agent-id>"
echo -e "    Reject with:"
echo -e "      node dist/cli.js deny <their-agent-id>"
echo -e "    Until approved, their messages are held in quarantine:"
echo -e "      node dist/cli.js quarantine"
echo ""
echo -e "  ${CYAN}Start the daemon:${NC}"
echo -e "    systemctl --user start hivesync.service"
echo -e ""
echo -e "  ${CYAN}Start the bridge:${NC}"
echo -e "    systemctl --user start hivesync-bridge.service"
echo -e ""
echo -e "  ${CYAN}Check status:${NC}"
echo -e "    ${REPO_DIR}/dist/cli.js status"
echo -e ""
echo -e "  ${CYAN}Restart OpenClaw gateway (to load plugin):${NC}"
echo -e "    openclaw gateway restart"
echo ""
