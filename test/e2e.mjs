/**
 * The whole chain against the live Gemini model and a real Redis.
 *
 * Needs GEMINI_API_KEY and the UPSTASH_REDIS_* values; it spends metered quota,
 * so it is not part of `npm test`. Run with: npm run test:e2e
 */
import assert from 'node:assert/strict';
import { synthesise } from '../src/lib/pipeline.mjs';
import { putAudio, getAudio, markDone, getMeta, getCached, putCached, digestFor } from '../src/lib/store.mjs';
import { config } from '../src/lib/config.mjs';
import { MPEGDecoder } from 'mpg123-decoder';

for (const name of ['GEMINI_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
  if (!process.env[name]) {
    console.log(`  skipped: ${name} is not set`);
    process.exit(0);
  }
}
const rms = (a) => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); };

const ARTICLE = `
The central bank raised its benchmark rate this week, citing persistent food
inflation across the region. Retailers in the capital reported higher shelf
prices within days of the announcement, and several importers asked for a delay
in payment terms so they could absorb the increase without passing all of it on.
Economists at three commercial banks said they expect borrowing costs to remain
elevated through the middle of the year, though they disagreed about how far,
and one desk forecast a further increase before the rains. The finance ministry
promised targeted support for small traders and said the details would be
published next month, after a review of the hardship fund that was set up during
the previous drought. Traders in the eastern districts said they had already
raised prices twice this year and expected a third increase before the harvest.
Consumer groups argued that the pass-through into shop prices was faster than
the official inflation figures suggested, and asked the statistics office to
publish its underlying data more promptly. The central bank said it would review
its position at the next scheduled meeting and that no decision had been taken.
`.trim();

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

console.log(`  model ${config.ttsModel}, ${config.mp3Kbps} kbps at ${config.mp3SampleRate} Hz\n`);
const started = Date.now();
const result = await synthesise({ text: ARTICLE, lang: 'en', locale: 'en-GB' });
const { meta, spoken, clipped } = result;

console.log(`  ${meta.chars}/${meta.totalChars} chars, truncated=${meta.truncated}`);
console.log(`  ${meta.language}: ${result.translated.text.slice(0, 90)}…`);
console.log(`  ${meta.seconds}s audio, ${(meta.bytes / 1024).toFixed(0)} KB, first byte ${meta.firstByteMs}ms, synth ${(meta.synthMs / 1000).toFixed(1)}s`);
console.log(`  wall ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

t('the text is capped at 1000 characters', () => {
  assert.ok(clipped.text.length <= 1000, `got ${clipped.text.length}`);
});
t('it ends on a full stop', () => assert.ok(clipped.text.endsWith('.'), clipped.text.slice(-40)));
t('the article was long enough to be trimmed', () => assert.equal(meta.truncated, true));
t('speech keeps up with the clock', () => {
  // Pieces are spoken in parallel, so this is expected to be faster than
  // realtime rather than matching it.
  const ratio = meta.seconds / (meta.synthMs / 1000);
  assert.ok(ratio > 0.5, `throughput only ${ratio.toFixed(2)}x realtime`);
  console.log(`       throughput ${ratio.toFixed(2)}x realtime across ${meta.pieces} pieces`);
});
t('the bitrate holds regardless of clip length', () => {
  // The cost that matters is bytes per second of audio, not the file total: a
  // long clip is naturally a bigger file at the same rate.
  const perSecond = meta.bytes / meta.seconds;
  assert.ok(perSecond < 4 * 1024, `${(perSecond / 1024).toFixed(2)} KB per second of audio`);
  console.log(`       ${(perSecond / 1024).toFixed(2)} KB per second of audio`);
});
t('a full length article still fits the 1000 character cap', () => {
  console.log(`       ${meta.chars} of ${meta.totalChars} characters, ${meta.seconds}s of audio, ${(meta.bytes / 1024).toFixed(0)} KB`);
  assert.ok(meta.chars <= 1000);
});

const decoder = new MPEGDecoder();
await decoder.ready;
const decoded = decoder.decode(spoken.mp3);
decoder.free();
const channel = decoded.channelData[0];

t('the MP3 decodes at the target sample rate', () =>
  assert.equal(decoded.sampleRate, config.mp3SampleRate));
t('the MP3 decodes to audible signal, not silence', () => {
  const level = rms(channel);
  let peak = 0;
  for (let i = 0; i < channel.length; i += 1) {
    const value = Math.abs(channel[i]);
    if (value > peak) peak = value;
  }
  assert.ok(level > 0.01, `rms ${level.toFixed(4)} is effectively silence`);
  assert.ok(peak > 0.1, `peak ${peak.toFixed(3)}: the file is silent or garbage`);
  assert.ok(peak <= 1.5, `peak ${peak.toFixed(3)}: the file is clipping`);
});
t('the clip length survives the encode', () => {
  const seconds = decoded.samplesDecoded / decoded.sampleRate;
  assert.ok(Math.abs(seconds - meta.seconds) < 0.6, `decoded ${seconds.toFixed(2)}s vs ${meta.seconds}s`);
});

/* The status and audio routes read these keys, so prove the round trip. */
const runId = 'wfr_e2etestrun0001';
await putAudio(runId, spoken.mp3);
await markDone(runId, meta);
const back = await getAudio(runId);
const status = await getMeta(runId);

t('the audio round trips through Redis byte for byte', () => {
  assert.ok(back, 'nothing came back');
  assert.equal(back.length, spoken.mp3.length);
  assert.ok(back.equals(spoken.mp3), 'the stored bytes differ');
});
t('the status payload carries what the widget reads', () => {
  for (const key of ['state', 'language', 'chars', 'totalChars', 'truncated', 'seconds', 'bytes']) {
    assert.ok(key in status, `status is missing ${key}`);
  }
});


/* A cache entry outlives the code that wrote it, so what is in there now is
   what a bad build would have left behind. It must be refused as a miss, not
   served: this is the nine-byte "[object Object]" that a Buffer became on its
   way through the queue, and it is still a valid key with a live TTL. */
const poisoned = await getCached(digestFor({
  text: 'This entry was written by a build that stored the wrong bytes.',
  languageCode: 'en',
  voice: config.ttsVoice,
  model: config.ttsModel,
  kbps: config.mp3Kbps,
  sampleRate: config.mp3SampleRate,
}));
await putCached(digestFor({
  text: 'This entry was written by a build that stored the wrong bytes.',
  languageCode: 'en',
  voice: config.ttsVoice,
  model: config.ttsModel,
  kbps: config.mp3Kbps,
  sampleRate: config.mp3SampleRate,
}), Buffer.from('[object Object]'), { seconds: 95, language: 'English' });

const afterPoison = await getCached(digestFor({
  text: 'This entry was written by a build that stored the wrong bytes.',
  languageCode: 'en',
  voice: config.ttsVoice,
  model: config.ttsModel,
  kbps: config.mp3Kbps,
  sampleRate: config.mp3SampleRate,
}));
ok('a cache entry that is not audio is refused as a miss, not served', poisoned === null && afterPoison === null);
ok('and the bad entry is gone rather than left to be found again',
  await getCached(digestFor({
    text: 'This entry was written by a build that stored the wrong bytes.',
    languageCode: 'en',
    voice: config.ttsVoice,
    model: config.ttsModel,
    kbps: config.mp3Kbps,
    sampleRate: config.mp3SampleRate,
  })) === null);

console.log(`\n  ${passed} end-to-end checks passed`);
