/**
 * The pivot out of Thai, and the check that it happened.
 *
 * The failure these guard against is silent. Google Translate declines a
 * language it will not produce by returning the input it was given, so a run can
 * record Thai, label it Swahili, cache it under Swahili, and report success at
 * every step. Nothing else in the pipeline would notice.
 *
 * Run with: node test/pivot.mjs
 */
import assert from 'node:assert/strict';
import { thaiShare, stillInThai } from '../src/lib/pivot.mjs';
import { translateOutOfThai } from '../src/lib/pipeline.mjs';

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

const THAI_TEXT = 'สวัสดีครับ ยินดีต้อนรับสู่กรุงนairobi และขอบคุณ';
const SWAHILI_TEXT = 'Habari yako. Karibu Nairobi, mji mkuu wa Kenya. Karibu tena.';

await t('Thai is recognised as Thai', () => {
  // The sample has a Latin place name in it on purpose, so the share is high but
  // not total. What matters is that it is nowhere near the borrowed-characters
  // tolerance.
  assert.ok(thaiShare(THAI_TEXT) > 0.5, `share was ${thaiShare(THAI_TEXT)}`);
});

await t('Swahili is not mistaken for Thai', () => {
  assert.equal(thaiShare(SWAHILI_TEXT), 0);
});

await t('the guard fires on a translation that is still Thai', () => {
  assert.equal(stillInThai(THAI_TEXT, 'sw'), true);
});

await t('the guard stands down on a translation that left Thai', () => {
  assert.equal(stillInThai(SWAHILI_TEXT, 'sw'), false);
});

await t('Thai is the one language Thai in the answer is correct for', () => {
  // Not offered today. If it ever is, the check has to stand down rather than
  // fail every Thai run, which is what this pins.
  assert.equal(stillInThai(THAI_TEXT, 'th'), false);
});

await t('a few borrowed characters are not a failure', () => {
  // Real text in these languages borrows the odd Thai word. Throwing a run away
  // over that would be worse than letting it through.
  const borrowed = `${SWAHILI_TEXT.repeat(20)} สวัสดี`;
  assert.ok(thaiShare(borrowed) < 0.02, `share was ${thaiShare(borrowed)}`);
  assert.equal(stillInThai(borrowed, 'sw'), false);
});

await t('an empty answer is not treated as Thai', () => {
  assert.equal(stillInThai('', 'sw'), false);
  assert.equal(stillInThai(null, 'sw'), false);
});

await t('text with no letters at all does not divide by zero', () => {
  assert.equal(thaiShare('123 456 !!!'), 0);
});

await t('a clean translation is asked for once', async () => {
  let calls = 0;
  const result = await translateOutOfThai('Hello', { lang: 'swh' }, 3, async () => {
    calls += 1;
    return { text: SWAHILI_TEXT, name: 'Swahili', code: 'swh', detected: 'en' };
  }, 'unofficial');
  assert.equal(calls, 1, 'no reason to ask again');
  assert.equal(result.code, 'swh');
});

await t('the Cloud engine is not asked to check for Thai at all', async () => {
  // It translates directly, so there is no pivot to have failed. Looping anyway
  // would mean rejecting good translations for containing a Thai word.
  let calls = 0;
  const result = await translateOutOfThai('Hello', { lang: 'swh' }, 3, async () => {
    calls += 1;
    return { text: THAI_TEXT, name: 'Swahili', code: 'swh' };
  }, 'cloud');
  assert.equal(calls, 1, 'one call, no retry loop');
  assert.equal(result.text, THAI_TEXT, 'what Cloud returned is what is used');
});

await t('a translation that is still Thai is asked for again', async () => {
  let calls = 0;
  const result = await translateOutOfThai('Hello', { lang: 'swh' }, 3, async () => {
    calls += 1;
    // Fails twice, then works: the point is that it does not give up at once.
    return { text: calls < 3 ? THAI_TEXT : SWAHILI_TEXT, name: 'Swahili', code: 'swh' };
  }, 'unofficial');
  assert.equal(calls, 3, 'it asked until the answer changed');
  assert.equal(result.text, SWAHILI_TEXT, 'and kept the good one');
});

await t('a translation that is always Thai gives up and says why', async () => {
  let calls = 0;
  await assert.rejects(
    () => translateOutOfThai('Hello', { lang: 'swh' }, 3, async () => {
      calls += 1;
      return { text: THAI_TEXT, name: 'Swahili', code: 'swh' };
    }, 'unofficial'),
    /came back in Thai after 3 attempts.*Swahili/s,
  );
  assert.equal(calls, 3, 'it asked exactly as many times as it was told to');
});

await t('a language it will not produce is never recorded as that language', async () => {
  // The whole reason for the check, end to end: the failure is silent, so the
  // only defence is refusing to accept an answer that is still in the pivot.
  let recorded = null;
  try {
    const result = await translateOutOfThai('Nairobi', { lang: 'swh' }, 3, async () => ({
      text: THAI_TEXT, name: 'Swahili', code: 'swh',
    }), 'unofficial');
    recorded = result;
  } catch {
    recorded = null;
  }
  assert.equal(recorded, null, 'nothing was handed on to be recorded');
});

console.log(`\n  ${passed} pivot checks passed`);
