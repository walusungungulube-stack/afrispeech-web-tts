/**
 * Pull the readable part out of a web page.
 *
 * Readability (Mozilla's algorithm, the same one the browser build of the
 * widget runs) throws away navigation, footers, ads and cookie banners, which
 * is exactly the "main content, not every scrap of text" behaviour we want.
 * linkedom parses far faster than jsdom and produces the same article for the
 * pages we tested.
 *
 * This is the server-side path, used by the standalone URL box on /listen. The
 * widget does not use it: a browser that has already rendered the page can
 * extract it directly, which also gets around bot walls that reject us.
 */

import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const USER_AGENT =
  'Mozilla/5.0 (compatible; AfriSpeechListen/1.0; +https://afrispeech.org/listen)';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;

/** Raised when a page has no article worth reading. */
export class UnsupportedPageError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'UnsupportedPageError';
  }
}

/** Anything below this is a nav page, a login wall, or an SPA shell. */
const MIN_USABLE_CHARS = 180;

export async function extractArticle(rawUrl) {
  const url = await assertSafeUrl(rawUrl);

  const response = await fetchWithGuards(url);
  const contentType = response.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
    throw new UnsupportedPageError('That URL is not a web page we can read.');
  }

  const html = await readCapped(response);
  return extractFromHtml(html, url);
}

/** Same extraction, for HTML the caller already has (the widget path). */
export function extractFromHtml(html, baseUrl) {
  if (!html || html.length < 200) {
    throw new UnsupportedPageError('This page had no readable text.');
  }

  const { document } = parseHTML(html);
  const doc = document.cloneNode(true);
  if (baseUrl) {
    const base = doc.createElement('base');
    base.setAttribute('href', baseUrl);
    doc.head?.appendChild(base);
  }

  let article = null;
  try {
    article = isProbablyReaderable(doc) ? new Readability(doc, { charThreshold: 200 }).parse() : null;
  } catch {
    article = null;
  }
  if (!article?.textContent) article = fallbackArticle(doc);

  const text = normalise(article?.textContent || '');
  if (text.length < MIN_USABLE_CHARS) {
    throw new UnsupportedPageError('This page had no readable text.');
  }

  return {
    title: normalise(article?.title || ''),
    byline: normalise(article?.byline || ''),
    excerpt: normalise(article?.excerpt || ''),
    siteName: normalise(article?.siteName || ''),
    text,
    chars: text.length,
  };
}

/**
 * When Readability gives up, take the densest run of paragraphs on the page.
 * Cheap insurance for layouts it scores poorly, and still avoids chrome.
 */
function fallbackArticle(doc) {
  const scope =
    doc.querySelector('article, main, [role="main"]') ||
    doc.body;
  if (!scope) return null;

  const blocks = [...scope.querySelectorAll('p, li, h1, h2, h3, blockquote')]
    .map((el) => normalise(el.textContent || ''))
    .filter((t) => t.length > 40);

  return { textContent: blocks.join('\n\n') };
}

function normalise(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ---------------------------------------------------------------- fetching */

async function fetchWithGuards(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'en',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new UnsupportedPageError('That page redirected nowhere useful.');
      current = await assertSafeUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) {
      throw new UnsupportedPageError(
        response.status === 403 || response.status === 401
          ? 'That site blocked us from reading the page. Try the Listen button on the page itself.'
          : `That page returned HTTP ${response.status}.`,
      );
    }

    return response;
  }

  throw new UnsupportedPageError('That page redirected too many times.');
}

/** Read at most MAX_HTML_BYTES, so one huge page cannot exhaust the function. */
async function readCapped(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_HTML_BYTES) throw new UnsupportedPageError('That page is too large to read.');

  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new UnsupportedPageError('That page is too large to read.');
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/* --------------------------------------------------------------- SSRF guard */

/**
 * The endpoint fetches a URL the caller supplies, so it must never be allowed
 * to reach the deploy's own network, loopback, or the cloud metadata service.
 */
async function assertSafeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new UnsupportedPageError('That does not look like a web address.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsupportedPageError('Only http and https addresses work here.');
  }
  if (url.username || url.password) {
    throw new UnsupportedPageError('That address is not allowed.');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UnsupportedPageError('That address is not allowed.');
  }

  const addresses = await resolveAll(host);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsupportedPageError('That address is not allowed.');
    }
  }

  return url;
}

async function resolveAll(host) {
  if (isIP(host)) return [host];
  try {
    const found = await lookup(host, { all: true, verbatim: true });
    return found.map((entry) => entry.address);
  } catch {
    throw new UnsupportedPageError('We could not find that web address.');
  }
}

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (version === 6) {
    const addr = address.toLowerCase();
    if (addr === '::1' || addr === '::') return true;
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local
    if (addr.startsWith('fe80')) return true; // link-local
    if (addr.startsWith('::ffff:')) return isPrivateAddress(addr.slice(7));
    return false;
  }
  return true;
}
