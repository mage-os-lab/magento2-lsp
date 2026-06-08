/**
 * Neutralize vscode-languageserver-node's parent-process watchdog when the LSP
 * is running inside a container.
 *
 * The upstream library (see vscode-languageserver/lib/node/main.js) runs
 *
 *   setInterval(() => process.kill(initializeParams.processId, 0), 3000)
 *
 * to detect whether the editor that spawned the server is still alive. Inside a
 * container the editor's PID belongs to the host's PID namespace, not the
 * container's, so the kill() throws ESRCH and the watchdog calls
 * `process.exit(_shutdownReceived ? 0 : 1)` ~3 seconds after `initialize`,
 * regardless of what the editor does.
 *
 * Most LSP clients (Neovim, VS Code, Cursor, Zed) send their host PID in
 * `initialize.processId` unless the user configures otherwise. Rather than
 * requiring every client to override the param, this module installs a single
 * process-wide shim that makes the zero-signal liveness probe always succeed —
 * so the watchdog never trips. Real signals (SIGTERM, SIGKILL, ...) still pass
 * through to the original `process.kill`.
 *
 * Connection teardown is still handled: when the editor closes the stdio pipe,
 * vscode-jsonrpc's reader sees EOF and shuts the server down through the normal
 * path. The watchdog is redundant for that case.
 *
 * Override via env var:
 *   MAGENTO_LSP_HOST_PROCESS_CHECK=0  force the shim on (skip detection)
 *   MAGENTO_LSP_HOST_PROCESS_CHECK=1  force the shim off (run the watchdog)
 */

import * as fs from 'fs';

function detectContainer(): boolean {
  const override = process.env.MAGENTO_LSP_HOST_PROCESS_CHECK;
  if (override === '0') return true;
  if (override === '1') return false;
  try {
    fs.statSync('/.dockerenv');
    return true;
  } catch {
    /* not docker */
  }
  try {
    const cg = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker|containerd|kubepods|crio|podman|lxc/.test(cg)) return true;
  } catch {
    /* /proc/1/cgroup not present (e.g., non-Linux) */
  }
  return false;
}

/**
 * Replace `process.kill(pid, 0)` with a no-op that returns `true`. Real signals
 * are forwarded to the original implementation untouched.
 *
 * Call this at the top of the LSP entry point, before any `initialize` message
 * can arrive — i.e., before `connection.listen()` is called.
 */
export function neutralizeContainerWatchdog(): void {
  if (!detectContainer()) return;
  const origKill: typeof process.kill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: string | number): true => {
    if (signal === 0 || signal === '0' || signal === undefined) return true;
    return origKill(pid, signal);
  }) as typeof process.kill;
  process.stderr.write(
    '[magento2-lsp] container detected — parent-PID watchdog neutralized\n',
  );
}
