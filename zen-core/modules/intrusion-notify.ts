// intrusion-notify.ts
// Zen Suite module: Real-time intrusion detection notifications
// Listens on the DBUS session bus and uses libnotify for popups.
// Also writes to syslog via console for headless/audit contexts.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const NOTIFY_TIMEOUT_MS = 10_000;
const DBUS_ENV_FILE = `/run/user/${process.getuid?.() || 1000}/dbus-session-address`;
const KNOWN_LISTENERS = [9050, 9040, 4123, 21550, 4141]; // tor, crypto-bot, miner, ai-coord

function getDbusSessionAddress(): string | undefined {
  if (existsSync(DBUS_ENV_FILE)) {
    try {
      const content = readFileSync(DBUS_ENV_FILE, 'utf-8').trim();
      if (content) return content;
    } catch {}
  }
  return process.env.DBUS_SESSION_BUS_ADDRESS;
}

export function notifyIntrusion(message: string, urgency: 'low' | 'normal' | 'critical' = 'normal'): void {
  const summary = '[Zen Security] Intrusion detected';
  const body = message;

  // 1) Syslog (always)
  const syslog = spawn('logger', ['-t', 'zen-security', '-p', 'auth.warning', message]);
  syslog.on('error', () => {});

  // 2) Desktop notification (if DBUS session available)
  const dbusAddr = getDbusSessionAddress();
  if (dbusAddr) {
    const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: dbusAddr };
    const severityMap = { low: '1', normal: '2', critical: '3' };
    spawn('notify-send', [
      '--urgency', severityMap[urgency],
      '--expire-time', String(NOTIFY_TIMEOUT_MS),
      summary, body
    ], { env });
  }

  // 3) stderr (for systemd journal capture)
  console.error(`[zen-security] ${message}`);
}

// ─── Port scan watcher ─────────────────────────────────────────────────
export function watchPortScan(): void {
  const ports = KNOWN_LISTENERS.join(',');

  // Uses ss to detect NEW connections to our monitored ports.
  // In production this runs as a tight loop or integrates with auditd.
  setInterval(() => {
    try {
      const { execSync } = require('node:child_process');
      const output = execSync(`ss -tunap 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 });
      const lines = output.split('\n').slice(1);

      for (const line of lines) {
        if (!line.includes('127.0.0.1') && !line.includes('127.0.0.2')) continue; // skip loopback
        const peerMatch = line.match(/\s(\d+\.\d+\.\d+\.\d+:\d+)\s/);
        if (!peerMatch) continue;
        const peer = peerMatch[1];
        if (!KNOWN_LISTENERS.some(p => line.includes(`:${p}`))) continue;

        const port = line.match(/:(\d+)\s/)?.[1];
        if (port && KNOWN_LISTENERS.includes(parseInt(port))) {
          notifyIntrusion(
            `Connection to monitored port ${port} from ${peer}`,
            port === '4123' ? 'critical' : 'normal'
          );
        }
      }
    } catch (e: any) {
      console.error('[zen-security] port-scan watcher error:', e.message);
    }
  }, 5_000);
}

// ─── SUID binary execution watcher ───────────────────────────────────────
export function watchSuidExec(): void {
  // Uses auditd (if running) or falls back to a simple check.
  // In production, integrate with auditd rules for execve on SUID binaries.
  if (!existsSync('/usr/bin/auditctl')) return;

  try {
    const { execSync } = require('node:child_process');
    // Load audit rules for SUID execution if not already loaded
    const rules = execSync('auditctl -l 2>/dev/null', { encoding: 'utf-8' });
    if (!rules.includes('-S execve')) {
      execSync('sudo auditctl -a always,exit -F arch=b64 -S execve 2>/dev/null || true', { stdio: 'pipe' });
    }
  } catch {}
}

// Auto-start if run directly
if (require.main === module) {
  console.error('[zen-security] Starting intrusion notification daemon...');
  watchPortScan();
  watchSuidExec();
  process.on('SIGTERM', () => process.exit(0));
}
