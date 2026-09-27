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
  // How much page text is read in. The whole of this is translated and then
  // spoken, so a larger figure is a longer recording and a larger bill rather
  // than a better one, and the setting exists to shorten it for testing.
  maxChars: clampInt('LISTEN_MAX_CHARS', process.env.LISTEN_MAX_CHARS, 200, 1000, 1000),

  /* Which services do the work. The two axes are independent so they can be
   * mixed, but they are meant to be read as a pair:
   *
   *   production   cloud        + gemini-tts   billed, accountable, high ceiling
   *   demo         unofficial   + live         free, unaccountable, low ceiling
   *
   * The defaults are the production pair. A demonstration that quietly spends
   * someone's money, or a production service quietly leaning on an endpoint
   * anyone can change underneath it, are both worse than being explicit about
   * which one is running. */
  translateEngine: ['unofficial', 'cloud'].includes(process.env.LISTEN_TRANSLATE_ENGINE)
    ? process.env.LISTEN_TRANSLATE_ENGINE
    : 'gemini',
  speechEngine: process.env.LISTEN_SPEECH_ENGINE === 'live' ? 'live' : 'gemini-tts',
  mp3Kbps: clampInt('LISTEN_MP3_KBPS', process.env.LISTEN_MP3_KBPS, 8, 128, 24),
  mp3SampleRate: clampInt('LISTEN_MP3_SAMPLE_RATE', process.env.LISTEN_MP3_SAMPLE_RATE, 8000, 24000, 16000),
  /* One model per speech engine, because they are different products with
   * different ids. LISTEN_SPEECH_ENGINE decides which of the two is read. */
  ttsModel: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
  translateModel: process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.5-flash',
  liveModel: process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview',
  ttsVoice: process.env.GEMINI_TTS_VOICE || 'Zephyr',
  ttsTimeoutMs: clampInt('LISTEN_TTS_TIMEOUT_MS', process.env.LISTEN_TTS_TIMEOUT_MS, 10_000, 300_000, 120_000),
  // Gemini will not hold a turn open long enough for a whole article, so the
  // translated text is spoken in pieces of about this size and joined back
  // together afterwards.
  ttsChunkChars: clampInt('LISTEN_TTS_CHUNK_CHARS', process.env.LISTEN_TTS_CHUNK_CHARS, 80, 400, 200),
  // How many pieces of one article may be spoken at once.
  ttsConcurrency: clampInt('LISTEN_TTS_CONCURRENCY', process.env.LISTEN_TTS_CONCURRENCY, 1, 8, 4),
  // How many times a failing piece may be halved in the attempt to recover it.
  ttsMaxBisect: clampInt('LISTEN_TTS_MAX_BISECT', process.env.LISTEN_TTS_MAX_BISECT, 0, 4, 2),
  // How many times translation is asked again when the pivot out of Thai did not
  // take, which the free endpoint reports by handing back the Thai it was given.
  // The Cloud API translates directly, so it has nothing to check.
  translateAttempts: clampInt('LISTEN_TRANSLATE_ATTEMPTS', process.env.LISTEN_TRANSLATE_ATTEMPTS, 1, 6, 3),
  // Only the cloud engine reads this.
  googleTranslateKey: process.env.GOOGLE_TRANSLATE_API_KEY || '',
  // How many times a failing piece is asked again before the run gives up.
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
  /* How many speech sessions may be open across all readers at once. A piece of
   * an article is one session, and one reader holds up to LISTEN_TTS_CONCURRENCY
   * of them, so this is the ceiling on concurrent readers divided by that.
   *
   * The default is 16 because that is near what was measured rather than because
   * it is a round number: on one Live key, eight concurrent sessions were all
   * served and sixteen had eleven refused for quota. It is capped at 64 because a
   * higher figure cannot be reached through Live at all, and raising it would
   * only let more readers queue for a limit that is already being hit. The
   * request-based TTS engine has a much higher ceiling; raise this once you have
   * measured your own key rather than on someone else's number. */
  maxLiveSessions: clampInt('LISTEN_MAX_LIVE_SESSIONS', process.env.LISTEN_MAX_LIVE_SESSIONS, 1, 64, 16),
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
