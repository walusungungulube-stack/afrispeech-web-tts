/**
 * Run state and finished audio, in memory.
 */
import { createHash } from 'node:crypto';

const META_TTL_MS = 60 * 60 * 24 * 1000;
const AUDIO_TTL_MS = 60 * 60 * 12 * 1000;
const CACHE_TTL_MS = Number(process.env.LISTEN_CACHE_TTL_SECONDS || 60 * 60 * 24 * 14) * 1000;

const CACHE_VERSION = 'v2';

const metaStore = new Map();
const audioStore = new Map();
const cacheStore = new Map();

let cleanupTimer = null;
function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of metaStore) { if (now > v.expires) metaStore.delete(k); }
    for (const [k, v] of audioStore) { if (now > v.expires) audioStore.delete(k); }
    for (const [k, v] of cacheStore) { if (now > v.expires) cacheStore.delete(k); }
    cleanupTimer = null;
  }, 60 * 1000);
  if (cleanupTimer && cleanupTimer.unref) cleanupTimer.unref();
}
export function digestFor({ text, languageCode, translateEngine, speechEngine, voice, model, kbps, sampleRate }) {
  return createHash('sha256')
    .update([CACHE_VERSION, model, voice, languageCode, `${translateEngine}+${speechEngine}`, `${kbps}kbps`, `${sampleRate}Hz`, String(text).replace(/\\s+/g, ' ').trim()].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

function isAudio(bytes) {
  if (!bytes || bytes.length < 64) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

export function isValidRunId(value) {
  return typeof value === 'string' && /^wfr_[A-Za-z0-9_-]{6,}$/.test(value);
}

export async function markRunning(runId, meta = {}) { metaStore.set(runId, { state: 'running', ...meta, expires: Date.now() + META_TTL_MS }); }
export async function markDone(runId, meta = {}) { metaStore.set(runId, { state: 'done', ...meta, expires: Date.now() + META_TTL_MS }); }
export async function markFailed(runId, message) { metaStore.set(runId, { state: 'error', error: message, expires: Date.now() + META_TTL_MS }); }
export async function putAudio(runId, mp3) { audioStore.set(runId, { buffer: mp3, expires: Date.now() + AUDIO_TTL_MS }); }
export async function getMeta(runId) { const e = metaStore.get(runId); if (!e || Date.now() > e.expires) return null; return e; }
export async function getAudio(runId) { const e = audioStore.get(runId); if (!e || Date.now() > e.expires) return null; return e.buffer; }
export async function getCached(digest) { const e = cacheStore.get(digest); if (!e || Date.now() > e.expires) return null; const mp3 = typeof e.mp3 === 'string' ? Buffer.from(e.mp3, 'base64') : e.mp3; if (!isAudio(mp3)) { cacheStore.delete(digest); return null; } return { mp3, meta: e.meta }; }
export async function putCached(digest, mp3, meta) { cacheStore.set(digest, { mp3: Buffer.isBuffer(mp3) ? mp3.toString('base64') : mp3, meta, expires: Date.now() + CACHE_TTL_MS }); }
export function pauseCleanup() { if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; } }
