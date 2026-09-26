/**
 * AfriSpeech Listen synthesis server.
 *
 * Three routes on one deployment:
 *
 *   POST /speak            start a run, answer 200 with { workflowRunId }
 *   GET  /status?run=<id>  poll until state is done or error
 *   GET  /audio?run=<id>   the finished MP3
 *
 * The split between starting a run and collecting the audio is not ceremony:
 * Gemini Live synthesises at about 0.96x realtime, so a full-length clip takes
 * roughly as long to produce as it is long. A request cannot hold a connection
 * open for that, so the work runs as a durable workflow and the caller polls.
 *
 * Run state lives in Redis, which means the browser only ever needs the shared
 * key, never a QStash credential.
 */
import { serve, WorkflowNonRetryableError } from '@upstash/workflow';
import { checkAuth, corsHeaders } from './lib/auth.mjs';
import { UnsupportedPageError } from './lib/extract.mjs';
import { readSource, limitText, translateOutOfThai, speak, resolveLanguage } from './lib/pipeline.mjs';
import { languageCatalogue } from './lib/languages.mjs';
import { config } from './lib/config.mjs';
import { digestFor, getCached, putCached } from './lib/store.mjs';
import { markDone, markFailed, markRunning, putAudio, getMeta, getAudio, isValidRunId } from './lib/store.mjs';

const UNSUPPORTED = 'Sorry, this webpage is not supported.';

/* A step that reports its own failure, rather than throwing it.
 *
 * The SDK unwinds a run by throwing through context.run, so a try/catch around
 * a step catches that unwind rather than the work: the run is aborted where a
 * retry belonged, and the retries it is entitled to never happen. Caught inside
 * the step callback, where the work actually runs, the same error is just an
 * error again and the run carries on. */
async function attempt(work) {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    /* A step's result crosses to QStash as JSON, where an Error is just an
       empty object. Whatever the reader is told has to be decided here, while
       the error still has its name and message. */
    return {
      ok: false,
      name: (error && error.name) || 'Error',
      message: String((error && error.message) || error || '').slice(0, 300),
    };
  }
}

/* What the reader is told, which is not what the log says. A page that cannot
   be read is worth saying plainly, and a page that could not be fetched should
   not read as though the reader had asked for something impossible. */
function describe(failure) {
  if (failure.name === 'UnsupportedPageError') return UNSUPPORTED;
  if (/came back in Thai/.test(failure.message)) {
    return 'This article could not be translated into the language you chose. Please try again.';
  }
  if (/translate: HTTP 5|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|timeout/i.test(failure.message)) {
    return 'The translation service is not answering properly just now. Please try again.';
  }
  if (/HTTP 4|not found|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(failure.message)) {
    return 'That page could not be fetched. Check the address and try again.';
  }
  return failure.message || 'Something went wrong.';
}

/* Audio is the one thing a step cannot carry.
 *
 * A step's result crosses to the queue as JSON and comes back parsed, and JSON
 * has no bytes: a Buffer arrives as { type: 'Buffer', data: [...] }. Writing
 * that to the store encodes the string "[object Object]", which is nine bytes
 * that decode to noise and are served back as if they were a recording. Text
 * crosses intact, so audio leaves a step as base64 and is turned back into
 * bytes on arrival. */
export function audioOut(result) {
  const mp3 = result && result.mp3;
  return {
    ...result,
    mp3: Buffer.isBuffer(mp3) ? mp3.toString('base64') : mp3,
  };
}

export function audioIn(mp3) {
  if (Buffer.isBuffer(mp3)) return mp3;
  if (typeof mp3 === 'string') return Buffer.from(mp3, 'base64');
  if (mp3 && Array.isArray(mp3.data)) return Buffer.from(mp3.data);
  throw new TypeError('a recording came back from a step as something other than audio');
}

