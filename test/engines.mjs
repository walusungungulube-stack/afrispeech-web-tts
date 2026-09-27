/**
 * The two speech engines, and that the right one is chosen.
 *
 * Everything downstream of the speech step assumes 24 kHz signed 16-bit mono
 * PCM back, because the pieces are joined and encoded as one recording. An
 * engine that answered with anything else would not fail loudly here, it would
 * produce a recording of noise, so the shape is checked rather than trusted.
 *
 * The engines are driven through a stub so this costs nothing and runs offline.
 */
import assert from 'node:assert/strict';
import { geminiTts, isQuotaError } from '../src/lib/gemini.mjs';
import { pcmSeconds } from '../src/lib/mp3.mjs';
import { config } from '../src/lib/config.mjs';

/** One second of silence at 24 kHz, which is what a real answer looks like. */
function silentPcm(seconds = 1) {
  return Buffer.alloc(Math.round(24000 * seconds) * 2);
}

const stubClient = (payload) => ({
  models: { generateContent: async () => payload },
});

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

await t('audio parts are joined into one buffer of the right length', async () => {
  const pcm = silentPcm(1);
  const result = await geminiTts({
    text: 'hello',
    client: stubClient({
      candidates: [{ content: { parts: [
        { inlineData: { data: pcm.subarray(0, 24000).toString('base64') } },
        { inlineData: { data: pcm.subarray(24000).toString('base64') } },
      ] } }],
    }),
  });
  assert.equal(result.chunks, 2);
  assert.equal(result.pcm.length, pcm.length, 'two halves should come back as one buffer');
  assert.equal(Number(pcmSeconds(result.pcm, 24000).toFixed(2)), 1);
  assert.ok(Number.isFinite(result.firstByteMs), 'the time to first audio is reported');
});

await t('a reply with no audio is an error, not a zero-length clip', async () => {
  await assert.rejects(
    geminiTts({ text: 'hello', client: stubClient({ candidates: [{ content: { parts: [{ text: 'I cannot do that' }] } }] }) }),
    /returned no audio/,
  );
});

await t('a request that overruns its timeout is abandoned', async () => {
  const slow = { models: { generateContent: () => new Promise((resolve) => setTimeout(resolve, 5000)) } };
  await assert.rejects(geminiTts({ text: 'hello', timeoutMs: 60, client: slow }), /timed out/);
});

await t('the two engines are told apart by how they are addressed', async () => {
  // Live opens a session per piece; TTS is one request. The ids are different
  // products, so the defaults must not be the same string.
  assert.notEqual(config.ttsModel, config.liveModel, 'the two engines need different model ids');
  assert.match(config.ttsModel, /tts$/, `tts model looks wrong: ${config.ttsModel}`);
  assert.match(config.liveModel, /live/, `live model looks wrong: ${config.liveModel}`);
});

await t('the pipeline asks for the engine that is configured', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync('src/lib/pipeline.mjs', 'utf8'));
  assert.match(source, /config\.speechEngine === 'live'/,
    'the pipeline must branch on the configured engine');
  assert.match(source, /liveModel/, 'the live branch must pass the live model');
  assert.match(source, /ttsModel/, 'the tts branch must pass the tts model');
});

await t('both engines are recognised as refused by the same words', () => {
  assert.equal(isQuotaError(new Error('You exceeded your current quota, please check your plan')), true);
  assert.equal(isQuotaError(new Error('{"code":429}')), true);
  assert.equal(isQuotaError(new Error('closed (code 1000) text too long')), false);
});

console.log(`\n  ${passed} engine checks passed`);
