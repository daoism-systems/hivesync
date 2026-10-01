#!/usr/bin/env bash
# =============================================================================
# HiveSync Hermes Setup — one-command integration with Hermes Agent
#
# Usage:
#   bash hermes-setup.sh [agent-name]
#
# Idempotent: safe to re-run; skips unchanged steps.
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

command -v node &>/dev/null || { fail "Node.js is not installed (node 22+ required)"; MISSING=1; }
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo 0)
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo -e "${RED}  ✗${NC} Node.js 22+ required (found v${NODE_MAJOR}.x)" >&2
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

# ── 4. Determine whether config needs (re)writing ─────────────────────────────
header "Checking config"

mkdir -p "$HERMES_HOME"
touch "$ENV_FILE"

EXISTING_AGENT=""
CONFIG_FILE="${REPO_DIR}/config/hivesync.yaml"
[[ -f "$CONFIG_FILE" ]] && EXISTING_AGENT=$(awk '/^agentId:/{print $2}' "$CONFIG_FILE" | tr -d '"' | tr -d "'")

NEED_CONFIG=0
[[ ! -f "$CONFIG_FILE" ]] && NEED_CONFIG=1
[[ "$EXISTING_AGENT" != "$AGENT_ID" ]] && NEED_CONFIG=1

if [[ "$NEED_CONFIG" -eq 1 ]]; then
  info "config/hivesync.yaml will be written for agent '${AGENT_ID}'"
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
description: "P2P messaging gateway platform built on the Logos Messaging protocol"
version: 1.0.0
author: HiveSync
license: MIT
emoji: "🐝"
kind: platform
adapter_module: adapter
register_function: register
requires_env:
  - HIVESYNC_HOME
  - HIVESYNC_AGENT_ID
install_hint: "Requires Node.js 22+ and a running HiveSync daemon (hivesync.service)"
YAML

ok "Plugin installed at ${PLUGIN_DIR}/"

# ── 7. Update ~/.hermes/config.yaml ──────────────────────────────────────────
header "Configuring Hermes gateway"

if [[ ! -f "$CONFIG_YAML" ]]; then
  mkdir -p "$HERMES_HOME"
  printf 'gateway:\n  platforms: {}\n' > "$CONFIG_YAML"
  info "Created ${CONFIG_YAML}"
fi

BACKUP="${CONFIG_YAML}.bak-hivesync-$(date +%Y%m%d%H%M%S)"
cp "$CONFIG_YAML" "$BACKUP"

# Upsert the hivesync block under whichever platforms mapping the config
# already uses (gateway.platforms, else top-level platforms), matching that
# mapping's own indentation. The result is parsed back before it is written;
# on any failure the config is left untouched.
HS_CONFIG_YAML="$CONFIG_YAML" HS_HOME="$REPO_DIR" HS_AGENT_ID="$AGENT_ID" \
HS_DB_PATH="${REPO_DIR}/data/hivesync.db" python3 - << 'PYEOF' || fail "Could not update ${CONFIG_YAML} (unchanged; backup at ${BACKUP})"
import os, re, sys

path = os.environ["HS_CONFIG_YAML"]
lines = open(path).read().splitlines()

def indent(line):
    return len(line) - len(line.lstrip(" "))

def blank(line):
    return not line.strip() or line.lstrip().startswith("#")

def block_end(i):
    """Index after the block whose key is on line i (next line at <= its indent)."""
    j = i + 1
    while j < len(lines) and (blank(lines[j]) or indent(lines[j]) > indent(lines[i])):
        j += 1
    return j

def find_key(key, parent=None):
    """Line index of `key:`; top-level if parent is None, else a direct child of line `parent`."""
    if parent is None:
        rng, want = range(len(lines)), 0
    else:
        rng = range(parent + 1, block_end(parent))
        kids = [indent(lines[k]) for k in rng if not blank(lines[k])]
        if not kids:
            return None
        want = min(kids)
    for k in rng:
        if indent(lines[k]) == want and re.match(r"\s*" + key + r":(\s|$)", lines[k]):
            return k
    return None

gw = find_key("gateway")
plat = find_key("platforms", gw) if gw is not None else None
if plat is None:
    plat = find_key("platforms")
if plat is None:
    if gw is None:
        lines += ["gateway:", "  platforms:"]
        plat = len(lines) - 1
    else:
        child = next((indent(l) for l in lines[gw + 1:block_end(gw)] if not blank(l)), 2)
        lines.insert(gw + 1, " " * child + "platforms:")
        plat = gw + 1

