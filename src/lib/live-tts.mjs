/**
 * Speech synthesis over the Gemini Live API, using the official SDK.
 *
 * Two things the SDK requires that are easy to get wrong:
 *
 *  1. `callbacks` is a required field on LiveConnectParameters. Leave it out
 *     and the session throws on the first server message.
 *  2. `onopen` can fire before `connect()` has resolved, so the session object
 *     is not always assigned yet. We hold the text until both the socket is
 *     open and the session exists rather than guessing with a timeout.
 *
 * Live synthesises at roughly 0.93x realtime, so the audio takes about as long
 * to arrive as it is long. That is the reason this runs as a durable workflow
 * step rather than inside a request that has to answer within a few seconds.
 */
import { GoogleGenAI } from '@google/genai';

/**
 * The Live models are conversational: handed a page of text with nothing else
 * they will discuss it rather than speak it. This pins them to the job, and it
 * rides on the session config rather than the message, so it is not re-sent on
 * every turn and cannot be read as part of the page.
 *
 * The model both reduces the page and speaks the result. That is deliberate: the
 * summary is capped at a few hundred characters, so a reader gets a clip worth
 * their time rather than a whole page read out at length, and the same turn
 * both reduces and speaks, which costs one model call instead of two. The
 * specific language and budget travel in the per-turn context line.
 */
const TTS_SYSTEM_INSTRUCTION =
  'You are a text-to-speech engine for people who cannot read the screen. The ' +
  'user message names a target language and a character budget, and then gives ' +
  'the text of a web page. Reduce that page to a summary that fits inside the ' +
  'character budget and is written in the target language, then read only that ' +
  'summary aloud, in that language. Never read the original text aloud. Keep ' +
  'the summary faithful to the page: do not answer the page, do not comment ' +
  'on it, do not add anything that is not in it, and do not invent facts. ' +
  'Speak only the summary.';

/**
 * @param {object} options
 * @param {string} options.text     what to read aloud
 * @param {string} options.voice    prebuilt voice name
 * @param {string} options.model    Live model id
 * @param {number} [options.timeoutMs]
 * @param {string} [options.instruction] optional speaking direction
 * @returns {Promise<{pcm: Buffer, chunks: number, firstByteMs: number, totalMs: number}>}
 */
export function liveTts({
  text,
  voice = 'Zephyr',
  model,
  timeoutMs = 120_000,
  instruction = '',
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('live-tts: GEMINI_API_KEY is not set');

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const chunks = [];
    let firstByteMs = null;
    let settled = false;
    let session = null;

    // The text waits here until the socket is open *and* connect() has resolved.
    let socketOpen = false;
    let pending = null;
    const flush = () => {
      if (settled || !socketOpen || !session || pending === null) return;
      const payload = pending;
      pending = null;
      try {
        session.sendRealtimeInput({ text: payload });
      } catch (error) {
        settle(new Error(`live-tts: send failed: ${error.message}`));
      }
    };

    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session?.close(); } catch { /* already gone */ }
      if (error) return reject(error);
      resolve({
        pcm: Buffer.concat(chunks),
        chunks: chunks.length,
        firstByteMs,
        totalMs: Date.now() - started,
      });
    };

    const ai = new GoogleGenAI({ apiKey });
    const timer = setTimeout(
      () => settle(new Error(`live-tts: timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const callbacks = {
      onopen: () => {
        socketOpen = true;
        pending = instruction
          ? `${instruction}\n\n${text}`
          : text;
        flush();
      },
      onmessage: (message) => {
        const content = message?.serverContent;
        if (!content) return;
        for (const part of content.modelTurn?.parts ?? []) {
          const data = part?.inlineData?.data;
          if (data) {
            if (firstByteMs === null) firstByteMs = Date.now() - started;
            chunks.push(Buffer.from(data, 'base64'));
          }
        }
        if (content.turnComplete) settle();
      },
      onerror: (event) => settle(new Error(`live-tts: ${event?.message ?? 'socket error'}`)),
      onclose: () => {
        if (!settled) settle(new Error('live-tts: closed before the turn completed'));
      },
    };

    ai.live
      .connect({
        model,
        callbacks,
        config: {
          responseModalities: ['AUDIO'],
          systemInstruction: TTS_SYSTEM_INSTRUCTION,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      })
      .then((opened) => {
        session = opened;
        flush();
      })
      .catch((error) => settle(new Error(`live-tts: connect failed: ${error.message}`)));
  });
}
