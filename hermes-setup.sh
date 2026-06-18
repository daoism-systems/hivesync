#!/usr/bin/env bash
# =============================================================================
# HiveSync Hermes Setup — one-command integration with Hermes Agent
#
# Usage:
#   bash hermes-setup.sh [agent-name]
#
# Idempotent: safe to re-run; reuses existing password and skips unchanged steps.
# =============================================================================

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
HERMES_HOME="${HOME}/.hermes"
PLUGIN_DIR="${HERMES_HOME}/plugins/hivesync-platform"
CONFIG_YAML="${HERMES_HOME}/config.yaml"
ENV_FILE="${HERMES_HOME}/.env"

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

command -v node &>/dev/null || { fail "Node.js is not installed (node 18+ required)"; MISSING=1; }
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo 0)
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo -e "${RED}  ✗${NC} Node.js 18+ required (found v${NODE_MAJOR}.x)" >&2
  MISSING=1
else
  ok "Node.js $(node --version)"
fi

command -v npm &>/dev/null   || { echo -e "${RED}  ✗${NC} npm not found" >&2; MISSING=1; }
[[ "$MISSING" -eq 0 ]] && ok "npm $(npm --version)"

command -v git &>/dev/null   || { echo -e "${RED}  ✗${NC} git not found" >&2; MISSING=1; }
[[ "$MISSING" -eq 0 ]] && ok "git $(git --version | awk '{print $3}')"

if command -v hermes &>/dev/null; then
  ok "hermes $(hermes --version 2>/dev/null || echo 'present')"
else
  warn "hermes not found — files will be configured but install hermes first:"
  warn "  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
fi

[[ "$MISSING" -ne 0 ]] && fail "Fix missing prerequisites above and re-run."

# ── 2. Agent name ─────────────────────────────────────────────────────────────
header "Agent identity"

AGENT_NAME="${1:-myagent}"
AGENT_ID="${AGENT_NAME}"
info "Agent ID: ${AGENT_ID}"

# ── 3. npm install && npm run build ──────────────────────────────────────────
header "Building HiveSync"

cd "$REPO_DIR"
info "npm install..."
npm install --silent
ok "npm install complete"

info "npm run build..."
npm run build
ok "Build complete — dist/cli.js ready"

# ── 4. Generate password + scrypt hash ───────────────────────────────────────
header "Generating credentials"

mkdir -p "$HERMES_HOME"
touch "$ENV_FILE"

# Idempotent: reuse existing password from ~/.hermes/.env
if grep -q "^export HIVESYNC_PASSWORD=" "$ENV_FILE" 2>/dev/null; then
  PASSWORD=$(grep "^export HIVESYNC_PASSWORD=" "$ENV_FILE" | head -1 | sed 's/^export HIVESYNC_PASSWORD=//')
  info "Reusing existing password from ~/.hermes/.env"
