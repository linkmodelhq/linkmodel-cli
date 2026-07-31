import assert from 'node:assert/strict';
import test from 'node:test';

import { isPromptExitError } from '../src/commands/setup.js';

test('isPromptExitError detects Inquirer ctrl-c cancellation', () => {
  const err = new Error('User force closed the prompt with SIGINT');
  err.name = 'ExitPromptError';
  assert.equal(isPromptExitError(err), true);
  assert.equal(isPromptExitError(new Error('network failed')), false);
  assert.equal(isPromptExitError('ExitPromptError'), false);
});
