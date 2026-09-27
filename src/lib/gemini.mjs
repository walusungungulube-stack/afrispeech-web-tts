/**
 * The Gemini side of speech, and the two ways it can be asked for it.
 *
 * There are two, and they are not interchangeable:
 *
 *   - Live (`gemini-*.live`) opens a bidirectional session and streams audio
 *     back as it is produced. It is the more natural voice, and it is also
 *     experimental, it holds a turn open only so long, and it is metered
 *     tightly: measured on one key, eight concurrent sessions were all served
 *     and sixteen had eleven refused for quota.
 *   - TTS (`gemini-*.tts`) is an ordinary request that returns finished audio.
 *     No long-lived socket, no turn to keep open, and a far larger ceiling,
 *     which is why it is the one recommended for production.
 *
 * Both return the same shape and the same 24 kHz signed 16-bit mono PCM, so
 * everything downstream — joining pieces, encoding MP3 — is identical whichever
 * one produced them. Only this file has to know which was used.
 *
 * Both are also metered against the key you deploy with, which is why the
 * refusal below is not retried: an exhausted quota cannot be spent twice into
 * success, and every repeat is taken from a limit other readers are sharing.
 */
import { GoogleGenAI, Modality } from '@google/genai';

/** Raised when the key is refused rather than the request being wrong. */
export function isQuotaError(error) {
  const text = String(error?.message ?? error ?? '');
  if (/exceeded your current quota|quota exceeded|RESOURCE_EXHAUSTED/i.test(text)) return true;
  return /\b429\b/.test(text);
}

/**
 * Ask Gemini TTS for finished audio. One request in, one clip out.
 *
 * @param {object} options
 * @param {string} options.text     what to read aloud, already in the target language
 * @param {string} [options.voice]  prebuilt voice name
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{pcm: Buffer, chunks: number, firstByteMs: number|null, totalMs: number}>}
 */
export async function geminiTts({
  text,
  voice,
  model,
  timeoutMs = 120_000,
  client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
} = {}) {
  const started = Date.now();
  let firstByteMs = null;
  const chunks = [];

  const response = await withTimeout(client.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  }), timeoutMs, 'gemini-tts: timed out');

  for (const part of response?.candidates?.[0]?.content?.parts ?? []) {
    const data = part?.inlineData?.data;
    if (!data) continue;
    if (firstByteMs === null) firstByteMs = Date.now() - started;
    chunks.push(Buffer.from(data, 'base64'));
  }

  if (!chunks.length) {
    // A model can answer with text and no audio at all, which reads as a
    // success with nothing in it. Saying so is more use than a zero-length clip.
    throw new Error('gemini-tts: the model returned no audio');
  }

  return {
    pcm: Buffer.concat(chunks),
    chunks: chunks.length,
    firstByteMs,
    totalMs: Date.now() - started,
  };
}

/**
 * Ask Gemini to translate. One request in, one text out — no chunking, and no
 * pivot through anything.
 *
 * The other two engines translate in pieces because their endpoints cap the
 * request and hop through Thai. This one is an ordinary model call: the whole
 * clipped page goes in one request, and the answer is the translation. Which
 * also means the request is bigger and the wait is longer than the endpoints',
 * so the timeout is the model's, not the endpoint's.
 *
 * @param {object} options
 * @param {string} options.text     the page text, already clipped to the cap
 * @param {string} options.target   Google code for the output language
 * @param {string} [options.source] known source code; omitted to let the model detect it
 * @returns {Promise<{text: string, detected: string|null, pivoted: boolean}>}
 */
export async function geminiTranslate({
  text,
  target,
  source,
  model = process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.5-flash',
  timeoutMs = 60_000,
  client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
} = {}) {
  const asked = source && source !== 'auto'
    ? `Translate the following text into ${target}. The source is ${source}. Reply with the translation only, no commentary, no quotes.`
    : `Translate the following text into ${target}. Reply with the translation only, no commentary, no quotes.`;

  const response = await withTimeout(client.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: `${asked}\n\n${text}` }] }],
  }), timeoutMs, 'gemini-translate: timed out');

  const out = response?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? '')
    .join('')
    .replace(/^\s*["']+|["']+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!out) throw new Error('gemini-translate: the model returned nothing');
  return { text: out, detected: null, pivoted: false };
}

/** A request that outlives its timeout is abandoned rather than left running. */
function withTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}
