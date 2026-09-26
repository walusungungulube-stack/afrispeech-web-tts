/**
 * The actual work, kept out of the workflow shell.
 *
 * The workflow exists to survive long jobs, not to hold the logic: Gemini speaks
 * at roughly 0.96x realtime, so a full clip takes about as long to record as it
 * is long, well past what a single request can wait for. Each function here is
 * one workflow step, and each is a plain function, so the whole chain can be run
 * and checked without a message queue in the way.
 */
import { extractArticle, UnsupportedPageError } from './extract.mjs';
import { truncateToLimit } from './truncate.mjs';
import { translate } from './translate.mjs';
import { stillInThai } from './pivot.mjs';
import { findSpeechLanguage, defaultForLocale } from './languages.mjs';
import { liveTts } from './live-tts.mjs';
import { splitForSynthesis } from './chunk.mjs';
import { withRetry, bisect } from './retry.mjs';
import { withSlot } from './semaphore.mjs';
import { pcmToMp3, pcmSeconds } from './mp3.mjs';
import { config } from './config.mjs';
import { digestFor, getCached, putCached, digestUrl, getUrlText, putUrlText } from './store.mjs';

/** Step 1: the words. The widget sends text it read itself; a shared link sends a URL. */
export async function readSource({ text, url, title } = {}) {
  /* Any text at all is something to read out. A minimum length here used to mean
     that a reader who typed a sentence was told the webpage was not supported,
     which is a true statement about the wrong thing entirely. */
  if (typeof text === 'string' && text.trim().length > 0) {
    return { text, title: String(title || ''), via: 'client' };
  }
  if (typeof url === 'string' && url.trim()) {
    const address = url.trim();
    // A page we have already read does not need fetching again.
    const seen = await getUrlText(digestUrl(address)).catch(() => null);
    if (seen && seen.length >= 200) return { text: seen, title: '', via: 'cache' };
    const article = await extractArticle(address);
    await putUrlText(digestUrl(address), article.text).catch(() => {});
    return { text: article.text, title: article.title, via: 'server' };
  }
  throw new UnsupportedPageError(
    'Nothing to read: the request carried neither text nor an address.',
  );
}

/** Step 2: cap the length, preferring to finish on a full stop. */
export function limitText(text) {
  return truncateToLimit(text, config.maxChars);
}

/**
 * Translate, and check that the pivot out of Thai actually happened.
 *
 * Asking Google for a language it will not produce is not an error: it returns
 * the Thai it was given, with nothing in the response to say so. Left alone,
 * that Thai is recorded, labelled with the language the reader asked for, and
 * cached under it. So the answer is checked, and asked for again when it is
 * still Thai, because this failure is not consistent enough to accept the first
 * time it appears.
 *
 * @param {string} text    source text, already clipped
 * @param {object} request `{ lang, locale, source }`
 * @param {number} [attempts] how many times to ask before giving up
 * @param {Function} [translate] seam, so the checks can drive it
 * @returns {Promise<{text: string, name: string, code: string, detected: string|null}>}
 */
export async function translateOutOfThai(text, request = {}, attempts = 3, translate = translateForSpeech) {
  const language = resolveLanguage(request.lang, request.locale);

  for (let ask = 1; ask <= attempts; ask += 1) {
    const result = await translate(text, request);
    if (!stillInThai(result.text, language.google)) return result;
  }

  throw new Error(
    `the translation came back in Thai after ${attempts} attempts, so the pivot into `
    + `${language.name} did not take`,
  );
}

/** Step 3: pick a language and translate, always pivoting through Thai. */
export async function translateForSpeech(text, { lang, locale, source } = {}) {
  const language = resolveLanguage(lang, locale);
  const translated = await translate(text, language.google, source || 'auto');
  return {
    text: translated.text,
    detected: translated.detected,
    name: language.name,
    code: language.code,
  };
}

/**
 * A language is only offered once Gemini has been heard pronouncing it, so an
 * unconfirmed request falls back to English rather than being read in an accent
 * the reader will recognise as wrong.
 */
export function resolveLanguage(requested, locale) {
  if (String(requested || '').toLowerCase() === 'en') {
    return { code: 'en', name: 'English', google: 'en' };
  }
  const found = findSpeechLanguage(requested);
  if (found?.tts) return found;
  const fallback = findSpeechLanguage(defaultForLocale(locale));
  if (fallback?.tts) return fallback;
  return { code: 'en', name: 'English', google: 'en' };
}

/**
 * Steps 4 and 5: speak, then encode.
 *
 * A single Live turn will not carry a whole article, so the text is spoken in
 * sentence-sized pieces and the resulting audio is joined. Gemini hands back
 * 24 kHz signed 16-bit mono PCM, the same format for every piece, so joining is
 * a plain concatenation with no resampling and nothing to line up.
 */
