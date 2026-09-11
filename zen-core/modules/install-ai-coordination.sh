#!/usr/bin/env bash
# install-ai-coordination.sh — installs the Zen AI Coordination Server
# as a systemd service, generates a random auth token, and starts it.
set -euo pipefail

ZEN_CORE_DIR="/opt/zen-core"
MODULE_DIR="${ZEN_CORE_DIR}/modules"
TOKEN_FILE="/etc/zen/ai-coordination-token"
SERVICE_FILE="/etc/systemd/system/zen-ai-coordination.service"
LISTEN_ADDR="127.0.0.1"
LISTEN_PORT="4141"

echo "[zen-ai-coordination] Installing..."

# 1) Directories
mkdir -p "${MODULE_DIR}"
mkdir -p /var/log/zen
chmod 700 /var/log/zen

# 2) Copy module
if [ ! -f "${MODULE_DIR}/ai-coordination-server.ts" ]; then
  cp "/opt/zen-iso/zen-core/modules/ai-coordination-server.ts" "${MODULE_DIR}/" 2>/dev/null || true
fi

# 3) Compile TS if node + tsx available, otherwise ship as-is
if command -v npx &>/dev/null; then
  npx tsx --transpile-only "${MODULE_DIR}/ai-coordination-server.ts" --outDir "${MODULE_DIR}/" 2>/dev/null || true
fi

# 4) Generate token (if not already set)
if [ -f "${TOKEN_FILE}" ]; then
  echo "[zen-ai-coordination] Token already exists at ${TOKEN_FILE}"
else
  mkdir -p /etc/zen
  openssl rand -hex 32 > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
  echo "[zen-ai-coordination] Token generated at ${TOKEN_FILE}"
fi

# 5) Create zen user if not exists
if ! id zen &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin zen
fi

# 6) Install systemd unit
cp "$(dirname "$0")/ai-coordination-service" "${SERVICE_FILE}"
systemctl daemon-reload

# 7) Start service
systemctl enable zen-ai-coordination.service
systemctl start zen-ai-coordination.service

echo "[zen-ai-coordination] Installed and started."
echo "[zen-ai-coordination] Listen: http://${LISTEN_ADDR}:${LISTEN_PORT}/mcp"
echo "[zen-ai-coordination] Token: $(cat "${TOKEN_FILE}" 2>/dev/null || echo '<redacted>')"
echo "[zen-ai-coordination] Test: curl -H 'Authorization: Bearer \$(cat ${TOKEN_FILE})' http://${LISTEN_ADDR}:${LISTEN_PORT}/mcp"
