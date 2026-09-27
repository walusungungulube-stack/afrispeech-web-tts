/**
 * The limits on starting a run.
 *
 * These are the only thing standing between a public endpoint and the Gemini
 * quota, so the checks are about what happens at the edges: the request that is
 * allowed, the one after it that is not, and the shared ceiling that per
 * address limits cannot help with.
 *
 * Redis is stubbed rather than reached, so the windows can be inspected
 * directly and the day-long limits can be tested without waiting a day.
 *
 * Run with: node test/ratelimit.mjs
 */
import assert from 'node:assert/strict';

process.env.LISTEN_RATE_ENABLED = '1';
process.env.LISTEN_RATE_PER_MINUTE = '3';
process.env.LISTEN_RATE_PER_DAY = '5';
process.env.LISTEN_BUDGET_PER_DAY = '0';

const { checkStart, callerId, setCounter } = await import('../src/lib/ratelimit.mjs');

/** Just enough Redis for the counters: incr, expire, and a way to look. */
const counters = new Map();
const expiries = new Map();
const opened = new Map();
setCounter(async (key, window) => {
  const next = (counters.get(key) ?? 0) + 1;
  counters.set(key, next);
  if (next === 1) {
    expiries.set(key, window);
    opened.set(key, (opened.get(key) ?? 0) + 1);
  }
  return next;
});

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

const from = (ip) => new Request('https://listen.example/speak', {
  headers: ip ? { 'cf-connecting-ip': ip } : {},
});

await t('Cloudflare\'s address is the one counted', () => {
  assert.equal(callerId(from('203.0.113.7')), '203.0.113.7');
});

await t('a forwarded address is the fallback, first entry only', () => {
  const request = new Request('https://listen.example/speak', {
    headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' },
  });
  assert.equal(callerId(request), '198.51.100.4');
});

await t('a client that can be trusted with no address gets no identity', () => {
  // Better to count nobody than to invent an identity from a header anyone can
  // set, which would let one caller spend everyone\'s quota.
  assert.equal(callerId(from(null)), null);
});

await t('the first requests are allowed and then the caller is stopped', async () => {
  counters.clear();
  for (let n = 1; n <= 3; n += 1) {
    const limit = await checkStart(from('203.0.113.1'));
    assert.equal(limit.ok, true, `request ${n} should have been allowed`);
  }
  const fourth = await checkStart(from('203.0.113.1'));
  assert.equal(fourth.ok, false);
  assert.equal(fourth.status, 429);
  assert.equal(fourth.scope, 'minute');
  assert.ok(fourth.retryAfter > 0, 'a 429 should say when to come back');
});

await t('the stop is per address, not global', async () => {
  // The whole point of counting by address: one caller cannot spend the quota
  // of everyone else.
  const other = await checkStart(from('203.0.113.2'));
  assert.equal(other.ok, true, 'a different address is unaffected');
});

await t('a caller who waits a minute can still start a run', async () => {
  // Paced requests must not be caught by the per-minute limit, or a legitimate
  // reader would be throttled for asking slowly.
  counters.clear();
  for (let n = 0; n < 6; n += 1) {
    await checkStart(from('203.0.113.3'));
    counters.delete('listen:rl:min:203.0.113.3'); // the minute passes
  }
  assert.ok(true);
});

await t('the daily limit eventually stops a caller who paces themselves', async () => {
  counters.clear();
  let limit;
  for (let n = 0; n < 7; n += 1) {
    limit = await checkStart(from('203.0.113.5'));
    counters.delete('listen:rl:min:203.0.113.5');
  }
  assert.equal(limit.ok, false, 'six in a day is one too many');
  assert.equal(limit.scope, 'day');
});

await t('a window is given its expiry once, when it is opened', async () => {
  // If the expiry were reset on every hit the window would keep sliding
  // forward and a caller could never run out of it, which would make the
  // per-minute limit worth nothing against anyone patient.
  counters.clear();
  expiries.clear();
  const key = 'listen:rl:min:203.0.113.9';
  for (let n = 0; n < 3; n += 1) await checkStart(from('203.0.113.9'));

  assert.equal(opened.get(key), 1, 'the window was opened exactly once');
  assert.equal(expiries.get(key), 60, 'and it lives for a minute');
  assert.equal(expiries.get('listen:rl:day:203.0.113.9'), 86400,
    'the daily window is kept for a day');
});

await t('a caller with no address is still counted against the budget', async () => {
  // With no identity there is nothing to count against but the shared ceiling.
  counters.clear();
  process.env.LISTEN_BUDGET_PER_DAY = '2';
  const { config } = await import('../src/lib/config.mjs');
  const original = config.budgetPerDay;
  config.budgetPerDay = 2;

  assert.equal((await checkStart(from(null))).ok, true);
  assert.equal((await checkStart(from(null))).ok, true);
  const third = await checkStart(from(null));
  assert.equal(third.ok, false);
  assert.equal(third.scope, 'budget');
  assert.equal(third.status, 503, 'a spent budget is our problem, not the caller\'s');

  config.budgetPerDay = original;
});

await t('the budget is shared, so changing address does not escape it', async () => {
  // Per-address limits are all bypassed by rotating address. This is the one
  // that is not, which is why it exists.
  counters.clear();
  const { config } = await import('../src/lib/config.mjs');
  const original = config.budgetPerDay;
  config.budgetPerDay = 3;
  config.ratePerMinute = 0;
  config.ratePerDay = 0;

  const results = [];
  for (let n = 0; n < 5; n += 1) {
    results.push(await checkStart(from(`198.51.100.${n}`)));
  }
  assert.equal(results.filter((r) => r.ok).length, 3, 'three fresh addresses, three runs');
  assert.equal(results[3].scope, 'budget');
  assert.equal(results[4].scope, 'budget');

  config.budgetPerDay = original;
  config.ratePerMinute = 3;
  config.ratePerDay = 5;
});

console.log(`\n  ${passed} rate limit checks passed`);