else
  # 32 alphanumeric chars via node crypto (no +/= from base64)
  PASSWORD=$(node -e "
    const c = require('crypto');
    let s = '';
    while (s.length < 32) s += c.randomBytes(32).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    process.stdout.write(s.slice(0, 32));
  ")
  info "Generated new 32-char password"
fi

# Compute scrypt hash only when we need to write a new config
EXISTING_AGENT=""
CONFIG_FILE="${REPO_DIR}/config/hivesync.yaml"
[[ -f "$CONFIG_FILE" ]] && EXISTING_AGENT=$(awk '/^agentId:/{print $2}' "$CONFIG_FILE" | tr -d '"' | tr -d "'")

NEED_CONFIG=0
[[ ! -f "$CONFIG_FILE" ]] && NEED_CONFIG=1
[[ "$EXISTING_AGENT" != "$AGENT_ID" ]] && NEED_CONFIG=1

if [[ "$NEED_CONFIG" -eq 1 ]]; then
  # salt:hash stored together so we can verify without the plaintext password
  SCRYPT_COMBINED=$(node -e "
    const crypto = require('crypto');
    const password = process.argv[1];
    const salt = crypto.randomBytes(32);
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    process.stdout.write(salt.toString('base64') + ':' + hash.toString('base64'));
  " "$PASSWORD")
  ok "scrypt hash computed (N=16384)"
else
  info "config/hivesync.yaml up-to-date for agent '${AGENT_ID}' — skipping regeneration"
fi

# ── 5. Write config/hivesync.yaml ────────────────────────────────────────────
header "Writing HiveSync config"

mkdir -p "${REPO_DIR}/config" "${REPO_DIR}/data" "${REPO_DIR}/data/obsidian-knowledge"

if [[ "$NEED_CONFIG" -eq 1 ]]; then
  cat > "$CONFIG_FILE" << YAML
agentId: ${AGENT_ID}
agentName: "${AGENT_NAME}"
storagePath: ${REPO_DIR}/data/hivesync.db
syncInterval: 30

waku:
  listenAddresses:
    - /ip4/0.0.0.0/tcp/0/ws
  bootstrapNodes: []
  clusterId: 1
  numShardsInCluster: 8
  contentTopic: /hivesync/1/agents/proto
  keepAlive: true
  maxPeers: 10

auth:
  salt: "${SCRYPT_COMBINED}"
  autoReply: "✓ received"

obsidian:
  enabled: true
  vaultPath: ${REPO_DIR}/data/obsidian-knowledge
YAML
  ok "Wrote config/hivesync.yaml"
else
  ok "config/hivesync.yaml unchanged"
fi

# ── 6. Install Hermes plugin ──────────────────────────────────────────────────
header "Installing Hermes plugin"

mkdir -p "$PLUGIN_DIR"

# Copy adapter.py from repo's hermes-setup/ directory
if [[ -f "${REPO_DIR}/hermes-setup/adapter.py" ]]; then
  cp "${REPO_DIR}/hermes-setup/adapter.py" "${PLUGIN_DIR}/adapter.py"
  ok "Copied adapter.py from hermes-setup/"
else
  warn "hermes-setup/adapter.py not found — skipping adapter copy"
fi

# __init__.py
cat > "${PLUGIN_DIR}/__init__.py" << 'PYEOF'
from .adapter import register

__all__ = ["register"]
PYEOF

# plugin.yaml
cat > "${PLUGIN_DIR}/plugin.yaml" << YAML
name: hivesync
label: HiveSync
description: "P2P messaging gateway platform built on the Waku protocol"
version: 1.0.0
author: HiveSync
license: MIT
emoji: "🐝"
adapter_module: adapter
register_function: register
required_env:
  - HIVESYNC_HOME
  - HIVESYNC_AGENT_ID
install_hint: "Requires Node.js 18+ and a running HiveSync daemon (npm run build)"
YAML

ok "Plugin installed at ${PLUGIN_DIR}/"

# ── 7. Update ~/.hermes/config.yaml ──────────────────────────────────────────
header "Configuring Hermes gateway"

if [[ ! -f "$CONFIG_YAML" ]]; then
  cat > "$CONFIG_YAML" << YAML
gateway:
  platforms: {}
YAML
  info "Created ${CONFIG_YAML}"
fi

if grep -q "^    hivesync:" "$CONFIG_YAML" 2>/dev/null || grep -q "^  hivesync:" "$CONFIG_YAML" 2>/dev/null; then
  # Update existing block via Python
  python3 - << PYEOF
import re, sys

path = "${CONFIG_YAML}"
home = "${REPO_DIR}"
agent_id = "${AGENT_ID}"
db_path = "${REPO_DIR}/data/hivesync.db"

with open(path) as f:
    text = f.read()

block = """\
    hivesync:
      enabled: true
      extra:
        home: {home}
        agent_id: {agent_id}
        db_path: {db_path}
        poll_interval: 15
        allow_all: true
""".format(home=home, agent_id=agent_id, db_path=db_path)

# Replace existing hivesync block (everything from the hivesync: key until the
# next same-level key or end of the platforms section)
pattern = r'( {2,4})hivesync:.*?(?=\n\1\w|\n\ngateway|\Z)'
if re.search(pattern, text, re.DOTALL):
    text = re.sub(pattern, block.rstrip(), text, flags=re.DOTALL)
    with open(path, 'w') as f:
        f.write(text)
    print("updated")
else:
    print("no-match")
PYEOF
  ok "Updated hivesync block in ${CONFIG_YAML}"
else
  # Append new block under gateway.platforms
  python3 - << PYEOF
path = "${CONFIG_YAML}"
home = "${REPO_DIR}"
agent_id = "${AGENT_ID}"
db_path = "${REPO_DIR}/data/hivesync.db"

with open(path) as f:
    text = f.read()

block = """\
    hivesync:
      enabled: true
      extra:
        home: {home}
        agent_id: {agent_id}
        db_path: {db_path}
        poll_interval: 15
        allow_all: true
""".format(home=home, agent_id=agent_id, db_path=db_path)

if "platforms:" in text:
    # Insert after 'platforms:' line
    text = text.replace("platforms:", "platforms:\n" + block, 1)
elif "gateway:" in text:
    text = text.replace("gateway:", "gateway:\n  platforms:\n" + block, 1)
else:
    text += "\ngateway:\n  platforms:\n" + block

with open(path, 'w') as f:
    f.write(text)
PYEOF
  ok "Added hivesync platform to ${CONFIG_YAML}"
fi

# ── 8. Set env vars in ~/.hermes/.env ────────────────────────────────────────
header "Writing environment variables"

set_env_var() {
  local key="$1" val="$2"
  # Remove any existing line for this key, then append
  { grep -v "^export ${key}=" "$ENV_FILE" 2>/dev/null || true; } > "${ENV_FILE}.tmp"
  echo "export ${key}=${val}" >> "${ENV_FILE}.tmp"
  mv "${ENV_FILE}.tmp" "$ENV_FILE"
}

set_env_var "HIVESYNC_HOME"          "${REPO_DIR}"
set_env_var "HIVESYNC_AGENT_ID"      "${AGENT_ID}"
set_env_var "HIVESYNC_PASSWORD"      "${PASSWORD}"
set_env_var "HIVESYNC_POLL_INTERVAL" "15"

ok "Environment variables written to ~/.hermes/.env"

# ── 9. Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  HiveSync + Hermes setup complete!${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Agent ID :${NC}  ${AGENT_ID}"
echo -e "  ${BOLD}Password :${NC}  ${PASSWORD}"
echo -e "  ${BOLD}Config   :${NC}  ${CONFIG_FILE}"
echo -e "  ${BOLD}Plugin   :${NC}  ${PLUGIN_DIR}/"
echo ""
echo -e "  ${YELLOW}Share the password above with agents you want to allow to message you.${NC}"
echo ""
echo -e "  ${CYAN}Start the gateway:${NC}"
echo -e "    hermes gateway run"
echo ""
