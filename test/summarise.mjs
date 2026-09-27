/**
 * The model reduces the page and speaks the summary in one turn, so there is no
 * translation step left to check. What is worth pinning down is that the turn is
 * told the right language and budget, and that a cached clip cannot outlive
 * either. Run with: node test/summarise.mjs
 */
import assert from 'node:assert/strict';
import { config } from '../src/lib/config.mjs';
import { speechInstruction } from '../src/lib/pipeline.mjs';
import { digestFor } from '../src/lib/store.mjs';

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

const base = {
  text: 'A page of text.',
  languageCode: 'swh',
  voice: 'Zephyr',
  model: 'gemini-3.1-flash-live-preview',
  kbps: 24,
  sampleRate: 16000,
};

t('a summary is capped at a few hundred characters', () => {
  assert.equal(config.summaryMaxChars, 500);
});

t('more page text is read in now that it is summarised', () => {
  assert.equal(config.maxChars, 3000);
});

t('the turn is told which language to speak', () => {
  const line = speechInstruction({ name: 'Swahili' });
  assert.match(line, /Target language: Swahili\./, line);
});

t('the turn is told the budget, so it can count to it', () => {
  const line = speechInstruction({ name: 'Swahili' });
  assert.match(line, new RegExp('Character budget: ' + config.summaryMaxChars + '\\.'), line);
});

t('a language with no name is not invented into the turn', () => {
  assert.equal(speechInstruction(null), '');
  assert.equal(speechInstruction({}), '');
});

t('a tighter budget is a different recording, not a cache hit', () => {
  // Otherwise a reader who asks for 200 characters can be handed a 500
  // character summary recorded earlier, and the budget means nothing.
  const wide = digestFor({ ...base, summaryChars: 500 });
  const tight = digestFor({ ...base, summaryChars: 200 });
  assert.notEqual(wide, tight);
});

t('the same request is still the same recording', () => {
  assert.equal(
    digestFor({ ...base, summaryChars: 500 }),
    digestFor({ ...base, summaryChars: 500 }),
  );
});

t('a different language is a different recording', () => {
  assert.notEqual(
    digestFor({ ...base, languageCode: 'swh', summaryChars: 500 }),
    digestFor({ ...base, languageCode: 'yor', summaryChars: 500 }),
  );
});

console.log('\n  ' + passed + ' summarise checks passed\n');
