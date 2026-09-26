# afrispeech-web-tts

Text or a link in, a spoken MP3 out. The browser starts a run and polls; the
work happens in an Upstash Workflow so nothing has to hold a connection open
while an article is recorded.

## Why it is built this way

Gemini Live synthesises at about 1x realtime, so a 90 second clip takes roughly
90 seconds to produce. A request cannot stay open for that. The recording
therefore runs as a durable workflow, and the caller polls a run id until the
clip is ready.

A whole article in a single Live turn does not work either: the socket opens,
audio starts arriving, and the connection closes before the turn reports itself
complete, losing everything after the first few seconds. So the text is split
into sentence-sized pieces and the pieces are spoken **at the same time**,
reassembled in order. Measured: 94 seconds of audio in 40 seconds of wall time.

## The three routes

    POST /speak             {"text" | "url", "lang", "locale"}
                            200 {"workflowRunId": "wfr_...", "finishCondition": "..."}

    GET  /status?run=wfr_   {"state": "running" | "done" | "error" | "unknown", ...}

    GET  /audio?run=wfr_    audio/mpeg, 16 kHz at 24 kbps

Note the trigger returns **200** and the run id is in the body as
`workflowRunId`. It is not a 202, and there is no run id response header. Signed
callbacks from the queue arrive at the same route and carry no shared key; they
are left to the workflow SDK, which signs and verifies them.

## What the pipeline does

1. **Read** — takes the text given, or extracts the article from a URL with
   Readability. Redirects and private address ranges are refused.
2. **Limit** — cuts to 1,000 characters, preferring a full sentence.
3. **Translate** — pivots through Thai, including for English input.
4. **Record** — splits into ~200 character pieces, speaks up to 4 at once under
   a global cap, and joins them in order.
5. **Store** — the MP3 in Redis, and a copy kept for reuse.

## Staying inside the model's limits

Two caps, because they solve different problems.

`LISTEN_TTS_CONCURRENCY` (4) is how many pieces one article speaks at once.

`LISTEN_MAX_LIVE_SESSIONS` (16) is how many Live sessions may be open across
**all** readers. It has to live in Redis: a workflow step is an independent
invocation with no memory of the others, so a counter in a variable would start
at zero every time and cap nothing. Slots are counted and released in one round
trip, released even when a step throws, and carry a lease so a step killed
mid-flight loses its slot for the length of the lease rather than for ever.
Readers queue for a slot rather than being refused.

Verified against the live model: four readers wanting eight sessions against a
cap of two never opened more than two sockets, and all eight pieces came back.

A piece that fails is retried up to `LISTEN_TTS_MAX_ATTEMPTS` (5) times with
growing delays. From the second attempt it is spoken as two halves instead of
being repeated, because a piece too long to finish fails identically every
time. Verified: a 1,776 character piece recovered to 12 pieces and 107 seconds
of audible audio.

## The cache

A recording is kept in Redis under a digest of the text after limiting, the
language, and every setting that changes the samples. A repeat visit is served
without recording again, and an article edited under a stable address is not
served stale audio. A page address also maps to the text it produced, so a
revisit skips the fetch as well.

## Running it

    cp .env.example .env      # fill in the keys below
    npm install
    npm test                  # 59 checks, no network and no model needed
    npm run test:semaphore    # 6 checks, needs Redis
    npm run test:e2e          # 13 checks, needs Gemini and Redis

`test:e2e` records a real article and measures it. It checks that the cap holds,
that the text is truncated on a sentence boundary, that the MP3 decodes at
16 kHz to audible signal rather than silence, that the length survives the
encode, and that the audio round trips through Redis byte for byte.

### Keys needed

| Key | Why |
| --- | --- |
| `GEMINI_API_KEY` | the model |
| `QSTASH_TOKEN` | the queue that carries the workflow |
| `QSTASH_CURRENT_SIGNING_KEY` | verifies callbacks |
| `QSTASH_NEXT_SIGNING_KEY` | the key after rotation |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | run state, audio, cache, slot counter |
| `LISTEN_API_KEY` | the shared key callers present |

`LISTEN_API_KEY` is a soft gate only: it is handed to the browser, so anyone can
read it out of the page source. The origin allowlist and the session cap are
what actually do the work.

## Layout

    src/index.mjs        the three routes and the workflow steps
    src/lib/pipeline.mjs read, limit, translate, record, store
    src/lib/live-tts.mjs the Gemini Live session and its callbacks
    src/lib/mp3.mjs      24 kbps MP3 at 16 kHz
    src/lib/semaphore.mjs the global cap
    src/lib/retry.mjs    retries, and the halving recovery
    src/lib/chunk.mjs    sentence-aware splitting
    src/lib/store.mjs    Redis: runs, audio, cache
    test/                checks, run offline unless the name says otherwise

## Not done

- The QStash transport has not been exercised end to end. The pipeline is
  verified directly, but a real queued run has not been watched through.
- The queued transport is now live and a run has been watched end to end.
  Nothing outstanding there.
