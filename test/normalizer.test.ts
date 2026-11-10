import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeError } from '../src/errors/normalizer.js';
import { ExitCode } from '../src/errors/types.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../test/fixtures/errors', import.meta.url));

function loadFixture(filename: string): any {
  const content = fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf8');
  return JSON.parse(content);
}

test('normalizer: maps seedance quota breach to INSUFFICIENT_BALANCE (exit 37, charged no)', () => {
  const envelope = loadFixture('seedance-quota-breached.json');
  const problem = normalizeError({ envelope });

  assert.equal(problem.reason, 'INSUFFICIENT_BALANCE');
  assert.equal(problem.exitCode, ExitCode.INSUFFICIENT_BALANCE);
  assert.equal(problem.exitCode, 37);
  assert.equal(problem.charged, 'no');
  assert.equal(problem.retryable, false);
  assert.equal(problem.next_action, 'check_quota');
  assert.equal(problem.upstream?.code, 100601);
});

test('normalizer: maps hailuo 512P constraint to INCOMPATIBLE_PARAMS (exit 9, charged no)', () => {
  const envelope = loadFixture('hailuo-512p-rejected.json');
  const problem = normalizeError({ envelope });

  assert.equal(problem.reason, 'INCOMPATIBLE_PARAMS');
  assert.equal(problem.exitCode, ExitCode.INCOMPATIBLE_PARAMS);
  assert.equal(problem.exitCode, 9);
  assert.equal(problem.charged, 'no');
  assert.equal(problem.retryable, false);
  assert.equal(problem.next_action, 'fix_input');
  assert.match(problem.detail, /resolution must be 768P or 1080P/);
});

test('normalizer: maps unknown model 100300 to UNKNOWN_MODEL (exit 8, charged no)', () => {
  const envelope = loadFixture('unknown-model.json');
  const problem = normalizeError({ envelope });

  assert.equal(problem.reason, 'UNKNOWN_MODEL');
  assert.equal(problem.exitCode, ExitCode.UNKNOWN_MODEL);
  assert.equal(problem.exitCode, 8);
  assert.equal(problem.charged, 'no');
  assert.equal(problem.retryable, false);
});

test('normalizer: maps auth 401 to AUTH_INVALID (exit 3, charged no)', () => {
  const envelope = loadFixture('auth-failed-401.json');
  const problem = normalizeError({ envelope, status: 401 });

  assert.equal(problem.reason, 'AUTH_INVALID');
  assert.equal(problem.exitCode, ExitCode.AUTH_FAILURE);
  assert.equal(problem.exitCode, 3);
  assert.equal(problem.charged, 'no');
  assert.equal(problem.retryable, false);
  assert.equal(problem.next_action, 'reauthenticate');
});

test('normalizer: maps network disconnect during create to CREATE_OUTCOME_UNKNOWN (charged maybe, retryable false)', () => {
  const netErr = new Error('fetch failed: ECONNRESET');
  const problem = normalizeError(netErr, { operation: 'create' });

  assert.equal(problem.reason, 'CREATE_OUTCOME_UNKNOWN');
  assert.equal(problem.charged, 'maybe');
  assert.equal(problem.retryable, false);
  assert.equal(problem.next_action, 'reconcile');
  assert.equal(problem.exitCode, ExitCode.NETWORK_ERROR);
});

test('normalizer: maps network disconnect during query to NETWORK (charged no, retryable true)', () => {
  const netErr = new Error('fetch failed: ECONNRESET');
  const problem = normalizeError(netErr, { operation: 'query' });

  assert.equal(problem.reason, 'NETWORK');
  assert.equal(problem.charged, 'no');
  assert.equal(problem.retryable, true);
  assert.equal(problem.next_action, 'retry');
});

test('normalizer: maps OSS 403 download error to OUTPUT_EXPIRED (exit 1, charged yes)', () => {
  const downloadErr = new Error('HTTP 403 Forbidden: Request has expired');
  const problem = normalizeError(downloadErr, { operation: 'download', upstreamStatus: 403 });

  assert.equal(problem.reason, 'OUTPUT_EXPIRED');
  assert.equal(problem.charged, 'yes');
  assert.equal(problem.retryable, false);
  assert.equal(problem.next_action, 'regenerate');
  assert.equal(problem.exitCode, ExitCode.GENERAL_ERROR);
});

test('normalizer: maps PollTimeoutError to POLL_TIMEOUT (exit 4, charged yes, retryable true)', () => {
  const timeoutErr = new Error('Polling timed out after 900s');
  timeoutErr.name = 'PollTimeoutError';
  const problem = normalizeError(timeoutErr, { operation: 'query', taskId: 'task-test-timeout' });

  assert.equal(problem.reason, 'POLL_TIMEOUT');
  assert.equal(problem.charged, 'yes');
  assert.equal(problem.retryable, true);
  assert.equal(problem.next_action, 'check_status');
  assert.equal(problem.exitCode, ExitCode.RATE_LIMIT);
  assert.equal(problem.upstream?.taskId, 'task-test-timeout');
});
