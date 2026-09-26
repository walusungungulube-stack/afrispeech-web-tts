/**
 * AfriSpeech Listen synthesis server.
 *
 * Three routes on one deployment:
 *
 *   POST /speak            start a synthesis run, answer 202 with a run id
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
import { markDone, markFailed, putAudio, getMeta, getAudio, isValidRunId } from './lib/store.mjs';

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

      const translated = await context.run('translate', () =>
        translateForSpeech(clipped.text, body));

      const spoken = await context.run('record', () => speak(translated.text));

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

    // Cheapest gate first: reject before doing any work.
    const auth = checkAuth(request);
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
        const raw = await request.text();
        if (raw.trim().startsWith('[') || /^\s*(true|false|null|-?\d)/.test(raw.trim())) {
          return Response.json(
            { error: 'send a JSON object with `text` or `url`' },
            { status: 400, headers: cors },
          );
        }
      }
      return workflowHandler(request);
    }

    return Response.json({ error: 'not found' }, { status: 404, headers: cors });
  },
};
