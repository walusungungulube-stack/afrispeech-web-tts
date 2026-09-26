/**
 * The endpoint spends a metered Gemini quota, so it stays shut unless a caller
 * presents the shared key from an allowed origin. Without this, anyone who can
 * read the widget's source can call the URL directly and spend the money.
 *
 * Two deliberate choices:
 *
 *   - A missing key is a configuration error, not an open door. Failing open
 *     here would turn a typo into a silent, unbounded bill.
 *   - CORS is driven by an allowlist. Echoing '*' would let any site on the
 *     internet spend the quota from a visitor's browser.
 */
import { config } from './config.mjs';

const always = () => (process.env.LISTEN_API_KEY || '').trim();

function origins() {
  return config.allowedOrigins;
}

export function checkAuth(request) {
  const expected = always();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: 'server is not configured: LISTEN_API_KEY is unset',
    };
  }

  const supplied = (request.headers.get('x-listen-key') || '').trim();
  // Compare in constant time so the key cannot be recovered a character at a time.
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, status: 401, error: 'invalid or missing x-listen-key' };
  }

  const origin = request.headers.get('origin');
  const allowed = origins();
  // A request with no Origin header is not a browser (curl, server-to-server)
  // and the allowlist does not apply to it.
  if (origin && allowed.length && !allowed.includes('*') && !allowed.includes(origin)) {
    return { ok: false, status: 403, error: 'origin not allowed' };
  }
  return { ok: true };
}

function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * CORS headers. When the origin is not on the allowlist the header is omitted
 * rather than filled in with a wildcard, so the browser refuses the reply.
 */
export function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const allowed = origins();
  const permitted = Boolean(origin) && allowed.includes('*');
  const exact = Boolean(origin) && allowed.includes(origin);

  const headers = {
    'access-control-allow-headers': 'content-type, x-listen-key',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    Vary: 'Origin',
  };
  if (permitted || exact) headers['access-control-allow-origin'] = permitted ? '*' : origin;
  return headers;
}
