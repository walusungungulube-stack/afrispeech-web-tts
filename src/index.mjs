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
import { checkFlood, claimBudget } from './lib/ratelimit.mjs';
import { readSource, limitText, speak, resolveLanguage } from './lib/pipeline.mjs';
import { languageCatalogue } from './lib/languages.mjs';
import { config } from './lib/config.mjs';
import { digestFor, getCached, putCached } from './lib/store.mjs';
import { markDone, markFailed, markRunning, putAudio, getMeta, getAudio, isValidRunId } from './lib/store.mjs';

const UNSUPPORTED = 'Sorry, this webpage is not supported.';

/* Shown to anyone integrating against this deployment.
 *
 * The synthesis is done by a Gemini Live session opened with a key this
 * repository pays for, and that key has a budget. It is shared, so it can be
 * exhausted by other callers, and there is no way to bill the person asking for
 * the audio. That makes this a place to develop and demonstrate the widget, not
 * something to put in front of readers who expect it to be there next minute.
 * Saying so in the first response an integrator receives is cheaper than
 * letting them find out in production. */
const USAGE_NOTICE = {
  status: 'testing-only',
  message:
    'This endpoint runs on a shared, limited Gemini Live budget owned by this project. '
    + 'It is provided for integrating and testing the Listen widget, not for production traffic.',
  production:
    'For production, call the Gemini Live API from your own backend using your own paid API key, '
    + 'and keep the paid key server-side. Never ship a Gemini API key in browser code: anyone who '
    + 'loads the page can read it and spend your quota. This project can be pointed at that '
    + 'endpoint instead, or you can run it yourself as documented in DEPLOY.md.',
};

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

/* What the reader is told, which is not what the log says.
 *
 * Every failure now comes from the one model call, so the only thing worth
 * softening is that call being busy or rate limited. An earlier version matched
 * any "HTTP 4" and reported it as a page that could not be fetched, which was
 * simply untrue: nothing here fetches a page, and a reader told to check the
 * address had no address to check. */
function describe(failure) {
  if (/quota|rate limit|RESOURCE_EXHAUSTED|\b429\b|\b503\b|UNAVAILABLE|overloaded|capacity/i.test(failure.message)) {
    return 'The speech service is busy just now. Please try again in a moment.';
  }
  if (/ETIMEDOUT|timeout|ECONNRESET|fetch failed|ENOTFOUND|ECONNREFUSED|socket|disconnect/i.test(failure.message)) {
    return 'The connection to the speech service dropped. Please try again.';
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
      summaryChars: config.summaryMaxChars,
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

    const spoken = await context.run('record', () =>
      attempt(async () => audioOut(await speak(text.text, language))));

    if (!spoken.ok) {
      const message = describe(spoken);
      await context.run('report', () => markFailed(runId, message));
      throw new WorkflowNonRetryableError(message);
    }

    const mp3 = audioIn(spoken.value.mp3);
    const audio = { ...spoken.value, mp3 };
    const meta = {
      language: language.name,
      languageCode: language.code,
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
      languageCode: language.code,
      summaryChars: config.summaryMaxChars,
      voice: config.ttsVoice,
      model: config.ttsModel,
      kbps: config.mp3Kbps,
      sampleRate: config.mp3SampleRate,
    }), mp3, meta)));

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
/** Render a refusal from either limit, the same way for both. */
function limitResponse(limit, cors) {
  return Response.json(
    { error: limit.error },
    {
      status: limit.status,
      headers: {
        ...cors,
        'retry-after': String(limit.retryAfter ?? 60),
        'x-listen-limit': limit.scope ?? '',
      },
    },
  );
}

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
        { notice: USAGE_NOTICE, languages: languageCatalogue() },
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
      /* A signed callback from the queue is passed straight through: its
         payload is the run's progress, not a request from a reader, and the
         run it belongs to was already counted when it started. */
      if (!isQueueCallback) {
        /* What is being protected is the Gemini quota, and it is spent the
           moment a run starts, so this is the only route that is limited.
           Polling and collecting cost nothing and must not be, or waiting for
           an article would count against the reader. */
        const flood = await checkFlood(request);
        if (!flood.ok) return limitResponse(flood, cors);
      }

      // A body that is not an object would be parsed as a bare string and
      // silently treated as "no input", so say so plainly.
      if (!isQueueCallback) {
        const contentType = request.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          return Response.json(
            { error: 'send JSON with `text`' },
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
            { error: 'send a JSON object with `text`' },
            { status: 400, headers: cors },
          );
        }

        // Refuse a request with nothing to read, here rather than inside the
        // run, so the reader is told straight away instead of watching a run
        // that was always going to fail.
        const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
        if (!hasText) {
          return Response.json(
            { error: 'give me something to read: `text`' },
            { status: 400, headers: cors },
          );
        }

        /* Only now is it certain a run is about to start and the Gemini quota
           is about to be spent, so only now are the daily allowance and the
           service budget charged. A caller that floods us with empty bodies
           still spends the flood guard, but cannot spend the day's money. */
        const budget = await claimBudget(request);
        if (!budget.ok) return limitResponse(budget, cors);
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
