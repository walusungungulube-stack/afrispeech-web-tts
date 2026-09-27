/**
 * Speech over the Gemini Live API, using the official SDK.
 *
 * Two things the SDK requires that are easy to get wrong:
 *
 *  1. `callbacks` is a required field on LiveConnectParameters. Leave it out
 *     and the session throws on the first server message.
 *  2. `onopen` can fire before `connect()` has resolved, so the session object
 *     is not always assigned yet. We hold the text until both the socket is
 *     open and the session exists rather than guessing with a timeout.
 *
 * The text sent here has already been translated, so this is only ever the
 * speaking step: the model is given words in the reader's language and asked to
 * read them, not asked to understand them. The instruction pins it to that,
 * because the models are conversational and handed a page of text with nothing
 * else they will discuss it rather than read it.
 *
 * Live will not hold a turn open long enough for a whole article, which is why
 * the pipeline sends it a piece at a time, and it is metered far more tightly
 * than the request-based TTS engine: on one key, sixteen concurrent sessions
 * were enough to have eleven refused. It is the experimental option and is
 * offered as such in the docs.
 */
import { GoogleGenAI } from '@google/genai';

const TTS_SYSTEM_INSTRUCTION =
  'You are a text-to-speech engine for people who cannot read the screen. You are sent '
  + 'text that has already been translated, sometimes preceded by a context line '
  + 'describing how to speak it. Read that text aloud, exactly as written, in the '
  + 'language it is written in. Do not summarise it, do not discuss it, do not answer '
  + 'it, do not add anything, and do not read the context line out loud. Speak only '
  + 'the text you were given, in that order.';

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
      onclose: (event) => {
        // The close code is the only thing that distinguishes Gemini dropping
        // the session (1011, 1008, a rate-limit close) from a socket that ended
        // for an ordinary reason, and without it a concurrency ceiling found in
        // production is a number nobody can explain. Some servers send no reason
        // at all, so the code stands on its own rather than being prettied up.
        if (!settled) {
          const code = event?.code;
          const reason = event?.reason ? ` ${event.reason}` : '';
          settle(new Error(`live-tts: closed before the turn completed (code ${code ?? 'none'})${reason}`));
        }
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

/* Both Gemini engines are refused in the same words, so the check lives with them
 * and is re-exported here because most callers reach it through the Live path. */
export { isQuotaError } from './gemini.mjs';
