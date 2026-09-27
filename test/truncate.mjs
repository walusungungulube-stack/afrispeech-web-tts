/**
 * The brief is the first 1000 characters, allowed to be shorter so the clip
 * does not end mid-sentence. Run with: node test/truncate.mjs
 */
import assert from 'node:assert/strict';
import { truncateToLimit } from '../src/lib/truncate.mjs';
import { readSource } from '../src/lib/pipeline.mjs';

const LIMIT = 1000;
const sentence = 'The committee published its quarterly statement on monetary policy. ';
const build = (n) => sentence.repeat(n);

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

t('short text is untouched', () => {
  const short = 'A short piece of text.';
  const r = truncateToLimit(short, LIMIT);
  assert.equal(r.text, short);
  assert.equal(r.truncated, false);
});

t('a long article is cut to at most the limit', () => {
  const r = truncateToLimit(build(200), LIMIT);
  assert.ok(r.text.length <= LIMIT, `length ${r.text.length} > ${LIMIT}`);
  assert.equal(r.truncated, true);
  // Counted after trimming: a trailing space is not part of the text read.
  assert.equal(r.totalChars, build(200).trim().length);
});

t('a cut lands on a full stop when one is available', () => {
  const r = truncateToLimit(build(200), LIMIT);
  assert.ok(r.text.endsWith('.'), `ends with "${r.text.slice(-30)}"`);
});

t('text without sentence endings falls back to a word boundary', () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const r = truncateToLimit(words, LIMIT);
  assert.ok(r.text.length <= LIMIT, `length ${r.text.length} > ${LIMIT}`);
  // Precise check: the result is a true prefix, and the next character in the
  // source is a space, so no word was cut in half.
  assert.ok(words.startsWith(r.text), 'result is not a prefix of the source');
  const next = words[r.text.length];
  assert.ok(next === ' ' || next === undefined, `cut inside a word, next char is ${JSON.stringify(next)}`);
});

t('a limit of exactly the input length does not mark it truncated', () => {
  const text = 'One two three four five.';
  assert.equal(truncateToLimit(text, text.length).truncated, false);
});

console.log(`\n  ${passed} truncation checks passed`);

/* A reader who types a sentence and is told the webpage is not supported has
   been told a true thing about the wrong subject. */
t('a single typed sentence is something to read out', () => {
  const short = readSource({ text: 'Habari yako. Karibu Nairobi.' });
  assert.equal(short.text, 'Habari yako. Karibu Nairobi.');
});

t('whitespace is not something to read out', () => {
  assert.throws(() => readSource({ text: '   \n  ' }), /carried no text/);
});

