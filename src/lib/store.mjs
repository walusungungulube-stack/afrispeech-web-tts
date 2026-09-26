/**
 * Run state and finished audio, in Redis.
 *
 * The audio lives here rather than in a public bucket so that the shared key
 * stays the only way in: a clip is not fetchable by anyone who guesses a URL.
 * Clips are tens to a few hundred kilobytes, well inside Redis limits, and
 * they expire so a busy day does not accumulate forever.
 */
import { Redis } from '@upstash/redis';

const META_TTL_SECONDS = 60 * 60 * 24;        // 24 h for the status record
const AUDIO_TTL_SECONDS = 60 * 60 * 12;       // 12 h for the audio itself

let client = null;
function redis() {
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

/** A run id is a wfr_ token from the SDK, so keep the shape tight. */
export function isValidRunId(value) {
  return typeof value === 'string' && /^wfr_[A-Za-z0-9_-]{6,}$/.test(value);
}
