/**
 * Open local artifacts with the system default app: macOS open, Linux xdg-open, Windows start.
 *
 * This shared layer is modality-agnostic. The opener is a factory and injectable like clock/fetchImpl.
 * Tests use fake spawnImpl/openFiles and never open real UI.
 *
 * Behavior contract:
 * - fire-and-forget: wait only for the process-start result, spawn versus error event.
 *   Then detach and unref without waiting for the viewer to close or blocking CLI exit.
 * - Always pass arguments as arrays with spawn semantics; never compose shell strings.
 * - Missing command or start failure does not throw; record it as failed so callers can warn on stderr.
 *   Exit code is unaffected; a failed open should not turn successful generation into failure.
 */

import { spawn } from 'node:child_process';

export interface OpenFailure {
  file: string;
  error: string;
}

export interface OpenOutcome {
  opened: string[];
  failed: OpenFailure[];
}

export type OpenFiles = (files: string[]) => Promise<OpenOutcome>;

interface PlatformCommand {
  command: string;
  args: (file: string) => string[];
}

function commandForPlatform(platform: NodeJS.Platform): PlatformCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: (file) => [file] };
    case 'win32':
      // start is a cmd built-in and must run through cmd /c; the empty string is the window-title placeholder.
      return { command: 'cmd.exe', args: (file) => ['/c', 'start', '', file] };
    default:
      // Linux / BSD; missing xdg-open emits error -> failed without affecting exit code.
      return { command: 'xdg-open', args: (file) => [file] };
  }
}

export interface CreateOpenerDeps {
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
}

export function createOpener(deps: CreateOpenerDeps = {}): OpenFiles {
  const platform = deps.platform ?? process.platform;
  const spawnImpl = deps.spawnImpl ?? spawn;
  return async (files) => {
    const opened: string[] = [];
    const failed: OpenFailure[] = [];
    const cmd = commandForPlatform(platform);
    for (const file of files) {
      const error = await new Promise<string | null>((resolve) => {
        let child;
        try {
          child = spawnImpl(cmd.command, cmd.args(file), { detached: true, stdio: 'ignore' });
        } catch (err) {
          resolve(err instanceof Error ? err.message : String(err));
          return;
        }
        child.on('error', (err) => resolve(err.message));
        child.on('spawn', () => {
          child.unref(); // Do not hold the event loop; the CLI can exit immediately.
          resolve(null);
        });
      });
      if (error === null) opened.push(file);
      else failed.push({ file, error });
    }
    return { opened, failed };
  };
}
