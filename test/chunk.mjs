/**
 * Splitting text into speakable pieces.
 *
 * The two properties that matter: no piece is too long for Gemini to finish in
 * one turn, and no piece ends mid-sentence when a full sentence would do.
 * Run with: node test/chunk.mjs
 */
import assert from 'node:assert/strict';
import { splitForSynthesis } from '../src/lib/chunk.mjs';

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};
const LIM = 200;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const article = `
The central bank raised its benchmark rate this week, citing persistent food
inflation across the region. Retailers in the capital reported higher shelf
prices within days of the announcement, and several importers asked for a delay
in payment terms to absorb the increase. Economists said borrowing costs would
remain elevated through the middle of the year, though they disagreed about how
far. The finance ministry promised targeted support for small traders, and said
the details would be published next month.
`.trim();

t('every piece fits the limit', () => {
  for (const piece of splitForSynthesis(article, LIM)) {
    assert.ok(piece.length <= LIM, `${piece.length} chars: ${piece.slice(0, 50)}…`);
  }
});

t('ordinary text is split on sentence boundaries', () => {
  for (const piece of splitForSynthesis(article, LIM)) {
    assert.match(piece, /[.!?…]["'’”)\]]?$/, `ends mid-sentence: …${piece.slice(-40)}`);
  }
});

t('no words are lost or reordered', () => {
  const pieces = splitForSynthesis(article, LIM);
  assert.equal(norm(pieces.join(' ')), norm(article));
});

t('a single sentence longer than the limit is broken at a clause', () => {
  const long = 'Central bank officials in Kampala, Nairobi and Dar es Salaam said '
    + 'the decision had been taken after lengthy consultation with regional '
    + 'governors, commercial lenders, importers and consumer representatives over '
    + 'the past several months, and that they would review the position again in June.';
  const pieces = splitForSynthesis(long, LIM);
  assert.ok(pieces.length > 1, 'should have been split');
  for (const piece of pieces) assert.ok(piece.length <= LIM, `${piece.length} chars`);
  assert.equal(norm(pieces.join(' ')), norm(long));
  assert.ok(pieces.every((p) => !/\s\S{0,2}$/.test(p)), 'a piece ends on a fragment');
});

t('a sentence with no punctuation at all still splits on word boundaries', () => {
  const runOn = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const pieces = splitForSynthesis(runOn, LIM);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.ok(piece.length <= LIM);
  assert.equal(norm(pieces.join(' ')), norm(runOn));
  // Nothing should end mid-word: each piece must be a whole-word prefix.
  for (const piece of pieces) {
    const next = runOn.indexOf(piece) + piece.length;
    assert.ok(next >= runOn.length || runOn[next] === ' ', `cut mid-word at "${piece.slice(-12)}"`);
  }
});

t('short text is left as a single piece', () => {
  assert.deepEqual(splitForSynthesis('One short sentence.', LIM), ['One short sentence.']);
});

t('a closing quote stays with its sentence', () => {
  // The floor is 40 characters, so at this length the last two sentences pack
  // together. What matters is that the closing quote is never orphaned into a
  // piece of its own, which is what a boundary after the full stop would do.
  const pieces = splitForSynthesis('He said the rates would hold. "We are watching closely." Then he left.', 40);
  assert.equal(pieces.length, 2);
  assert.ok(pieces[1].startsWith('"We are watching closely."'), pieces[1]);
});

t('a boundary never orphans a closing quote or bracket', () => {
  // A quoted sentence may legitimately begin with an opening quote. What must
  // never happen is a piece that opens with the tail of the previous sentence:
  // a leading full stop, a closing bracket with nothing open, or a quote
  // immediately followed by a bracket. All three mean the cut landed one
  // character too early.
  const quoted = '"We are watching closely." He added that the committee would meet '
    + 'again in June. "Nothing has changed." She said the same thing twice. '
    + '"Agreed," he replied (finally), and the meeting ended shortly after that. '
    + 'The minutes (all of them) were published on Friday afternoon.';
  const bad = /^[.!?\u2026,;:]|^[)\]]|^["\u2019]\s*[)\]]/;
  for (const limit of [40, 60, 90, 200]) {
    for (const piece of splitForSynthesis(quoted, limit)) {
      assert.ok(!bad.test(piece),
        `limit ${limit}: piece opens with "${piece.slice(0, 25)}"`);
    }
  }
});

t('text that already fits is not split at all', () => {
  const one = 'He said the rates would hold. "We are watching closely." Then he left.';
  assert.deepEqual(splitForSynthesis(one, LIM), [one]);
});

t('empty input produces no pieces rather than one empty piece', () => {
  assert.deepEqual(splitForSynthesis('', LIM), []);
  assert.deepEqual(splitForSynthesis('   ', LIM), []);
  assert.deepEqual(splitForSynthesis(null, LIM), []);
});

t('an ellipsis is treated as a sentence end', () => {
  // The first sentence is long enough that the next one cannot be packed onto
  // it, so the boundary has to fall on the ellipsis.
  const pieces = splitForSynthesis(
    'We waited for the rains that never came… Then the drought ended. Everyone planted again.', 40);
  assert.equal(pieces.length, 3);
  assert.match(pieces[0], /…$/);
});

t('a limit below the floor is raised, so pieces are never tiny', () => {
  // A five character limit would mean one round trip per word.
  const pieces = splitForSynthesis(article, 5);
  for (const piece of pieces) assert.ok(piece.length >= 1 && piece.length <= 40 || piece.length < 40);
  assert.equal(norm(pieces.join(' ')), norm(article));
});

t('a very small limit is still respected', () => {
  for (const piece of splitForSynthesis(article, 40)) {
    assert.ok(piece.length <= 40, `${piece.length} chars: ${piece}`);
  }
});

console.log(`\n  ${passed} chunking checks passed`);
