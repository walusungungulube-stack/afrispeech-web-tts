/**
 * The actual work, kept out of the workflow shell.
 *
 * The workflow exists to survive long jobs, not to hold the logic: Gemini speaks
 * at roughly 0.96x realtime, so a full clip takes about as long to record as it
 * is long, well past what a single request can wait for. Each function here is
 * one workflow step, and each is a plain function, so the whole chain can be run
 * and checked without a message queue in the way.
 */
import { truncateToLimit } from './truncate.mjs';
import { findSpeechLanguage, defaultForLocale } from './languages.mjs';
import { liveTts } from './live-tts.mjs';
import { withRetry } from './retry.mjs';
import { withSlot } from './semaphore.mjs';
import { pcmToMp3, pcmSeconds } from './mp3.mjs';
import { config } from './config.mjs';
import { digestFor, getCached, putCached } from './store.mjs';

/** Step 1: the words. The widget reads the page in the browser and sends the text. */
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
 * Speak, then encode.
 *
 * One turn, not several. The model reduces the page to a summary before it
 * speaks, so what it has to say fits comfortably inside a single turn, and the
 * clip comes back in one piece with nothing to concatenate. Gemini hands back
 * 24 kHz signed 16-bit mono PCM.
 */
export async function speak(text, language) {
  const started = Date.now();
  const spoken = await speakPage(text, language);

  const pcm = spoken.pcm;
  const firstByteMs = spoken.firstByteMs;
  const mp3 = await pcmToMp3(pcm, {
    sampleRate: config.pcmSampleRate,
    kbps: config.mp3Kbps,
    outRate: config.mp3SampleRate,
  });
  return {
    mp3,
    seconds: pcmSeconds(pcm, config.pcmSampleRate),
    firstByteMs: Number.isFinite(firstByteMs) ? firstByteMs : null,
    synthMs: Date.now() - started,
  };
}

/** The context line the turn is given, ahead of the page text itself.
 *
 *  The system instruction says what the turn is for; this carries the two values
 *  it acts on. Prefixing it to the page means the model is told the language and
 *  the budget before it reads what it has to reduce, rather than being asked to
 *  reduce first and told the constraints afterwards. */
export function speechInstruction(language) {
  if (!language?.name) return '';
  return `Target language: ${language.name}. Character budget: ${config.summaryMaxChars}.`;
}

/**
 * Speak the page in one turn, retrying if the model drops the connection.
 *
 * A turn that fails because the connection dropped is worth asking again, and
 * usually succeeds. It is not retried by speaking half the page: the model
 * reduces the page before it speaks, so a turn is already short, and two halves
 * would be two summaries of up to the full budget each. That is the reader
 * getting twice what they asked for, from a fallback meant to help them. If the
 * retries run out the error is allowed out rather than serving a clip of
 * nothing, and it is reported as what actually went wrong.
 */
async function speakPage(text, language) {
  const instruction = speechInstruction(language);

  // One turn is one of the globally available slots, so readers queue behind
  // each other rather than each holding several.
  const request = (page) => withSlot(() => liveTts({
    text: page,
    instruction,
    voice: config.ttsVoice,
    model: config.ttsModel,
    timeoutMs: config.ttsTimeoutMs,
  }), { limit: config.maxLiveSessions, maxWaitMs: config.maxSlotWaitMs });

  return withRetry(() => request(text), { attempts: config.ttsMaxAttempts });
}

/**
 * The whole chain in order, for a direct end-to-end check.
 *
 * A recording is looked up before it is made. Everything that decides what the
 * audio will contain is folded into a digest first, so a hit means the stored
 * recording is exactly the one this request would have produced.
 */
export async function synthesise({ text, lang, locale } = {}) {
  const read = readSource({ text });
  const clipped = limitText(read.text);
  const language = resolveLanguage(lang, locale);

  const digest = digestFor({
    text: clipped.text,
    languageCode: language.code,
    summaryChars: config.summaryMaxChars,
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
      spoken: { mp3: hit.mp3, cached: true },
      cached: true,
      meta: { ...hit.meta, cached: true, digest },
    };
  }

  const spoken = await speak(clipped.text, language);
  const meta = {
    language: language.name,
    languageCode: language.code,
    chars: clipped.text.length,
    totalChars: clipped.totalChars,
    truncated: clipped.truncated,
    seconds: Number(spoken.seconds.toFixed(2)),
    bytes: spoken.mp3.length,
    firstByteMs: spoken.firstByteMs,
    synthMs: spoken.synthMs,
    cached: false,
  };

  await putCached(digest, spoken.mp3, meta).catch(() => {});
  return { read, clipped, spoken, cached: false, meta: { ...meta, digest } };
}
