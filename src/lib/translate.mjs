/**
 * Translation via a Thai pivot.
 *
 * Google Translate is much better resourced for English and Thai than for the
 * smaller African languages, and it has deep training data linking them through
 * Thai. So instead of asking for English -> Swahili in one hop, we route the
 * text English -> Thai -> Swahili. The intermediate Thai acts as a bridge that
 * gives the model room to work, which produces noticeably more natural output
 * than the direct hop.
 *
 * This applies to every target, English included: an English page is sent to
 * Thai and back to English, because the round trip is what makes the English
 * read smoothly rather than echoing the source verbatim.
 *
 * The cost is one extra round trip to Google, roughly 50 ms per hop.
 */

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
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
export async function translate(text, target, source = 'auto') {
  const clean = String(text || '').trim();
  if (!clean) return { text: '', detected: null, pivoted: true };

  const viaThai = await translateChunks(clean, source, PIVOT);
  const final = await translateChunks(viaThai.text, PIVOT, target);

  return {
    text: final.text,
    detected: viaThai.detected,
    pivoted: true,
  };
}

/** One hop: source -> target, split across requests when the text is long. */
async function translateChunks(text, source, target) {
  let detected = null;
  const parts = [];

  for (const chunk of split(text)) {
    const result = await callGoogle(chunk, source, target);
    parts.push(result.text);
    if (!detected && result.detected) detected = result.detected;
  }

  return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), detected };
}

async function callGoogle(text, source, target) {
  const response = await fetch(ENDPOINT, {
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
