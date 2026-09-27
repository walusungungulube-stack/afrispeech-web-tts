function clampInt(name, raw, min, max, fallback) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.min(Math.max(value, min), max);
  // Silently clamping a tuning knob is worse than a loud one. Someone capacity
  // testing sets 200, gets 64, reads a clean result off it, and concludes 200
  // was fine. The clamp is still a clamp; it just says so.
  if (clamped !== value) {
    console.warn(
      `[config] ${name} is ${value}, outside ${min}-${max}. Using ${clamped} instead.`,
    );
  }
  return clamped;
}

export const config = {
  // How much page text is read in. The model reduces this to a summary before
  // speaking, so a larger input buys a better summary rather than a longer
  // recording, and the setting exists to shorten that for testing.
  maxChars: clampInt('LISTEN_MAX_CHARS', process.env.LISTEN_MAX_CHARS, 200, 3000, 3000),
  // The ceiling on what is actually spoken. Everything the reader hears comes
  // from a summary written to fit inside this, in the language they chose.
  summaryMaxChars: clampInt('LISTEN_SUMMARY_MAX_CHARS', process.env.LISTEN_SUMMARY_MAX_CHARS, 100, 500, 500),
  mp3Kbps: clampInt('LISTEN_MP3_KBPS', process.env.LISTEN_MP3_KBPS, 8, 128, 24),
  mp3SampleRate: clampInt('LISTEN_MP3_SAMPLE_RATE', process.env.LISTEN_MP3_SAMPLE_RATE, 8000, 24000, 16000),
  ttsModel: process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-live-preview',
  ttsVoice: process.env.GEMINI_TTS_VOICE || 'Zephyr',
  ttsTimeoutMs: clampInt('LISTEN_TTS_TIMEOUT_MS', process.env.LISTEN_TTS_TIMEOUT_MS, 10_000, 300_000, 120_000),
  // How many times a failing turn is asked again before the run gives up. It is
  // asked again whole: splitting the page would be two summaries, not one.
  ttsMaxAttempts: clampInt('LISTEN_TTS_MAX_ATTEMPTS', process.env.LISTEN_TTS_MAX_ATTEMPTS, 1, 10, 5),

  // The service is public, so these are what stand between the Gemini quota and
  // anyone who finds the endpoint. Set a limit to 0 to switch that one off.
  rateEnabled: process.env.LISTEN_RATE_ENABLED !== '0',
  // Per address, per minute, and per day.
  ratePerMinute: clampInt('LISTEN_RATE_PER_MINUTE', process.env.LISTEN_RATE_PER_MINUTE, 0, 600, 5),
  ratePerDay: clampInt('LISTEN_RATE_PER_DAY', process.env.LISTEN_RATE_PER_DAY, 0, 100000, 100),
  // Across everyone, per day. The per-address limits are all bypassed by
  // rotating address; this is the one that is not.
  budgetPerDay: clampInt('LISTEN_BUDGET_PER_DAY', process.env.LISTEN_BUDGET_PER_DAY, 0, 1000000, 5000),

  // How many Live sessions may be open across all requests at once. One turn is
  // one session, so this is the ceiling on readers being served at the same
  // instant; readers past it wait in withSlot rather than being refused.
  //
  // Set high on purpose, and treat it as a queue length rather than a
  // measurement. What the shared key can actually sustain is a property of the
  // key, not of this file, so a cap chosen to look tidy would only hide the
  // ceiling until the day traffic arrived. Past this many, requests wait and
  // then are told the service is busy, which is the honest failure.
  maxLiveSessions: clampInt('LISTEN_MAX_LIVE_SESSIONS', process.env.LISTEN_MAX_LIVE_SESSIONS, 1, 512, 300),
  // How long a reader waits for a slot before being told the service is busy.
  maxSlotWaitMs: clampInt('LISTEN_MAX_SLOT_WAIT_MS', process.env.LISTEN_MAX_SLOT_WAIT_MS, 1000, 300000, 60000),
  /** Gemini returns 24 kHz mono PCM. */
  pcmSampleRate: 24000,
  apiKey: process.env.LISTEN_API_KEY || '',
  allowedOrigins: (process.env.LISTEN_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
};
