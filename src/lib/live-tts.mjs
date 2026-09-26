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
