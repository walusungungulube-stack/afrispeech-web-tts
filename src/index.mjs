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
import { config } from './lib/config.mjs';
import { truncateToLimit } from './lib/truncate.mjs';
import { translate } from './lib/translate.mjs';
import { extractArticle, UnsupportedPageError } from './lib/extract.mjs';
import { findSpeechLanguage, defaultForLocale } from './lib/languages.mjs';
import { liveTts } from './lib/live-tts.mjs';
import { pcmToMp3, pcmSeconds } from './lib/mp3.mjs';
import { markRunning, markDone, markFailed, putAudio, getMeta, getAudio, isValidRunId } from './lib/store.mjs';

const UNSUPPORTED = 'Sorry, this webpage is not supported.';

/** Pick a language, defaulting from the reader's locale. */
function resolveLanguage(requested, locale) {
  if (String(requested || '').toLowerCase() === 'en') {
    return { code: 'en', name: 'English', google: 'en' };
  }
  const found = findSpeechLanguage(requested);
  if (found?.tts) return found;
  const fallback = findSpeechLanguage(defaultForLocale(locale));
  if (fallback?.tts) return fallback;
  return { code: 'en', name: 'English', google: 'en' };
}

const workflow = serve(
  async (context) => {
    const { runId } = { runId: context.workflowRunId };
    const body = context.requestPayload || {};

    try {
      /* 1. Get the words. The widget sends text it already extracted; a shared
            link sends a URL for us to read. */
      const source = await context.run('read-source', async () => {
        if (typeof body.text === 'string' && body.text.trim().length >= 200) {
          return { text: body.text, title: String(body.title || ''), via: 'client' };
        }
        if (typeof body.url === 'string' && body.url.trim()) {
          try {
            const article = await extractArticle(body.url.trim());
            return { text: article.text, title: article.title, via: 'server' };
          } catch (error) {
            if (error instanceof UnsupportedPageError) return { unsupported: true };
            throw error;
          }
        }
        return { unsupported: true };
      });

      if (source.unsupported) {
        await markFailed(runId, UNSUPPORTED);
        return { state: 'error', error: UNSUPPORTED };
      }

      /* 2. Cap the length, preferring to finish on a full stop. */
      const clipped = await context.run('truncate', async () =>
        truncateToLimit(source.text, config.maxChars));

      /* 3. Always pivot through Thai. Google's direct pairings are uneven
            between the African languages, and Thai is the tested path. */
      const language = resolveLanguage(body.lang, body.locale);
      const translated = await context.run('translate', async () => ({
        text: await translate(clipped.text, language.google, body.source || 'auto'),
        name: language.name,
        code: language.code,
      }));

      /* 4. Speak it, then encode. */
      const spoken = await context.run('synthesise', async () => {
        const result = await liveTts({
          text: translated.text,
          voice: config.ttsVoice,
          model: config.ttsModel,
          timeoutMs: config.ttsTimeoutMs,
        });
        const mp3 = await pcmToMp3(result.pcm, {
          sampleRate: config.pcmSampleRate,
          kbps: config.mp3Kbps,
          outRate: config.mp3SampleRate,
        });
        return {
          bytes: mp3.length,
          seconds: pcmSeconds(result.pcm, config.pcmSampleRate),
          firstByteMs: result.firstByteMs,
          synthMs: result.totalMs,
          base64: mp3.toString('base64'),
        };
      });

      await context.run('store', async () => {
        await putAudio(runId, Buffer.from(spoken.base64, 'base64'));
        await markDone(runId, {
          seconds: Number(spoken.seconds.toFixed(2)),
          bytes: spoken.bytes,
          language: translated.name,
          languageCode: translated.code,
          chars: clipped.text.length,
          totalChars: clipped.totalChars,
          truncated: clipped.truncated,
          via: source.via,
          firstByteMs: spoken.firstByteMs,
          synthMs: spoken.synthMs,
        });
      });

      return { state: 'done', runId };
    } catch (error) {
      const message = error instanceof UnsupportedPageError ? UNSUPPORTED : String(error.message || error);
      await markFailed(runId, message).catch(() => {});
      throw error;
    }
  },
  {
    retries: 2,
  },
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
