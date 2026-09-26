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
  /** Gemini returns 24 kHz mono PCM. */
  pcmSampleRate: 24000,
  apiKey: process.env.LISTEN_API_KEY || '',
  allowedOrigins: (process.env.LISTEN_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
};
