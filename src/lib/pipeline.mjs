/**
 * The chain, in order: read, clip, translate, split, speak, join, encode.
 *
 * Translation comes first and speech second, and they are separate services on
 * purpose. The text is translated by Google into the reader's own language, and
 * only then handed to Gemini to be read aloud, so the model is never asked to
 * understand or translate anything — it is given words and asked to say them.
 * That is the difference between a voice that can be pointed at any language and
 * one that can only manage the ones a particular model happens to speak.
 *
 * A whole article does not fit in one turn, so the translated text is split into
 * sentence-sized pieces, the pieces are spoken at the same time rather than one
 * after another, and the audio is joined back into a single recording. Gemini
 * returns the same 24 kHz signed 16-bit mono PCM for every piece, so joining is
 * a plain concatenation with nothing to resample and nothing to line up.
 */
import { truncateToLimit } from './truncate.mjs';
import { translate, pivotsThroughThai } from './translate.mjs';
import { stillInThai } from './pivot.mjs';
import { findSpeechLanguage, defaultForLocale } from './languages.mjs';
import { liveTts } from './live-tts.mjs';
import { geminiTts, isQuotaError } from './gemini.mjs';
import { retryDelayMs } from './retry.mjs';
import { splitForSynthesis } from './chunk.mjs';
import { withRetry, bisect } from './retry.mjs';
import { withSlot } from './semaphore.mjs';
import { pcmToMp3, pcmSeconds } from './mp3.mjs';
import { config } from './config.mjs';
import { digestFor, getCached, putCached } from './store.mjs';

/** Step 1: the words. The widget sends text it read itself; nothing is fetched. */
export function readSource({ text } = {}) {
  /* The reader sends the words to be read. It used to be able to send an
     address instead, and the service fetched that address itself, which meant
     anyone could aim a request at a host only this service could reach.
     Nothing needed it once the button sat on the page being read. */
  if (typeof text === 'string' && text.trim().length > 0) return { text };
  throw new Error('Nothing to read: the request carried no text.');
}

/** Step 2: cap the length, preferring to finish on a full stop. */
export function limitText(text) {
  return truncateToLimit(text, config.maxChars);
}

/**
 * The language to read in, and never a guess that leaves the reader with a voice
 * they did not choose: anything offered is used, and English stands in only when
 * nothing better was asked for.
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
 * Translate, and check the pivot out of Thai actually happened.
 *
 * The free endpoint routes through Thai and will happily hand the Thai back
 * untranslated, which sounds like a service that works and produces a language
 * nobody asked for. Asking again usually gets a real translation, and if it
 * never does then saying so is better than speaking Thai to someone who chose
 * Swahili. The Cloud API does not pivot, so there is nothing to check.
 */
/**
 * Which language the text is being asked for, or null when it is already in it.
 *
 * defaultForLocale hands back a code and findSpeechLanguage turns a code into a
 * language, so the two have to be composed here rather than with `||` at each
 * call site. Composed wrongly, a string stood in for a language and every
 * property read off it was undefined, which is how a run could finish with no
 * language name at all and nothing else looking wrong.
 *
 * Null means English, the pivot language this service does not translate into,
 * and so the honest answer is to read the page as it stands.
 */
function resolveTarget(lang, locale) {
  return findSpeechLanguage(lang) || findSpeechLanguage(defaultForLocale(locale));
}

export async function translateOutOfThai(
  text,
  request = {},
  attempts = config.translateAttempts,
  seam = translateForSpeech,
  engine = config.translateEngine,
) {
  // No target means no translation, so there is no Thai to have failed the hop.
  if (!pivotsThroughThai(engine) || !resolveTarget(request.lang, request.locale)) {
    return seam(text, request);
  }

  const language = resolveTarget(request.lang, request.locale);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await seam(text, request);
    if (!stillInThai(result.text, language?.google, result.detected)) return result;
  }

  // The language is named because the failure is otherwise baffling from the
  // outside: a run asked for one language came back with another, and the log
  // line is the only place that says so.
  throw new Error(
    `translate: the translation came back in Thai after ${attempts} attempts, so the `
    + `pivot out of Thai did not take and nothing was recorded as ${language?.name ?? 'the requested language'}. `
    + 'Set LISTEN_TRANSLATE_ENGINE=cloud with a Google Cloud Translation key, which '
    + 'translates directly and does not depend on this hop.',
  );
}

/** Step 3: pick a language and translate. */
export async function translateForSpeech(text, { lang, locale, source } = {}, seam = translate) {
  const language = resolveTarget(lang, locale);
  if (!language) {
    // Already in the language asked for. Translating it would spend a request to
    // arrive back where it started, and the unofficial endpoint is free to return
    // something else entirely, so the text goes to the voice untouched.
    return { text, detected: null, code: 'en', name: 'English', google: 'en', untranslated: true };
  }

  const translated = await seam(text, language.google, source || 'auto', {
    engine: config.translateEngine,
    apiKey: config.googleTranslateKey,
  });
  return {
    text: translated.text,
    detected: translated.detected,
    code: language.code,
    name: language.name,
    google: language.google,
  };
}

/**
 * Ask for one piece of audio, using whichever speech engine is configured.
 *
 * Both return the same shape, so nothing downstream of this has to know which
 * one ran. The quota refusal is checked in one place because both are metered
 * against the same key and neither is worth retrying when the key says no.
 */
