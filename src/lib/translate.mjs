/**
 * Translation, and the two ways to get it.
 *
 * The choice is which service, not which language:
 *
 *   - `cloud` is the Google Cloud Translation API. It is the supported product,
 *     it has a quota you can see and raise, and it is billed predictably. It
 *     translates straight from the source language to the target.
 *   - `unofficial` is the free endpoint the translate widget in a browser uses.
 *     It needs no account, which makes it the quickest way to see the service
 *     work, and it has no quota you can inspect and no support when it changes.
 *     It is also routed through Thai, which is a trick rather than a setting:
 *     Google is far better resourced for English and Thai than for the smaller
 *     African languages, so going via Thai as a bridge produces noticeably more
 *     natural output than the direct hop. That trick is worth keeping with this
 *     engine and is not applied to the Cloud API, which translates directly and
 *     is not playing by those rules.
 *
 * Both return the same shape, so the pipeline does not care which ran. This is
 * the difference between a demonstration and something you can put in front of
 * readers: the first pair of settings is free and unaccountable, the second is
 * billed and accountable, and only one of them is a decision you can defend.
 */

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const CLOUD_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const PIVOT = 'th';
const CHUNK = 1800;
const TIMEOUT_MS = 8000;

/**
 * Translate text into `target`, always through Thai.
 *
 * @param {string} text      source text, already clipped to the length cap
 * @param {string} target    Google language code for the output language
 * @param {string} [source]  known source code; omit to let Google detect it
 * @returns {Promise<{text: string, detected: string|null, pivoted: boolean}>}
 */
export async function translate(text, target, source = 'auto', options = {}) {
  const engine = options.engine || 'unofficial';
  return engine === 'cloud'
    ? cloudTranslate(text, target, source, options)
    : unofficialTranslate(text, target, source, options);
}

/** Whether this engine routes through Thai, and so can hand back Thai untranslated. */
export function pivotsThroughThai(engine) {
  return engine !== 'cloud';
}

async function unofficialTranslate(text, target, source = 'auto', { fetchImpl = fetch } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { text: '', detected: null, pivoted: true };

  const viaThai = await translateChunks(clean, source, PIVOT, fetchImpl);
  const final = await translateChunks(viaThai.text, PIVOT, target, fetchImpl);

  return {
    text: final.text,
    detected: viaThai.detected,
    pivoted: true,
  };
}

/**
 * The Google Cloud Translation API, straight from source to target.
 *
 * `source` is omitted when it is 'auto' so that Cloud does its own detection,
 * which is better than guessing and is reported back in the response. Batches
 * go out as an array rather than being split on sentence boundaries: Cloud
 * accepts a list per request and joins nothing, so the text keeps its own
 * punctuation and the splitting the free endpoint needs is not needed here.
 */
async function cloudTranslate(text, target, source = 'auto', {
  apiKey = process.env.GOOGLE_TRANSLATE_API_KEY || '',
  fetchImpl = fetch,
} = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { text: '', detected: null, pivoted: false };

  if (!apiKey) {
    throw new Error(
      'translate: the cloud engine needs GOOGLE_TRANSLATE_API_KEY. Enable the Cloud '
      + 'Translation API on a project with billing, create a key, and set it as a '
      + 'secret, or set LISTEN_TRANSLATE_ENGINE=unofficial for the free endpoint.',
    );
  }

  const body = { q: [clean], target, format: 'text' };
  if (source && source !== 'auto') body.source = source;

  const response = await fetchImpl(`${CLOUD_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`translate: cloud HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
  }

  const data = await response.json();
  const first = data?.data?.translations?.[0];
  const out = first?.translatedText ? unescapeEntities(first.translatedText) : '';
  if (!out.trim()) throw new Error('translate: cloud returned nothing');

  return {
    text: out.replace(/\s+/g, ' ').trim(),
    detected: first.detectedSourceLanguage || (source === 'auto' ? null : source),
    pivoted: false,
  };
}

/**
 * Cloud escapes a few characters even in plain-text mode, most visibly
 * apostrophes, which arrive as &#39; and would otherwise be read aloud as
 * "hash thirty nine semi-colon".
 */
function unescapeEntities(text) {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** One hop: source -> target, split across requests when the text is long. */
async function translateChunks(text, source, target, fetchImpl) {
  let detected = null;
  const parts = [];

  for (const chunk of split(text)) {
    const result = await callGoogle(chunk, source, target, fetchImpl);
    parts.push(result.text);
    if (!detected && result.detected) detected = result.detected;
  }

  return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), detected };
}

async function callGoogle(text, source, target, fetchImpl) {
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client: 'gtx',
      sl: source,
      tl: target,
      dt: 't',
      q: text,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`translate: HTTP ${response.status} (${source} -> ${target})`);
  }

  const data = await response.json();
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const out = segments.map((seg) => (Array.isArray(seg) ? seg[0] : '')).join('');

  if (!out.trim()) {
    throw new Error(`translate: empty response (${source} -> ${target})`);
  }

  return { text: out, detected: typeof data?.[2] === 'string' ? data[2] : null };
}

/**
 * Google rejects very long queries, so split on sentence boundaries where we
 * can. A 1,000-character article fits in a single request; this only matters if
 * LISTEN_MAX_CHARS is raised.
 */
function split(text) {
  if (text.length <= CHUNK) return [text];

  const pieces = [];
  let rest = text;

  while (rest.length > CHUNK) {
    const window = rest.slice(0, CHUNK);
    const stop = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('。'),
      window.lastIndexOf('।'),
    );
    const cut = stop > CHUNK * 0.4 ? stop + 1 : CHUNK;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest.trim()) pieces.push(rest);
  return pieces;
}

/**
 * Put a value in a response header. Header values must be ASCII, and language
 * names contain non-ASCII characters, so anything outside Latin-1 is escaped.
 * The widget and the /listen page decode with decodeURIComponent.
 */
export function headerValue(value) {
  if (!value) return '';
  return /^[\x20-\x7E]*$/.test(String(value)) ? String(value) : encodeURIComponent(String(value));
}
