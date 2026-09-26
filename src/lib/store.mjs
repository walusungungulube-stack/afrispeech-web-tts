/**
 * Run state and finished audio, in Redis.
 *
 * The audio lives here rather than in a public bucket so that the shared key
 * stays the only way in: a clip is not fetchable by anyone who guesses a URL.
 * Clips are tens to a few hundred kilobytes, well inside Redis limits, and
 * they expire so a busy day does not accumulate forever.
 */
import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';

const META_TTL_SECONDS = 60 * 60 * 24;        // 24 h for the status record
const AUDIO_TTL_SECONDS = 60 * 60 * 12;       // 12 h for the audio itself

/* Reusable audio. Articles get read and listened to more than once, and the
   recording is by far the most expensive step, so it is worth keeping. The
   entry is a digest of the exact inputs rather than the page address: the same
   story reached through two different links is then served from one recording,
   and an article that changes under a stable URL is not served stale audio. */
const CACHE_TTL_SECONDS = Number(process.env.LISTEN_CACHE_TTL_SECONDS || 60 * 60 * 24 * 14);

/** Bumped when the shape or the settings of a recording change. */
const CACHE_VERSION = 'v1';

const cacheKey = (digest) => `listen:cache:${CACHE_VERSION}:${digest}`;

let client = null;

/** The one client, created on first use. Also used by the slot counter, which
 *  has to reach the same database the runs are recorded in. */
export function redis() {
  if (!client) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('store: UPSTASH_REDIS_REST_URL/TOKEN are not set');
    client = new Redis({ url, token });
  }
  return client;
}

const metaKey = (runId) => `listen:run:${runId}`;
const audioKey = (runId) => `listen:audio:${runId}`;

export async function markRunning(runId, meta) {
  await redis().set(metaKey(runId), { state: 'running', ...meta }, { ex: META_TTL_SECONDS });
}

export async function markDone(runId, meta) {
  await redis().set(metaKey(runId), { state: 'done', ...meta }, { ex: META_TTL_SECONDS });
}

export async function markFailed(runId, message) {
  await redis().set(metaKey(runId), { state: 'error', error: message }, { ex: META_TTL_SECONDS });
}

export async function putAudio(runId, mp3) {
  await redis().set(audioKey(runId), mp3.toString('base64'), { ex: AUDIO_TTL_SECONDS });
}

export async function getMeta(runId) {
  return redis().get(metaKey(runId));
}

export async function getAudio(runId) {
  const encoded = await redis().get(audioKey(runId));
  return encoded ? Buffer.from(encoded, 'base64') : null;
}

/**
 * What identifies a recording: the text after limiting, the language it is
 * spoken in, and every setting that changes the resulting samples. Two requests
 * agreeing on all of this must get the same audio.
 */
export function digestFor({ text, languageCode, voice, model, kbps, sampleRate }) {
  return createHash('sha256')
    .update([
      CACHE_VERSION,
      model,
      voice,
      languageCode,
      `${kbps}kbps`,
      `${sampleRate}Hz`,
      // Collapse whitespace so a reflowed page still hits the same entry.
      String(text).replace(/\s+/g, ' ').trim(),
    ].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

/* Whether a stored recording is a recording.
 *
 * The cache outlives the code that filled it, so an entry written by a version
 * that stored the wrong bytes is still here, still valid, and still served for
 * as long as its entry lives: fourteen days of a nine-byte file that decodes to
 * noise. Anything that is not recognisably audio is treated as a miss and
 * thrown away, so a bad entry costs one recording rather than a fortnight. */
function isAudio(bytes) {
  if (!bytes || bytes.length < 64) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // ID3
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;                      // frame sync
}

export async function getCached(digest) {
  const key = cacheKey(digest);
  const entry = await redis().get(key);
  if (!entry) return null;

  const mp3 = typeof entry.mp3 === 'string' ? Buffer.from(entry.mp3, 'base64') : null;
  if (!isAudio(mp3)) {
    await redis().del(key).catch(() => {});
    return null;
  }
  return { mp3, meta: entry.meta };
}

export async function putCached(digest, mp3, meta) {
  await redis().set(
    cacheKey(digest),
    { mp3: mp3.toString('base64'), meta },
    { ex: CACHE_TTL_SECONDS },
  );
}

/** A page address mapped to the text it produced, to skip the fetch on a revisit. */
const urlKey = (digest) => `listen:url:${CACHE_VERSION}:${digest}`;

export const digestUrl = (url) =>
  createHash('sha256').update(String(url).trim().toLowerCase()).digest('hex').slice(0, 32);

export async function getUrlText(digest) {
  return redis().get(urlKey(digest));
}

export async function putUrlText(digest, text) {
  await redis().set(urlKey(digest), text, { ex: 60 * 60 * 6 });
}

/** A run id is a wfr_ token from the SDK, so keep the shape tight. */
export function isValidRunId(value) {
  return typeof value === 'string' && /^wfr_[A-Za-z0-9_-]{6,}$/.test(value);
}
