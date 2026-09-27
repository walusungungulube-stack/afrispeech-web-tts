/**
 * The two ways of translating, checked without calling either of them.
 *
 * These are the decisions a deployment is judged on, so they are checked against
 * a stub rather than the network: that the free engine routes through Thai, that
 * the Cloud engine does not and says so if it has no key, that the Cloud engine
 * unescapes what Cloud escapes, and that the two are told apart by the cache key
 * so a clip from one is never served for the other.
 */
import assert from 'node:assert/strict';
import { translate, pivotsThroughThai } from '../src/lib/translate.mjs';
import { translateForSpeech, translateOutOfThai } from '../src/lib/pipeline.mjs';
import { digestFor } from '../src/lib/store.mjs';
import { config } from '../src/lib/config.mjs';

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

/** A stub that records the hops it was asked for and answers each one. */
function stubGoogle(reply = 'HABARI') {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push({ sl: body.get('sl'), tl: body.get('tl'), q: body.get('q') });
    return { ok: true, json: async () => [[[reply, 'x', null, 1]], 'en'] };
  };
  return { calls, fetchImpl };
}

await t('the free engine goes out via Thai and comes back from it', async () => {
  const { calls, fetchImpl } = stubGoogle('habari');
  const result = await translate('Good morning', 'sw', 'en', { engine: 'unofficial', fetchImpl });
  assert.deepEqual(calls.map((c) => `${c.sl}>${c.tl}`), ['en>th', 'th>sw'], JSON.stringify(calls));
  assert.equal(result.text, 'habari');
  assert.equal(result.pivoted, true);
});

await t('the Cloud engine translates straight from source to target', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return {
      ok: true,
      json: async () => ({ data: { translations: [{ translatedText: 'Habari', detectedSourceLanguage: 'en' }] } }),
    };
  };
  const result = await translate('Good morning', 'sw', 'auto', { engine: 'cloud', apiKey: 'k', fetchImpl });
  assert.equal(calls.length, 1, 'one request, not two');
  assert.equal(calls[0].q[0], 'Good morning');
  assert.equal(calls[0].target, 'sw');
  assert.equal(calls[0].source, undefined, 'auto must be left to Cloud, not sent as a language');
  assert.equal(result.pivoted, false);
  assert.equal(result.detected, 'en');
});

await t('the Cloud engine is told the source when it is known', async () => {
  let body = null;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data: { translations: [{ translatedText: 'Habari' }] } }) };
  };
  await translate('Good morning', 'sw', 'en', { engine: 'cloud', apiKey: 'k', fetchImpl });
  assert.equal(body.source, 'en');
});

await t("Cloud's escaped apostrophes are not read out as punctuation", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: { translations: [{ translatedText: 'it&#39;s here &amp; it&#39;s good' }] } }),
  });
  const result = await translate('x', 'sw', 'en', { engine: 'cloud', apiKey: 'k', fetchImpl });
  assert.equal(result.text, "it's here & it's good");
});

await t('the Cloud engine refuses to run without a key, and says which to set', async () => {
  await assert.rejects(
    translate('Good morning', 'sw', 'en', { engine: 'cloud', apiKey: '' }),
    /GOOGLE_TRANSLATE_API_KEY/,
  );
});

await t('a Cloud failure carries the status, not just a shrug', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'permission denied' });
  await assert.rejects(
    translate('Good morning', 'sw', 'en', { engine: 'cloud', apiKey: 'k', fetchImpl }),
    /cloud HTTP 403.*permission denied/s,
  );
});

await t('only the free engine is allowed to hand back Thai', () => {
  assert.equal(pivotsThroughThai('unofficial'), true);
  assert.equal(pivotsThroughThai('cloud'), false);
  assert.equal(pivotsThroughThai('gemini'), false, 'Gemini translates directly, no pivot');
});

await t('a recording is not shared between the two engines or the two services', () => {
  const base = { text: 'Hello', languageCode: 'swh', voice: 'Zephyr', model: 'm', kbps: 24, sampleRate: 16000 };
  const a = digestFor({ ...base, translateEngine: 'unofficial', speechEngine: 'live' });
  const b = digestFor({ ...base, translateEngine: 'cloud', speechEngine: 'gemini-tts' });
  const c = digestFor({ ...base, translateEngine: 'cloud', speechEngine: 'live' });
  const again = digestFor({ ...base, translateEngine: 'unofficial', speechEngine: 'live' });
  assert.notEqual(a, b, 'demo and production must not share a recording');
  assert.notEqual(a, c, 'changing only the speech engine must change the recording');
  assert.equal(a, again, 'the same settings must hit the same recording');
});

await t('the default pairing is the one that can be paid for', () => {
  assert.equal(config.translateEngine, 'gemini');
  assert.equal(config.speechEngine, 'gemini-tts');
});

console.log(`\n  ${passed} translate checks passed`);

/* A page read in the language it is already in must not be translated, and must
   still say which language it is. The second half is the part that bit: reading
   a property off a code that had been mistaken for a language object produced
   undefined, JSON dropped the key, and the widget was left with no language to
   show while every other part of the run looked healthy. */
await t('a page already in the language asked for is not translated', async () => {
  const result = await translateForSpeech('The weather is warm today.', { lang: 'en', locale: 'en-GB' });
  assert.equal(result.text, 'The weather is warm today.', 'the text went out untouched');
  assert.equal(result.untranslated, true);
});

await t('and it still reports a name and a code, not undefined', async () => {
  const result = await translateForSpeech('The weather is warm today.', { lang: 'en', locale: 'en-GB' });
  assert.equal(typeof result.name, 'string', `name was ${JSON.stringify(result.name)}`);
  assert.equal(typeof result.code, 'string', `code was ${JSON.stringify(result.code)}`);
  assert.equal(result.name, 'English');
  // The check that would have caught it: JSON drops undefined, so an object that
  // has to survive a Redis round trip must not hold one.
  assert.ok('language' in { language: result.name }, 'the name survives serialisation');
  assert.equal(JSON.parse(JSON.stringify({ language: result.name })).language, 'English');
});

await t('the Thai guard is skipped when there is no translation to guard', async () => {
  // The sharpest version: a pass-through whose text is entirely Thai. The guard
  // would call that a failed hop and ask again, three times, then throw naming a
  // language nobody asked to translate into.
  let calls = 0;
  const result = await translateOutOfThai('สวัสดี', { lang: 'en', locale: 'en-GB' }, 3, async () => {
    calls += 1;
    return { text: 'สวัสดี', name: 'English', code: 'en' };
  }, 'unofficial');
  assert.equal(calls, 1, 'one pass, and no retry loop');
  assert.equal(result.text, 'สวัสดี', 'the text is what came back, untouched');
});
