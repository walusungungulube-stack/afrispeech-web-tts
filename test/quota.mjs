/**
 * What happens when the key runs out of quota.
 *
 * Measured on one key: eight concurrent turns all served, sixteen had eleven
 * refused. Gemini accepts the socket, starts the turn, then closes with 1011 and
 * a message about exceeding the quota. Three things have to hold when that
 * happens, and all three are easy to get wrong because the failure looks like a
 * dropped connection from the outside:
 *
 *   - it is recognised as a quota refusal and not retried, because repeating
 *     against an exhausted limit only spends more of it;
 *   - the reader is told the service is busy, not shown the raw close message;
 *   - a close that is NOT a quota refusal stays retryable, since a socket that
 *     dropped for no stated reason is exactly what retrying is for.
 */
import assert from 'node:assert/strict';
import { withRetry } from '../src/lib/retry.mjs';
import { isQuotaError } from '../src/lib/live-tts.mjs';
import { describe } from '../src/index.mjs';

const QUOTA = 'live-tts: closed before the turn completed (code 1011) You exceeded '
  + 'your current quota, please check your plan and billing details. For more';
const RATE_LIMITED = 'live-tts: socket error 429';
const DROPPED = 'live-tts: closed before the turn completed (code 1011)';
const TOO_LONG = 'live-tts: closed before the turn completed (code 1000) text too long';

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

await t('a refused quota is recognised, in the wording Gemini actually sends', () => {
  assert.equal(isQuotaError(new Error(QUOTA)), true);
  assert.equal(isQuotaError(new Error(RATE_LIMITED)), true);
  assert.equal(isQuotaError(new Error('RESOURCE_EXHAUSTED: quota exceeded')), true);
});

await t('a close with no reason is not assumed to be a quota problem', () => {
  assert.equal(isQuotaError(new Error(DROPPED)), false);
  assert.equal(isQuotaError(new Error(TOO_LONG)), false);
  assert.equal(isQuotaError(new Error('live-tts: timeout')), false);
  assert.equal(isQuotaError(null), false);
  assert.equal(isQuotaError(undefined), false);
});

await t('a refused quota is handed straight back instead of being repeated', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(() => { calls += 1; throw new Error(QUOTA); },
      { attempts: 5, sleep: async () => {}, shouldRetry: (error) => !isQuotaError(error) }),
    /exceeded your current quota/,
  );
  assert.equal(calls, 1, `the model was asked ${calls} times, it should have been asked once`);
});

await t('a dropped connection is still retried', async () => {
  let calls = 0;
  const value = await withRetry(() => {
    calls += 1;
    if (calls < 3) throw new Error(DROPPED);
    return 'recovered';
  }, { attempts: 5, sleep: async () => {}, shouldRetry: (error) => !isQuotaError(error) });
  assert.equal(value, 'recovered');
  assert.equal(calls, 3, `expected three attempts, made ${calls}`);
});

await t('the reader is told it is busy, not shown the close message', () => {
  const message = describe(new Error(QUOTA));
  assert.match(message, /busy/i, `got: ${message}`);
  assert.doesNotMatch(message, /1011|quota|plan|billing/i, `leaked the model error: ${message}`);
});

await t('a generic failure still says what actually went wrong', () => {
  assert.equal(describe(new Error('the storage bucket is on fire')), 'the storage bucket is on fire');
});

console.log(`\n  ${passed} quota checks passed`);
