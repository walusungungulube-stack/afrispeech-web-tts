/**
 * Has the pivot out of Thai actually happened?
 *
 * Translation is two legs: into Thai, then out to the language asked for. The
 * second leg is the one that can fail quietly. Google Translate does not report
 * an error when it declines to produce a language; it returns the input it was
 * given, which is Thai. Nothing in the response says so.
 *
 * Left unchecked, that Thai is recorded by an English voice, labelled with the
 * language the reader asked for, and cached under it. Every later reader of the
 * same page is then handed it, correctly labelled and completely wrong, for as
 * long as the entry lives.
 *
 * The check is a script check rather than a language-detection call, because
 * Thai is written in its own Unicode block and nothing else we offer is. That
 * makes it exact, free and instant: no extra request, nothing to wait for, and
 * no way for the check itself to be wrong in a new place. Asking Google what
 * language this is would mean paying and waiting to be told the same thing.
 *
 * Thai is not one of the languages we offer, which is what lets this sound like
 * a failure. If it ever is, Thai in the answer is the whole point, so `asked` is
 * passed in and the check stands down.
 */

const THAI = /[\u0E00-\u0E7F]/;

/** Characters that are letters in some script, as opposed to spaces and digits. */
const LETTER = /[\p{L}\p{M}]/u;

/**
 * How much of `text` is written in Thai.
 *
 * Only a sample from the start is read, so the answer does not depend on how
 * long the text is, and a long article cannot make one stray character look
 * like a failure.
 *
 * @param {string} text
 * @param {number} [sampleChars] how much of the text to look at
 * @returns {number} 0 when there is no Thai in it, up to 1 when it is all Thai
 */
export function thaiShare(text, sampleChars = 600) {
  const sample = String(text || '').slice(0, sampleChars);
  if (!sample) return 0;

  let letters = 0;
  let thai = 0;
  for (const character of sample) {
    if (!LETTER.test(character)) continue;
    letters += 1;
    if (THAI.test(character)) thai += 1;
  }
  return letters === 0 ? 0 : thai / letters;
}

/**
 * Whether a translation is still in Thai, and so has not left the pivot.
 *
 * A threshold rather than a yes-or-no: real output in these languages carries a
 * few borrowed Thai characters, and a run should not be thrown away over those.
 * Past this share, the text is Thai.
 *
 * @param {string} text    the translated text
 * @param {string} [asked] the Google code that was asked for
 * @param {number} [share] share of Thai above which the pivot counts as failed
 * @returns {boolean}
 */
export function stillInThai(text, asked, share = 0.02) {
  // Asking for Thai is the one time Thai in the answer is exactly right.
  if (asked === 'th') return false;
  return thaiShare(text) > share;
}