const workflow = serve(
  async (context) => {
    const runId = context.workflowRunId;
    const body = context.requestPayload || {};

    /* Each step is one call into the pipeline, so a failure retries the work
       that actually failed rather than starting the recording again. */
    const read = await context.run('read-source', () => attempt(() => readSource(body)));

    if (!read.ok) {
      const message = describe(read);
      await context.run('report', () => markFailed(runId, message));
      throw new WorkflowNonRetryableError(message);
    }

    const source = read.value;
    const clipped = await context.run('limit', () => attempt(() => limitText(source.text)));

    if (!clipped.ok) {
      const message = describe(clipped);
      await context.run('report', () => markFailed(runId, message));
      throw new WorkflowNonRetryableError(message);
    }

    const text = clipped.value;

    // Reuse a recording of exactly this text in exactly this language before
    // spending a model on it again.
    const language = resolveLanguage(body.lang, body.locale);
    const cached = await context.run('check-cache', () => attempt(() => getCached(digestFor({
      text: text.text,
      languageCode: language.code,
      voice: config.ttsVoice,
      model: config.ttsModel,
      kbps: config.mp3Kbps,
      sampleRate: config.mp3SampleRate,
    }))));

    if (cached.ok && cached.value) {
      const hit = cached.value;
      await context.run('store-cached', () => attempt(async () => {
        await putAudio(runId, audioIn(hit.mp3));
        await markDone(runId, { ...hit.meta, cached: true });
      }));
      return { state: 'done', runId, cached: true };
    }

    const translated = await context.run('translate', () =>
      attempt(() => translateOutOfThai(text.text, body, config.translateAttempts)));

    if (!translated.ok) {
      const message = describe(translated);
      await context.run('report', () => markFailed(runId, message));
      throw new WorkflowNonRetryableError(message);
    }

    const spoken = await context.run('record', () =>
      attempt(async () => audioOut(await speak(translated.value.text))));

    if (!spoken.ok) {
      const message = describe(spoken);
      await context.run('report', () => markFailed(runId, message));
      throw new WorkflowNonRetryableError(message);
    }

    const mp3 = audioIn(spoken.value.mp3);
    const audio = { ...spoken.value, mp3 };
    const meta = {
      language: translated.value.name,
      languageCode: translated.value.code,
      chars: text.text.length,
      totalChars: text.totalChars,
      truncated: text.truncated,
      via: source.via,
      seconds: Number(audio.seconds.toFixed(2)),
      bytes: mp3.length,
      firstByteMs: audio.firstByteMs,
      synthMs: audio.synthMs,
    };

    await context.run('save-cache', () => attempt(() => putCached(digestFor({
      text: text.text,
      languageCode: translated.value.code,
      voice: config.ttsVoice,
      model: config.ttsModel,
      kbps: config.mp3Kbps,
      sampleRate: config.mp3SampleRate,
    }), mp3, { ...meta, pieces: audio.pieces })));

    await context.run('store', () => attempt(async () => {
      await putAudio(runId, mp3);
      await markDone(runId, meta);
    }));

    return { state: 'done', runId };
  },
  { retries: 2 },
);

const { handler: workflowHandler } = workflow;

/** Wrap the workflow so the plain routes never start a run. */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    /* The list of languages, so a client never has to guess a code. Guessing is
       worse than it sounds: an unrecognised code is not refused, it falls back
       to English, so a reader who asked for one language is quietly given
       another. It is the one answer here that costs nothing to give away, and a
       client needs it before it has anything else, so it is not behind the key.
       The origin allowlist still applies. */
    if (url.pathname === '/languages' && request.method === 'GET') {
      return Response.json(
        { languages: languageCatalogue() },
        { headers: { ...cors, 'cache-control': 'public, max-age=3600' } },
      );
    }

    /* A signed callback from the queue carries no shared key: it is the queue
       re-entering the handler for the next step, signed and verified by the
       workflow SDK. Holding it to the browser's key would fail every step after
       the first. Everything else still has to present the key. */
    const isQueueCallback = request.headers.get('upstash-signature') !== null;

    // Cheapest gate first: reject before doing any work.
    const auth = isQueueCallback ? { ok: true } : checkAuth(request);
    if (!auth.ok) {
      return Response.json({ error: auth.error }, { status: auth.status, headers: cors });
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      const run = url.searchParams.get('run');
      if (!isValidRunId(run)) {
        return Response.json({ error: 'bad run id' }, { status: 400, headers: cors });
      }
      const meta = await getMeta(run);
      if (!meta) return Response.json({ state: 'unknown' }, { headers: cors });
      return Response.json(meta, { headers: cors });
    }

    if (url.pathname === '/audio' && request.method === 'GET') {
      const run = url.searchParams.get('run');
      if (!isValidRunId(run)) {
        return Response.json({ error: 'bad run id' }, { status: 400, headers: cors });
      }
      const mp3 = await getAudio(run);
      if (!mp3) return Response.json({ error: 'not ready' }, { status: 404, headers: cors });
      return new Response(mp3, {
        headers: {
          ...cors,
          'content-type': 'audio/mpeg',
          'content-length': String(mp3.length),
          'cache-control': 'private, max-age=3600',
        },
      });
    }

    if (url.pathname === '/speak' && request.method === 'POST') {
      // A body that is not an object would be parsed as a bare string and
      // silently treated as "no input", so say so plainly. A signed callback
      // from the queue is passed straight through: its payload is the run's
      // progress, not a request from a reader.
      if (!isQueueCallback) {
        const contentType = request.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          return Response.json(
            { error: 'send JSON with `text` or `url`' },
            { status: 415, headers: cors },
          );
        }

        const raw = await request.clone().text();
        if (raw.length > 20_000) {
          return Response.json({ error: 'body too large' }, { status: 413, headers: cors });
        }

        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400, headers: cors });
        }

        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return Response.json(
            { error: 'send a JSON object with `text` or `url`' },
            { status: 400, headers: cors },
          );
        }

        // Refuse a request with nothing to read, here rather than inside the
        // run, so the reader is told straight away instead of watching a run
        // that was always going to fail.
        const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
        const hasUrl = typeof body.url === 'string' && body.url.trim().length > 0;
        if (!hasText && !hasUrl) {
          return Response.json(
            { error: 'give me something to read: `text` or `url`' },
            { status: 400, headers: cors },
          );
        }
      }

      const response = await workflowHandler(request);

      if (!isQueueCallback) {
        /* The SDK answers the triggering call with 200 and
           { workflowRunId, finishCondition }. Read a copy: the body belongs to
           the caller, and reading it here would leave them an empty one. */
        const started = await response.clone().json().catch(() => null);
        const runId = started && started.workflowRunId;
        if (runId) await markRunning(runId).catch(() => {});
      }

      return response;
    }

    return Response.json({ error: 'not found' }, { status: 404, headers: cors });
  },
};