function speakPieceWith(text, instruction) {
  return config.speechEngine === 'live'
    ? liveTts({
      text,
      instruction,
      voice: config.ttsVoice,
      model: config.liveModel,
      timeoutMs: config.ttsTimeoutMs,
    })
    : geminiTts({
      text,
      voice: config.ttsVoice,
      model: config.ttsModel,
      timeoutMs: config.ttsTimeoutMs,
    });
}

/**
 * Speak one piece, retrying it if the model drops the connection.
 *
 * A piece that fails because the connection dropped is worth asking again, and
 * usually succeeds. A piece that fails because it is too long to finish in one
 * turn is not: asking again produces the same failure. So after a couple of
 * plain attempts the piece is spoken as two halves instead of being repeated. A
 * refused quota is neither: it cannot be spent into success, so it is handed
 * straight back rather than costing four more attempts against the same limit.
 * If the recovery also fails the error is allowed out rather than quietly
 * dropping the words from the clip.
 */
async function speakPiece(piece, depth, language) {
  // The system instruction tells the model to read whatever it is sent; this
  // line is the per-utterance context it applies, so the piece is read in the
  // requested accent rather than the voice's own default. It rides ahead of the
  // text, which is the arrangement the model expects, and the system
  // instruction says not to read it out loud.
  const instruction = language?.name ? `speak in ${language.name} accent` : '';

  // Each session is one of the globally available slots, so readers queue
  // behind each other rather than each opening up to ttsConcurrency sockets.
  const request = (words) => withSlot(
    () => speakPieceWith(words, instruction),
    { limit: config.maxLiveSessions, maxWaitMs: config.maxSlotWaitMs },
  );

  return withRetry(() => request(piece), {
    attempts: config.ttsMaxAttempts,
    // A per-minute quota carries the answer in the refusal — "retry in 31s" —
    // so it is worth waiting for. A hard quota carries no such promise, and
    // repeating it would only spend attempts other readers are owed.
    shouldRetry: (error) => !isQuotaError(error) || retryDelayMs(error) !== null,
    onFailure: async (attempt, error) => {
      if (attempt < 2 || depth >= config.ttsMaxBisect) return null;
      const halves = bisect(piece);
      if (!halves) return null;
      const spoken = await Promise.all(halves.map((half) => speakPiece(half, depth + 1, language)));
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

/** Split the translated text, speak the pieces, join the audio, encode it. */
export async function speak(text, language) {
  const pieces = splitForSynthesis(text, config.ttsChunkChars);
  const started = Date.now();

  // The pieces are independent, so they are spoken at the same time rather than
  // one after another. A full article is five or six pieces of roughly twenty
  // seconds each; in sequence that is two minutes of waiting, and running them
  // together brings it back to about the length of the longest piece. Order is
  // restored by index when the results are joined.
  const spoken = await inParallel(pieces, config.ttsConcurrency, (piece) => speakPiece(piece, 0, language));

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
export async function synthesise({ text, lang, locale, source } = {}) {
  const read = { text: String(text || '').trim() };
  if (!read.text) {
    const error = new Error('Nothing to read: send the page text as "text".');
    error.status = 400;
    throw error;
  }
  const clipped = truncateToLimit(read.text, config.maxChars);
  const language = resolveTarget(lang, locale);
  // Unresolved means the text is read as it stands, and the digest still has to
  // say so: leaving the language out would file every unresolved request under
  // one key and let a recording made for one be served for another.
  const languageCode = language ? language.code : 'en';

  const digest = digestFor({
    text: clipped.text,
    languageCode,
    translateEngine: config.translateEngine,
    speechEngine: config.speechEngine,
    model: config.speechEngine === 'live' ? config.liveModel : config.ttsModel,
    voice: config.ttsVoice,
    kbps: config.mp3Kbps,
    sampleRate: config.mp3SampleRate,
  });

  const hit = await getCached(digest).catch(() => null);
  if (hit?.mp3) {
    return {
      read,
      clipped,
      translated: {
        text: null,
        name: language ? language.name : 'English',
        code: languageCode,
        cached: true,
      },
      spoken: { ...hit.meta, mp3: hit.mp3, cached: true },
      cached: true,
      meta: {
        ...hit.meta,
        digest,
        engine: config.speechEngine,
        translate: config.translateEngine,
        language: language ? language.name : 'English',
        languageCode,
        chars: clipped.text.length,
        totalChars: clipped.totalChars,
        truncated: clipped.truncated,
        bytes: hit.mp3.length,
        cached: true,
      },
    };
  }

  const translated = await translateOutOfThai(clipped.text, { lang, locale, source });
  const spoken = await speak(translated.text, translated);
  await putCached(digest, spoken.mp3, {
    pieces: spoken.pieces,
    seconds: spoken.seconds,
    firstByteMs: spoken.firstByteMs,
    synthMs: spoken.synthMs,
    engine: config.speechEngine,
    translate: config.translateEngine,
  }).catch(() => {});

  const meta = {
    digest,
    engine: config.speechEngine,
    translate: config.translateEngine,
    language: translated.name,
    languageCode: translated.code,
    pieces: spoken.pieces,
    seconds: spoken.seconds,
    bytes: spoken.mp3.length,
    firstByteMs: spoken.firstByteMs,
    synthMs: spoken.synthMs,
    chars: clipped.text.length,
    totalChars: clipped.totalChars,
    truncated: clipped.truncated,
    cached: false,
  };

  return { read, clipped, translated, spoken, cached: false, meta };
}
