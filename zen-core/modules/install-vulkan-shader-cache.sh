#!/usr/bin/env bash
# install-vulkan-shader-cache.sh — installs the Zen Vulkan Shader Cache
# Pre-compiles SPIR-V shaders and warms pipeline cache for instant reload.
set -euo pipefail

ZEN_CORE_DIR="/opt/zen-core"
MODULE_DIR="/opt/zen-core/modules"
CACHE_DIR="/var/cache/zen/shader-cache"
SERVICE_FILE="/etc/systemd/system/zen-vulkan-shader-cache.service"
LOG_DIR="/var/log/zen"

echo "[zen-vulkan] Installing..."

# 1) Cache directory
mkdir -p "${CACHE_DIR}"
mkdir -p "${CACHE_DIR}/spirv"
mkdir -p "${LOG_DIR}"
chmod 755 "${CACHE_DIR}"
chmod 700 "${LOG_DIR}"

# 2) Create zen user if not exists
if ! id zen &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin zen
fi

# 3) Install the module (compiled or source)
if [ -f "${MODULE_DIR}/vulkan-shader-cache.ts" ]; then
  # Try compile with tsx if available
  if command -v npx &>/dev/null; then
    npx tsx --transpile-only "${MODULE_DIR}/vulkan-shader-cache.ts" --outDir "${MODULE_DIR}/vulkan-shader-cache.js" 2>/dev/null || true
  fi
  # Fallback: copy as .ts
  cp "${MODULE_DIR}/vulkan-shader-cache.ts" "${MODULE_DIR}/vulkan-shader-cache.js" 2>/dev/null || true
fi

chown -R zen:zen "${CACHE_DIR}" "${LOG_DIR}"

# 4) Install systemd unit
cp "$(dirname "$0")/vulkan-shader-cache-service" "${SERVICE_FILE}"

# 5) Enable + start
systemctl daemon-reload
systemctl enable zen-vulkan-shader-cache.service

# Pre-warm at boot (runs once on first start)
systemctl start zen-vulkan-shader-cache.service 2>/dev/null || true

echo "[zen-vulkan] Installed."
echo "[zen-vulkan] Cache: ${CACHE_DIR}"
echo "[zen-vulkan] Service: zen-vulkan-shader-cache.service"
echo "[zen-vulkan] Status: $(systemctl is-active zen-vulkan-shader-cache.service 2>/dev/null || echo 'starting')"
echo "[zen-vulkan] Logs: journalctl -u zen-vulkan-shader-cache -f"
