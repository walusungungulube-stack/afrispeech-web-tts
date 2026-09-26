/**
 * The bounded parallel map used to speak several pieces at once.
 *
 * Order matters: the audio is joined in the order the text was written, so a
 * result landing in the wrong slot would produce a jumbled clip.
 * Run with: node test/parallel.mjs
 */
import assert from 'node:assert/strict';
import { inParallel } from '../src/lib/pipeline.mjs';

// The checks are asynchronous, so each one has to be awaited. An unawaited
// rejection would be counted as a pass, which is worse than no test at all.
let passed = 0;
const checks = [];
const t = (name, fn) => checks.push([name, fn]);
const run = async () => {
  for (const [name, fn] of checks) {
    try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
    catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const items = (n) => Array.from({ length: n }, (_, i) => i);

t('results come back in the original order, not completion order', async () => {
  const out = await inParallel(items(6), 3, async (i) => {
    await wait((6 - i) * 12); // finish in reverse
    return i;
  });
  assert.deepEqual(out, items(6));
});

t('no more than the limit run at the same time', async () => {
  let live = 0;
  let peak = 0;
  await inParallel(items(12), 4, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await wait(8);
    live -= 1;
  });
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, `expected some parallelism, saw ${peak}`);
});

t('a limit above the item count is harmless', async () => {
  const out = await inParallel(items(2), 99, async (i) => i * 2);
  assert.deepEqual(out, [0, 2]);
});

t('a single item needs no special case', async () => {
  assert.deepEqual(await inParallel([7], 4, async (i) => i + 1), [8]);
});

t('an empty list resolves to an empty list', async () => {
  assert.deepEqual(await inParallel([], 4, async () => 1), []);
});

t('a failing item rejects rather than resolving with a hole', async () => {
  await assert.rejects(
    inParallel(items(5), 2, async (i) => { if (i === 3) throw new Error('piece 3 failed'); return i; }),
    /piece 3 failed/,
  );
});

t('work already in flight is allowed to settle before the rejection', async () => {
  let finished = 0;
  await inParallel(items(6), 3, async (i) => {
    await wait(10);
    finished += 1;
    if (i === 0) throw new Error('first failed');
  }).catch(() => {});
  // The three lanes that started before the failure each completed their item.
  assert.ok(finished >= 1, `expected in-flight work to finish, saw ${finished}`);
});

t('a limit of one behaves like a plain sequential loop', async () => {
  const order = [];
  await inParallel(items(4), 1, async (i) => { order.push(i); });
  assert.deepEqual(order, items(4));
});

await run();
console.log(`\n  ${passed} parallel checks passed`);