export async function speak(text) {
  const pieces = splitForSynthesis(text, config.ttsChunkChars);
  const started = Date.now();

  // The pieces are independent, so they are spoken at the same time rather than
  // one after another. A full article is five or six pieces of roughly twenty
  // seconds each; in sequence that is two minutes of waiting, and running them
  // together brings it back to about the length of the longest piece. Order is
  // restored by index when the results are joined.
  const spoken = await inParallel(pieces, config.ttsConcurrency, (piece) => speakPiece(piece, 0));

  const pcm = Buffer.concat(spoken.map((part) => part.pcm));
  const firstByteMs = Math.min(...spoken.map((part) => part.firstByteMs ?? Infinity));
  const mp3 = await pcmToMp3(pcm, {
    sampleRate: config.pcmSampleRate,
    kbps: config.mp3Kbps,
    outRate: config.mp3SampleRate,
  });
  return {
    mp3,
    pieces: pieces.length,
    seconds: pcmSeconds(pcm, config.pcmSampleRate),
    firstByteMs: Number.isFinite(firstByteMs) ? firstByteMs : null,
    synthMs: Date.now() - started,
  };
}

/**
 * Speak one piece, retrying it if the model drops the connection.
 *
 * A piece that fails because the connection dropped is worth asking again, and
 * usually succeeds. A piece that fails because it is too long to finish in one
 * turn is not: asking again produces the same failure. So after a couple of
 * plain attempts, the piece is spoken as two halves instead of being repeated.
 * If even that fails, the error is allowed out rather than quietly dropping the
 * words from the clip.
 */
async function speakPiece(piece, depth) {
  // Each session is one of the globally available slots, so readers queue
  // behind each other rather than each opening up to ttsConcurrency sockets.
  const request = (text) => withSlot(() => liveTts({
    text,
    voice: config.ttsVoice,
    model: config.ttsModel,
    timeoutMs: config.ttsTimeoutMs,
  }), { limit: config.maxLiveSessions, maxWaitMs: config.maxSlotWaitMs });

  return withRetry(() => request(piece), {
    attempts: config.ttsMaxAttempts,
    onFailure: async (attempt, error) => {
      if (attempt < 2 || depth >= config.ttsMaxBisect) return null;
      const halves = bisect(piece);
      if (!halves) return null;
      const spoken = await Promise.all(halves.map((half) => speakPiece(half, depth + 1)));
      return {
        pcm: Buffer.concat(spoken.map((part) => part.pcm)),
        chunks: spoken.reduce((total, part) => total + (part.chunks || 0), 0),
        firstByteMs: Math.min(...spoken.map((part) => part.firstByteMs ?? Infinity)),
        totalMs: spoken.reduce((total, part) => total + (part.totalMs || 0), 0),
        bisected: true,
        recoveredFrom: error.message,
      };
    },
  });
}

/**
 * Run `worker` over every item, at most `limit` at a time, and return the
 * results in the original order. The first failure is thrown once the in-flight
 * work has settled, so a rejected piece does not leave a dangling connection.
 */
export async function inParallel(items, limit, worker) {
  if (items.length <= 1) return Promise.all(items.map(worker));
  const size = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let next = 0;
  let failure = null;

  async function lane() {
    while (failure === null) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: size }, lane));
  if (failure) throw failure;
  return results;
}

/**
 * The whole chain in order, for a direct end-to-end check.
 *
 * A recording is looked up before it is made. Everything that decides what the
 * audio will contain is folded into a digest first, so a hit means the stored
 * recording is exactly the one this request would have produced.
 */
export async function synthesise({ text, url, title, lang, locale, source } = {}) {
  const read = await readSource({ text, url, title });
  const clipped = limitText(read.text);
  const language = resolveLanguage(lang, locale);

  const digest = digestFor({
    text: clipped.text,
    languageCode: language.code,
    voice: config.ttsVoice,
    model: config.ttsModel,
    kbps: config.mp3Kbps,
    sampleRate: config.mp3SampleRate,
  });

  const hit = await getCached(digest).catch(() => null);
  if (hit) {
    return {
      read,
      clipped,
      translated: { text: null, name: language.name, code: language.code, cached: true },
      spoken: { mp3: hit.mp3, pieces: null, cached: true },
      cached: true,
      meta: { ...hit.meta, cached: true, digest },
    };
  }

  const translated = await translateForSpeech(clipped.text, { lang, locale, source });
  const spoken = await speak(translated.text);
  const meta = {
      language: translated.name,
      languageCode: translated.code,
      chars: clipped.text.length,
      totalChars: clipped.totalChars,
      truncated: clipped.truncated,
    via: read.via,
    seconds: Number(spoken.seconds.toFixed(2)),
    bytes: spoken.mp3.length,
    pieces: spoken.pieces,
    firstByteMs: spoken.firstByteMs,
    synthMs: spoken.synthMs,
    cached: false,
  };

  await putCached(digest, spoken.mp3, meta).catch(() => {});
  return { read, clipped, translated, spoken, cached: false, meta: { ...meta, digest } };
}
