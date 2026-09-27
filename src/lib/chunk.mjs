/**
 * Splitting text for synthesis.
 *
 * Gemini Live will not hold a turn open indefinitely: roughly a thousand
 * characters connects, starts sending audio, and then the socket closes before
 * the turn reports itself complete. Rather than lose the tail of an article, we
 * speak it in pieces and join the audio.
 *
 * The pieces are split on sentence boundaries wherever possible. Speaking half a
 * sentence produces an audible seam and a wrong-sounding clip, so a short piece
 * is always preferred to a sentence broken in half, even when that means the
 * piece is well under the limit.
 */

/** Sentence terminators, including the ellipsis character. */
const TERMINATOR = '.!?…';

function splitSentences(text) {
  const out = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    current += text[i];
    if (!TERMINATOR.includes(text[i])) continue;
    // Absorb a closing quote or bracket that belongs to the sentence, and the
    // space that follows, so "he said." stays one piece.
    while (i + 1 < text.length && /["'’”)\]]/.test(text[i + 1])) current += text[++i];
    while (i + 1 < text.length && /\s/.test(text[i + 1])) current += text[++i];
    out.push(current.trim());
    current = '';
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/** Break a single over-long sentence: clauses first, then words. */
function splitOversized(sentence, maxChars) {
  const pieces = [];
  let rest = sentence.trim();
  while (rest.length > maxChars) {
    // Prefer the last clause break that still fits.
    const window = rest.slice(0, maxChars + 1);
    const cut = Math.max(
      window.lastIndexOf('; '),
      window.lastIndexOf(', '),
      window.lastIndexOf(': '),
    );
    if (cut > maxChars * 0.4) {
      pieces.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
      continue;
    }
    // No clause break: fall back to the last space so no word is cut in half.
    const space = window.lastIndexOf(' ');
    const at = space > 0 ? space : maxChars;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Break text into pieces of at most `maxChars`, never mid-sentence if it can be
 * avoided. The pieces, read in order and joined with a space, are the original
 * text.
 */
export function splitForSynthesis(text, maxChars = 200) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  // Floor the limit: each piece costs a round trip to the model, so a piece
  // below roughly forty characters costs more than the seam it would avoid.
  const limit = Math.max(40, Math.floor(maxChars));

  const packed = [];
  let current = '';
  for (const sentence of splitSentences(clean)) {
    if (current && current.length + 1 + sentence.length <= limit) {
      current += ' ' + sentence;
    } else {
      if (current) packed.push(current);
      current = sentence;
    }
  }
  if (current) packed.push(current);

  return packed.flatMap((piece) => (piece.length <= limit ? [piece] : splitOversized(piece, limit)));
}
