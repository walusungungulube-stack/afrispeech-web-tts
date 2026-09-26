/**
 * The global cap, exercised against real Redis.
 *
 * The scripts that count and release a slot are the part that can go wrong, and
 * they only mean anything against the real thing, so this refuses to pretend
 * and skips if there is no database to talk to.
 *
 * Run with: node test/semaphore.mjs
 */
import assert from 'node:assert/strict';
import { withSlot, inUse } from '../src/lib/semaphore.mjs';
import { redis } from '../src/lib/store.mjs';

const client = redis();
await client.del('listen:sem:live');
await client.ping().catch(() => {});

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

await check('a slot is taken while work runs and given back after', async () => {
  assert.equal(await inUse(client), 0);
  let inside;
  await withSlot(async () => { inside = await inUse(client); }, { limit: 2, redis: client });
  assert.equal(inside, 1, 'not counted while held');
  assert.equal(await inUse(client), 0, 'not released after');
});

await check('no more than the limit are held at once', async () => {
  const limit = 3;
  let peak = 0;
  let live = 0;
  await Promise.all(Array.from({ length: 12 }, () => withSlot(async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 40));
    live -= 1;
  }, { limit, redis: client })));
  assert.ok(peak <= limit, `peak was ${peak}, limit ${limit}`);
  assert.ok(peak > 1, `expected real contention, peak was ${peak}`);
  assert.equal(await inUse(client), 0, 'every slot returned');
});

await check('a slot is given back when the work throws', async () => {
  await assert.rejects(
    withSlot(async () => { throw new Error('boom'); }, { limit: 1, redis: client }),
    /boom/,
  );
  assert.equal(await inUse(client), 0, 'a failed run must not shrink the cap');
});

await check('a waiter takes the slot a running job releases', async () => {
  const order = [];
  const first = withSlot(async () => {
    order.push('first-in');
    await new Promise((r) => setTimeout(r, 120));
    order.push('first-out');
  }, { limit: 1, redis: client });
  const second = withSlot(async () => { order.push('second-in'); }, { limit: 1, redis: client });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-in', 'first-out', 'second-in'],
    'the second job must wait its turn');
});

await check('a busy service says so rather than waiting for ever', async () => {
  let started = 0;
  const held = withSlot(() => new Promise((r) => setTimeout(r, 400)), { limit: 1, redis: client });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(
    withSlot(async () => { started += 1; }, {
      limit: 1, redis: client, maxWaitMs: 300, wait: () => Promise.resolve(),
    }),
    (error) => error.code === 'BUSY' && error.status === 503,
  );
  await held;
  assert.equal(started, 0, 'the job must not have run');
});

await check('a slot left behind by a killed step is reclaimed by the lease', async () => {
  // What a step that died mid-flight leaves behind: a count with no owner.
  await client.set('listen:sem:live', '1', { ex: 2 });
  await assert.rejects(
    withSlot(async () => {}, {
      limit: 1, redis: client, maxWaitMs: 100, wait: () => new Promise((r) => setTimeout(r, 1500)),
    }),
    (error) => error.code === 'BUSY',
  );
  assert.equal(await inUse(client), 1, 'still held just before the lease runs out');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(await inUse(client), 0, 'the lease must have reclaimed it');
});

await client.del('listen:sem:live');
console.log(`\n  ${passed} semaphore checks passed`);
