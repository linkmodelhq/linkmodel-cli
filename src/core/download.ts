/**
 * Download artifacts concurrently to local files named <task_id>-<n>.<ext>.
 *
 * This shared layer handles concurrency and failure summaries independent of modality.
 * The only modality-specific part is extension inference, injected through resolveExtension.
 *
 * One failed download does not block the rest; callers summarize failures and map exit codes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface DownloadedFile {
  url: string;
  file: string;
}

export interface DownloadFailure {
  url: string;
  error: string;
}

export interface DownloadResult {
  saved: DownloadedFile[];
  failed: DownloadFailure[];
}

export interface DownloadOptions {
  urls: string[];
  outDir: string;
  taskId: string;
  /** Extension inference, modality-specific and injected by ModalitySpec. */
  resolveExtension: (url: string, contentType: string | null) => string;
  fetchImpl?: typeof fetch;
  concurrency?: number;
  /** Per-file download timeout. */
  perFileTimeoutMs?: number;
}

export async function downloadArtifacts(options: DownloadOptions): Promise<DownloadResult> {
  const { urls, outDir, taskId, resolveExtension } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const perFileTimeoutMs = options.perFileTimeoutMs ?? 60_000;

  await fs.mkdir(outDir, { recursive: true });

  const saved: DownloadedFile[] = [];
  const failed: DownloadFailure[] = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < urls.length) {
      const i = nextIndex++;
      const url = urls[i];
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(perFileTimeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ext = resolveExtension(url, res.headers.get('content-type'));
        const file = path.join(outDir, `${taskId}-${i + 1}${ext}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(file, buffer);
        saved.push({ url, file });
      } catch (err) {
        failed.push({ url, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));

  // Concurrent completion order is nondeterministic; sorting keeps output stable.
  saved.sort((a, b) => a.file.localeCompare(b.file));
  failed.sort((a, b) => a.url.localeCompare(b.url));
  return { saved, failed };
}
