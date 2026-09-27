/**
 * The cap and the queue, at the size they are actually configured for.
 *
 * test/semaphore.mjs proves the counting is right at a handful of callers. This
 * asks the question that matters for LISTEN_MAX_LIVE_SESSIONS=300: does the cap
 * hold and does the queue drain when three hundred readers arrive together.
 *
 * The work each slot does is a short sleep rather than a Gemini turn, and that
 * is deliberate. What is being tested is the admission control around the turn,
 * which is Lua on Redis, and firing three hundred real turns would test the
 * Gemini key's quota instead while costing a great deal. So this says nothing
 * about how many concurrent Live sessions the key sustains, and does not claim
 * to. It says the service admits at most 300 and queues the rest.
 *
 * Run with: node --env-file-if-exists=.env test/semaphore-scale.mjs
 */
import assert from 'node:assert/strict';
import { withSlot, inUse } from '../src/lib/semaphore.mjs';
import { redis } from '../src/lib/store.mjs';

const CAP = Number(process.env.SCALE_CAP || 300);
const CLIENTS = Number(process.env.SCALE_CLIENTS || 300);

const client = redis();
await client.del('listen:sem:live');

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

/** Run `clients` callers at once and watch how many are ever inside at the same time. */
async function stampede(limit, clients, work, options = {}) {
  let live = 0;
  let peak = 0;
  const started = await Promise.all(Array.from({ length: clients }, () => withSlot(async () => {
    live += 1;
    peak = Math.max(peak, live);
    await work();
    live -= 1;
  }, { limit, redis: client, ...options })));
  return { peak, finished: started.length, live };
}

await t('three hundred readers are all admitted when the cap is three hundred', async () => {
  const { peak, live } = await stampede(CAP, CLIENTS, () => new Promise((r) => setTimeout(r, 60)));
  assert.equal(live, 0, 'every reader left');
  assert.ok(peak > 1, `expected real concurrency, peak was ${peak}`);
  assert.ok(peak <= CAP, `peak was ${peak}, over the cap of ${CAP}`);
  assert.equal(await inUse(client), 0, 'every slot returned');
  console.log(`       ${CLIENTS} readers, peak ${peak} at once, cap ${CAP}`);
});

await t('past the cap, readers queue rather than being refused', async () => {
  const limit = 50;
  const { peak, finished, live } = await stampede(limit, CLIENTS, () => new Promise((r) => setTimeout(r, 8)));
  assert.equal(finished, CLIENTS, 'every reader eventually ran');
  assert.equal(live, 0, 'every reader left');
  assert.ok(peak <= limit, `peak was ${peak}, over the cap of ${limit}`);
  assert.equal(peak, limit, `the cap should be reached, peak was ${peak}`);
  assert.equal(await inUse(client), 0, 'no slot leaked while queueing');
  console.log(`       ${CLIENTS} readers, ${limit} slots, peak ${peak}, all ${finished} finished`);
});

await t('a queue that cannot drain in time says so instead of hanging', async () => {
  // The honest failure: a reader who would wait past maxWaitMs is told the
  // service is busy, rather than left holding a connection indefinitely.
  const held = Array.from({ length: 2 }, () =>
    withSlot(() => new Promise((r) => setTimeout(r, 2500)), { limit: 2, redis: client }));
  await new Promise((r) => setTimeout(r, 50));
  let busy = 0;
  let served = 0;
  await Promise.all(Array.from({ length: 20 }, () => withSlot(async () => { served += 1; }, {
    limit: 2, redis: client, maxWaitMs: 120, wait: () => Promise.resolve(),
  }).then(() => {}, (error) => { if (error.code === 'BUSY') busy += 1; else throw error; })));
  assert.equal(served, 0, 'nothing ran while the cap was held');
  assert.equal(busy, 20, `all 20 should be told it is busy, got ${busy}`);
  await Promise.all(held);
  assert.equal(await inUse(client), 0, 'slots returned after the held work finished');
  console.log(`       20 arrivals, 2 slots held: ${busy} told it is busy, ${served} served`);
});

await t('the cap is configuration, not a number written into the code', async () => {
  // The same code at a different cap, which is what a deployment actually does.
  const { peak } = await stampede(7, 40, () => new Promise((r) => setTimeout(r, 5)));
  assert.equal(peak, 7, `peak was ${peak}`);
  assert.equal(await inUse(client), 0, 'no slot leaked');
});

await client.del('listen:sem:live');
console.log(`\n  ${passed} semaphore scale checks passed`);
