/**
 * Output strategy: TTY spinner, JSON, and plain modes.
 *
 * --json and spinner are mutually exclusive; non-TTY or --json disables animation and color.
 * Structured results go to stdout; logs go to stderr.
 */

import ora, { type Ora } from 'ora';
import pc from 'picocolors';

export type ReporterMode = 'tty' | 'plain' | 'json';

export interface Reporter {
  readonly mode: ReporterMode;
  spinnerStart(text: string): void;
  spinnerUpdate(text: string): void;
  spinnerStop(): void;
  /** Human-readable logs go to stderr so stdout remains pipe-friendly. */
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Structured results (task_id, URL, file path) are written to stdout. */
  out(line: string): void;
  /** JSON mode writes one JSON line to stdout. */
  emitJson(payload: unknown): void;
}

export function detectMode(options: { json?: boolean; isTTY?: boolean }): ReporterMode {
  if (options.json) return 'json';
  return options.isTTY ? 'tty' : 'plain';
}

interface Writable {
  write(chunk: string): unknown;
}

export function createReporter(options: {
  mode: ReporterMode;
  stdout?: Writable;
  stderr?: Writable;
}): Reporter {
  const { mode } = options;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  // Force no color in non-TTY and JSON modes.
  const color = pc.createColors(mode === 'tty');
  let spinner: Ora | null = null;

  const spinnerStop = () => {
    if (spinner) {
      spinner.stop();
      spinner = null;
    }
  };
  const logLine = (line: string) => {
    spinnerStop();
    stderr.write(`${line}\n`);
  };

  return {
    mode,
    spinnerStart(text) {
      if (mode !== 'tty') return; // Spinner is enabled only in TTY mode.
      spinner = ora({ text, stream: stderr as NodeJS.WritableStream }).start();
    },
    spinnerUpdate(text) {
      if (spinner) spinner.text = text;
    },
    spinnerStop,
    info: (message) => logLine(message),
    success: (message) => logLine(`${color.green('✓')} ${message}`),
    warn: (message) => logLine(`${color.yellow('⚠')} ${message}`),
    error: (message) => logLine(`${color.red('✖')} ${message}`),
    out: (line) => {
      stdout.write(`${line}\n`);
    },
    emitJson: (payload) => {
      stdout.write(`${JSON.stringify(payload)}\n`);
    },
  };
}
