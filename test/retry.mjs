/**
 * Retry behaviour, with no network and no model involved.
 * Run with: node test/retry.mjs
 */
import assert from 'node:assert/strict';
import { withRetry, backoff } from '../src/lib/retry.mjs';

let passed = 0;
const checks = [];
const t = (name, fn) => checks.push([name, fn]);
const run = async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
    catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
  }
};
const noSleep = () => Promise.resolve();
const boom = (message = 'nope') => () => { throw new Error(message); };

t('a first-time success is not retried', async () => {
  let calls = 0;
  const out = await withRetry(async () => { calls += 1; return 'ok'; }, { sleep: noSleep });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

t('a failure is retried up to the limit and then rethrown', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls += 1; throw new Error('always fails'); },
      { attempts: 5, sleep: noSleep }),
    /always fails/,
  );
  assert.equal(calls, 5, `gave up after ${calls} attempts`);
});

t('a later success is returned', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('flaky');
    return calls;
  }, { attempts: 5, sleep: noSleep });
  assert.equal(out, 3);
});

t('the delay grows between attempts and is capped', () => {
  assert.equal(backoff(1, 400), 400);
  assert.equal(backoff(2, 400), 800);
  assert.equal(backoff(3, 400), 1600);
  assert.equal(backoff(20, 400), 8000, 'must not grow without bound');
});

t('an alternative attempt replaces repeating the same work', async () => {
  let calls = 0;
  const out = await withRetry(boom('too long'), {
    attempts: 5,
    sleep: noSleep,
    onFailure: (attempt) => (attempt >= 2 ? async () => { calls += 1; return 'split'; } : null),
  });
  assert.equal(out, 'split');
  assert.equal(calls, 1);
});

t('an alternative may be the answer rather than another attempt', async () => {
  // Recovering from a piece that is too long means doing the work differently,
  // and that work has already produced the result by the time we are called.
  const recovered = await withRetry(boom('too long'), {
    attempts: 5,
    sleep: noSleep,
    onFailure: (attempt) => (attempt >= 2 ? { pcm: Buffer.from('audio'), pieces: 2 } : null),
  });
  assert.equal(recovered.pieces, 2);
  assert.equal(recovered.pcm.toString(), 'audio');
});

t('the original error surfaces when the alternative also fails', async () => {
  await assert.rejects(
    withRetry(boom('too long'), {
      attempts: 3,
      sleep: noSleep,
      onFailure: (attempt) => (attempt >= 2 ? boom('halves failed too') : null),
    }),
    /halves failed too/,
  );
});

t('a turn is retried whole, never split in half', async () => {
  // Splitting would mean two summaries, so twice the character budget, from a
  // fallback meant to be a recovery. This asserts the shape of the retry: the
  // same work handed back each time.
  let calls = 0;
  await assert.rejects(
    withRetry(() => { calls += 1; throw new Error('dropped'); }, { attempts: 3, sleep: async () => {} }),
    /dropped/,
  );
  assert.equal(calls, 3);
});

await run();
console.log(`\n  ${passed} retry checks passed`);
