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
import { serve } from '@upstash/workflow';
import { checkAuth, corsHeaders } from './lib/auth.mjs';
import { UnsupportedPageError } from './lib/extract.mjs';
import { readSource, limitText, translateForSpeech, speak } from './lib/pipeline.mjs';
import { resolveLanguage } from './lib/languages.mjs';
import { config } from './lib/config.mjs';
import { digestFor, getCached, putCached } from './lib/store.mjs';
import { markDone, markFailed, markRunning, putAudio, getMeta, getAudio, isValidRunId } from './lib/store.mjs';

const UNSUPPORTED = 'Sorry, this webpage is not supported.';

const workflow = serve(
  async (context) => {
    const runId = context.workflowRunId;
    const body = context.requestPayload || {};

    try {
      /* Each step is one call into the pipeline, so a failure retries the work
         that actually failed rather than starting the recording again. */
      const read = await context.run('read-source', () => readSource(body));

      const clipped = await context.run('limit', async () => limitText(read.text));

      // Reuse a recording of exactly this text in exactly this language before
      // spending a model on it again.
      const cached = await context.run('check-cache', () =>
        getCached(digestFor({
          text: clipped.text,
          languageCode: resolveLanguage(body.lang, body.locale).code,
          voice: config.ttsVoice,
          model: config.ttsModel,
          kbps: config.mp3Kbps,
          sampleRate: config.mp3SampleRate,
        })));

      if (cached) {
        await context.run('store-cached', async () => {
          await putAudio(runId, cached.mp3);
          await markDone(runId, { ...cached.meta, cached: true });
        });
        return { state: 'done', runId, cached: true };
      }

      const translated = await context.run('translate', () =>
        translateForSpeech(clipped.text, body));

      const spoken = await context.run('record', () => speak(translated.text));

      await context.run('save-cache', () => putCached(digestFor({
        text: clipped.text,
        languageCode: translated.code,
        voice: config.ttsVoice,
        model: config.ttsModel,
        kbps: config.mp3Kbps,
        sampleRate: config.mp3SampleRate,
      }), spoken.mp3, {
        language: translated.name,
        languageCode: translated.code,
        chars: clipped.text.length,
        totalChars: clipped.totalChars,
        truncated: clipped.truncated,
        via: read.via,
        seconds: Number(spoken.seconds.toFixed(2)),
        bytes: spoken.mp3.length,
        pieces: spoken.pieces,
        firstByteMs: spoken.firstByteMs,
        synthMs: spoken.synthMs,
      }));

      await context.run('store', async () => {
        await putAudio(runId, spoken.mp3);
        await markDone(runId, {
          language: translated.name,
          languageCode: translated.code,
          chars: clipped.text.length,
          totalChars: clipped.totalChars,
          truncated: clipped.truncated,
          via: read.via,
          seconds: Number(spoken.seconds.toFixed(2)),
          bytes: spoken.mp3.length,
          firstByteMs: spoken.firstByteMs,
          synthMs: spoken.synthMs,
        });
      });

      return { state: 'done', runId };
    } catch (error) {
      /* Before it authorises a run, the SDK executes this function once more
         against a context that refuses every step, to find out whether the
         caller is allowed to reach one. That rehearsal is not a real attempt
         and it carries the real run id, so recording a failure here would mark
         the run broken before it had started. It is recognised by the SDK's own
         abort error and is passed straight through. */
      if (error?.name === 'WorkflowAuthError') throw error;

      const message = error instanceof UnsupportedPageError
        ? UNSUPPORTED
        : String(error.message || error);
      await markFailed(runId, message).catch(() => {});
      throw error;
    }
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
      // silently treated as "no input", so say so plainly.
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const raw = await request.clone().text();
        if (raw.trim().startsWith('[') || /^\s*(true|false|null|-?\d)/.test(raw.trim())) {
          return Response.json(
            { error: 'send a JSON object with `text` or `url`' },
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
