function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

export const config = {
  // Hard ceiling of 1000: the brief is the first 1000 characters, and the
  // setting exists to shorten that for testing, never to lengthen it.
  maxChars: clampInt(process.env.LISTEN_MAX_CHARS, 200, 1000, 1000),
  mp3Kbps: clampInt(process.env.LISTEN_MP3_KBPS, 8, 128, 24),
  mp3SampleRate: clampInt(process.env.LISTEN_MP3_SAMPLE_RATE, 8000, 24000, 16000),
  ttsModel: process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-live-preview',
  ttsVoice: process.env.GEMINI_TTS_VOICE || 'Zephyr',
  ttsTimeoutMs: clampInt(process.env.LISTEN_TTS_TIMEOUT_MS, 10_000, 300_000, 120_000),
  // Gemini Live will not hold a turn open long enough for a whole article, so
  // the text is spoken in pieces of about this size and the audio is joined.
  ttsChunkChars: clampInt(process.env.LISTEN_TTS_CHUNK_CHARS, 80, 400, 200),
  // How many pieces may be spoken at once.
  ttsConcurrency: clampInt(process.env.LISTEN_TTS_CONCURRENCY, 1, 8, 4),
  // How many times a failing piece is asked again before the run gives up.
  ttsMaxAttempts: clampInt(process.env.LISTEN_TTS_MAX_ATTEMPTS, 1, 10, 5),
  // How many times a piece may be halved in the attempt to recover it.
  ttsMaxBisect: clampInt(process.env.LISTEN_TTS_MAX_BISECT, 0, 4, 2),
  /** Gemini returns 24 kHz mono PCM. */
  pcmSampleRate: 24000,
  apiKey: process.env.LISTEN_API_KEY || '',
  allowedOrigins: (process.env.LISTEN_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
};
