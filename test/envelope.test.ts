import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EnvelopeParseError, parseEnvelope, withRequestId } from '../src/api/envelope.js';

test('create endpoint style:msg field is read', () => {
  const env = parseEnvelope({
    code: 0,
    msg: 'success',
    data: { task_id: 't1', price: 0.074 },
    request_id: 'r-1',
  });
  assert.equal(env.code, 0);
  assert.equal(env.message, 'success');
  assert.equal(env.requestId, 'r-1');
  assert.deepEqual(env.data, { task_id: 't1', price: 0.074 });
});

test('query endpoint style:message field is read', () => {
  const env = parseEnvelope({ code: 0, message: 'ok', data: { status: 'Success' } });
  assert.equal(env.message, 'ok');
  assert.equal(env.requestId, undefined);
});

test('msg wins over message when both are present (msg ?? message)', () => {
  const env = parseEnvelope({ msg: 'from-msg', message: 'from-message' });
  assert.equal(env.message, 'from-msg');
});

test('msg empty string does not fall back(?? semantics)', () => {
  assert.equal(parseEnvelope({ msg: '', message: 'fallback' }).message, '');
});

test('msg falls back to message when msg is null/missing', () => {
  assert.equal(parseEnvelope({ msg: null, message: 'm' }).message, 'm');
  assert.equal(parseEnvelope({ message: 'm2' }).message, 'm2');
});

test('requestId supports request_id / requestId both spellings', () => {
  assert.equal(parseEnvelope({ request_id: 'a' }).requestId, 'a');
  assert.equal(parseEnvelope({ requestId: 'b' }).requestId, 'b');
});

test('code missing code is undefined and never defaults to success value 0', () => {
  assert.equal(parseEnvelope({ msg: 'x' }).code, undefined);
  assert.equal(parseEnvelope({ code: '0' }).code, undefined); // wrong type does not count either
  assert.equal(parseEnvelope({ code: 0, msg: 'x' }).code, 0);
});

test('invalid envelope throws EnvelopeParseError without silent fallback', () => {
  assert.throws(() => parseEnvelope('nope'), EnvelopeParseError);
  assert.throws(() => parseEnvelope(null), EnvelopeParseError);
  assert.throws(() => parseEnvelope([1, 2]), EnvelopeParseError);
});

test('withRequestId appends request_id with ASCII parentheses', () => {
  assert.equal(withRequestId('Something went wrong', 'r-9'), 'Something went wrong (request_id: r-9)');
  assert.equal(withRequestId('Something went wrong'), 'Something went wrong');
});