value = lines[plat].split(":", 1)[1].split("#", 1)[0].strip()
if value == "{}":
    lines[plat] = lines[plat].split(":", 1)[0] + ":"
elif value:
    sys.exit(f"{path}: 'platforms' is an inline mapping ({value}); convert it to block style and re-run")

# Drop an existing hivesync block, then insert a fresh one at the children's indent.
hs = find_key("hivesync", plat)
if hs is not None:
    del lines[hs:block_end(hs)]
kids = [indent(l) for l in lines[plat + 1:block_end(plat)] if not blank(l)]
pad = " " * (min(kids) if kids else indent(lines[plat]) + 2)
block = [
    "hivesync:",
    "  enabled: true",
    "  extra:",
    f"    home: {os.environ['HS_HOME']}",
    f"    agent_id: {os.environ['HS_AGENT_ID']}",
    f"    db_path: {os.environ['HS_DB_PATH']}",
    "    poll_interval: 15",
    "    allow_all: true",
]
lines[plat + 1:plat + 1] = [pad + b for b in block]
text = "\n".join(lines) + "\n"

try:
    import yaml
except ImportError:
    print("  (PyYAML not available to python3 — skipped parse check)")
else:
    data = yaml.safe_load(text)
    platforms = ((data.get("gateway") or {}).get("platforms") or {}).get("hivesync") \
        or (data.get("platforms") or {}).get("hivesync")
    if not platforms:
        sys.exit("generated config does not resolve to a hivesync platform block")

open(path, "w").write(text)
PYEOF
ok "hivesync platform configured in ${CONFIG_YAML} (backup: ${BACKUP})"

# User plugins are opt-in (config schema v21+): enable it explicitly.
if command -v hermes &>/dev/null; then
  hermes plugins enable hivesync >/dev/null 2>&1 \
    && ok "Enabled Hermes plugin 'hivesync'" \
    || warn "Could not enable the plugin — run: hermes plugins enable hivesync"
else
  warn "hermes not on PATH — enable the plugin later: hermes plugins enable hivesync"
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
set_env_var "HIVESYNC_POLL_INTERVAL" "15"

ok "Environment variables written to ~/.hermes/.env"

# ── 9. HiveSync daemon (systemd user service) ────────────────────────────────
# The adapter only queues outgoing messages in the DB; this long-lived daemon
# holds the Logos Messaging connection, drains that outbox and retries until delivery.
header "Setting up the HiveSync daemon"

SERVICE_FILE="${HOME}/.config/systemd/user/hivesync.service"
mkdir -p "$(dirname "$SERVICE_FILE")"
cat > "$SERVICE_FILE" << SERVICEEOF
[Unit]
Description=HiveSync daemon (${AGENT_ID})
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$(command -v node) ${REPO_DIR}/dist/cli.js start --daemon
WorkingDirectory=${REPO_DIR}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
SERVICEEOF

if systemctl --user daemon-reload 2>/dev/null; then
  systemctl --user enable hivesync.service >/dev/null 2>&1 || true
  systemctl --user restart hivesync.service 2>/dev/null || true
  sleep 2
  if systemctl --user is-active hivesync.service &>/dev/null; then
    ok "hivesync.service running"
  else
    warn "hivesync.service did not start — check: journalctl --user -u hivesync -n 50"
  fi
  command -v loginctl &>/dev/null && ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes" \
    && warn "To keep the daemon running after logout/at boot: loginctl enable-linger $USER"
else
  warn "systemd user session not available — run the daemon yourself:"
  warn "  cd ${REPO_DIR} && node dist/cli.js start --daemon"
fi

# ── 10. Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  HiveSync + Hermes setup complete!${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Agent ID :${NC}  ${AGENT_ID}"
echo -e "  ${BOLD}Config   :${NC}  ${CONFIG_FILE}"
echo -e "  ${BOLD}Plugin   :${NC}  ${PLUGIN_DIR}/"
echo ""
echo -e "  ${CYAN}Trust model (handshake approval):${NC}"
echo -e "    When another agent first messages you, approve them with:"
echo -e "      node dist/cli.js approve <their-agent-id>"
echo -e "    Reject with:"
echo -e "      node dist/cli.js deny <their-agent-id>"
echo -e "    Until approved, their messages are held in quarantine:"
echo -e "      node dist/cli.js quarantine"
echo ""
echo -e "  ${CYAN}Start the gateway:${NC}"
echo -e "    hermes gateway run"
echo ""
