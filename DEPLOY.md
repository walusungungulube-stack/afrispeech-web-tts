# Deploying afrispeech-listen

How to run the synthesis service, what it needs in its environment, and how to
point the website widget at it. The service itself is described in
[README.md](README.md); this file is only about getting it running somewhere.

## What gets deployed

A single long-running Node process. `server.mjs` adapts Node's `http` server to
the `fetch` handler in `src/index.mjs`, so the code that runs is the code that is
tested.

It is deliberately **not** a Cloudflare Worker. The service reads its
configuration from `process.env`, and Workers pass configuration in as an `env`
argument to `fetch` while leaving `process.env` empty. A Worker build of this
code therefore starts up successfully and then serves every request on silent
code defaults: no Gemini key, no allowed origins, and a 503 on every call that
needs a key. If you want to revisit Workers, the configuration layer has to be
rewritten to read the `env` argument first.

## Requirements

- Node 22.9 or newer. The start script uses `--env-file-if-exists`.
- An Upstash Redis database.
- A QStash token, current signing key and next signing key, which
  `@upstash/workflow` reads from the environment itself.
- A Gemini API key with the TTS models enabled.

## Required configuration

Every one of these must be set. The service refuses to serve a request that
needs a key when the key is absent rather than failing open, so a missing value
shows up as a `503` rather than as a bill.

| Variable | Secret | What it is |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Gemini access, with the TTS models enabled. |
| `LISTEN_API_KEY` | yes | The key the widget sends as `x-listen-key`. Without it every request is refused with a 503. |
| `LISTEN_ALLOWED_ORIGINS` | no | Comma separated origins allowed to call the service, for example `https://afrispeech.com,https://www.afrispeech.com`. |
| `UPSTASH_REDIS_REST_URL` | yes | Redis REST endpoint. Run state and the audio cache live here. |
| `UPSTASH_REDIS_REST_TOKEN` | yes | Redis REST token. |
| `UPSTASH_WORKFLOW_URL` | no | The **public** URL QStash calls back on, e.g. `https://listen.example.org`. Nothing in this repo reads it; the `@upstash/workflow` SDK does, as its callback base URL. Without it the SDK derives one from the incoming request, which on a container or a box is a private address and QStash refuses to deliver. See the note at the end. |
| `QSTASH_REGION` | no | The region your QStash account is in, e.g. `eu-central-1`. The SDK looks for `<REGION>_QSTASH_URL` and `<REGION>_QSTASH_TOKEN` to match, so this selects which credentials are used. |
| `EU_CENTRAL_1_QSTASH_URL` / `_TOKEN` | yes | The QStash client for an `eu-central-1` account. The suffix follows the region: a `us-east-1` account uses `US_EAST_1_QSTASH_URL` / `_TOKEN`. |
| `QSTASH_TOKEN` | yes | Used to publish runs. |
| `QSTASH_CURRENT_SIGNING_KEY` | yes | Verifies the callbacks QStash makes into the service. |
| `QSTASH_NEXT_SIGNING_KEY` | yes | The key QStash will roll to next. |
| `PORT` | no | Defaults to `8787`. |
| `HOST` | no | Defaults to `0.0.0.0`, which is what a container needs. |

`LISTEN_ALLOWED_ORIGINS` is not optional in practice even though nothing crashes
without it. The allowlist is only enforced when it is non-empty, so leaving it
unset lets any site on the internet drive the service from a reader's browser
and spend the Gemini quota. The browser will refuse to *read* the reply, but the
synthesis is already paid for by then. The rate limits are what cap the cost.

## Optional tuning

Every one of these has a working default in `src/lib/config.mjs`. Set them only
to change the behaviour, and note that out-of-range values are clamped rather
than rejected, so a typo quietly becomes the default.

| Variable | Default | Range | What it does |
| --- | --- | --- | --- |
| `LISTEN_MAX_CHARS` | `1000` | 200 to 1000 | Ceiling on how much of a page is read. The cap cannot be raised above 1000. |
| `LISTEN_MP3_KBPS` | `24` | 8 to 128 | Bitrate of the joined audio. |
| `LISTEN_MP3_SAMPLE_RATE` | `16000` | 8000 to 24000 | Sample rate of the joined audio. |
| `LISTEN_CACHE_TTL_SECONDS` | `1209600` | | How long a finished recording is kept for reuse. 14 days. |
| `LISTEN_TTS_MODEL` | `gemini-3.1-flash-live-preview` | | The Live model that speaks. |
| `LISTEN_TTS_VOICE` | `Zephyr` | | The voice. |
| `LISTEN_TTS_TIMEOUT_MS` | `120000` | 10000 to 300000 | How long one piece may take. |
| `LISTEN_TTS_CHUNK_CHARS` | `200` | 80 to 400 | Characters per spoken piece. |
| `LISTEN_TTS_CONCURRENCY` | `4` | 1 to 8 | Pieces spoken at once. |
| `LISTEN_TTS_MAX_ATTEMPTS` | `5` | 1 to 10 | Retries for a failing piece. |
| `LISTEN_TTS_MAX_BISECT` | `2` | 0 to 4 | How many times a piece may be halved to recover it. |
| `LISTEN_TRANSLATE_ATTEMPTS` | `3` | 1 to 6 | Retries when the pivot out of Thai did not take. |
| `LISTEN_MAX_LIVE_SESSIONS` | `16` | 1 to 64 | Live sessions open across all readers. This is the real ceiling on how many readers can be served at once. |
| `LISTEN_MAX_SLOT_WAIT_MS` | `60000` | 1000 to 300000 | How long a reader waits for a session before being told the service is busy. |
| `LISTEN_RATE_ENABLED` | on | set `0` to switch off | Turns the per-address limits off. |
| `LISTEN_RATE_PER_MINUTE` | `5` | 0 to 600 | Per address, per minute. 0 switches that limit off. |
| `LISTEN_RATE_PER_DAY` | `100` | 0 to 100000 | Per address, per day. 0 switches that limit off. |
| `LISTEN_BUDGET_PER_DAY` | `5000` | 0 to 1000000 | Across everyone, per day. The per-address limits are all bypassed by rotating address; this is the one that is not. 0 removes the cap. |
| `LISTEN_HELD_BACK_LANGUAGES` | empty | | Comma separated codes to hide from the picker. |

## Deploying on an Upstash Box

1. Clone the repository onto the box and install:

   ```sh
   git clone https://github.com/walusungungulube-stack/afrispeech-web-tts
   cd afrispeech-web-tts
   npm ci
   ```

2. Put the configuration in a `.env` beside `package.json`. It is gitignored.
   `.env.example` is the starting point, but it carries the settings rather than
   every credential, so fill in the required table above as well.

3. Start it. The start script loads `.env` when the file is present:

   ```sh
   npm start
   ```

   It listens on `0.0.0.0:8787` and prints the line it started on.

4. The public URL is the box's preview URL for that port, of the form
   `https://<box-id>-<port>.preview.box.upstash.com`. Nothing in the service
   needs to know its own address: `@upstash/workflow` derives the address it
   gives QStash from the request that started the run, so there is no callback
   URL to configure after deploying.

5. Run it under a process supervisor, or as the box's start command, so it comes
   back after a restart. A box left idle is reclaimed; the service needs to be
   started again when that happens.

## Verifying a deployment

```sh
# 43 languages, no English, so an English page is never read by accident
curl -s https://<host>/languages | head -c 120

# no key is refused
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<host>/speak \
  -H 'content-type: application/json' -d '{"text":"hello"}'

# a url on its own is refused, and is not fetched
curl -s -X POST https://<host>/speak \
  -H 'content-type: application/json' -H 'x-listen-key: <key>' \
  -d '{"url":"https://example.com"}'
```

Those should answer `200`, `401` and a 400 whose body is
`give me something to read: \`text\``.

A run that passes all three still has to be watched to the end, because that is
the only thing that proves Gemini, Redis and QStash are all reachable:

```sh
curl -s -X POST https://<host>/speak \
  -H 'content-type: application/json' -H 'x-listen-key: <key>' \
  -d '{"text":"Hello.","lang":"swh","locale":"sw-KE"}'
# -> { "workflowRunId": "wfr_..." }

# poll with the key; the field is `state`, not `status`
curl -s "https://<host>/status?run=wfr_..." -H 'x-listen-key: <key>'
# -> { "state": "running", ... }  then { "state": "done", "seconds": 7.02, ... }

curl -s "https://<host>/audio?run=wfr_..." -H 'x-listen-key: <key>' -o out.mp3
file out.mp3   # -> MPEG ADTS, layer III, 24 kbps, 16 kHz, Monaural
```

## Pointing the website at it

The widget takes two values from the site build, both public:

| Website variable | Meaning |
| --- | --- |
| `PUBLIC_LISTEN_ENDPOINT` | The service URL, for example the preview URL above. |
| `PUBLIC_LISTEN_API_KEY` | The same value as `LISTEN_API_KEY` on the service. |

`PUBLIC_LISTEN_API_KEY` is not a secret. Every visitor can read it from the page
source; it is a label saying "this is widget traffic". What keeps other people's
pages from spending the quota is `LISTEN_ALLOWED_ORIGINS` on the service, plus
the rate limits.

If `PUBLIC_LISTEN_ENDPOINT` is left empty the widget falls back to
`https://listen.afrispeech.org`, so a deployment that is not published under that
name has to set it explicitly.
## Running your own

The service is a Node HTTP server (`server.mjs`) in front of an Upstash
Workflow, with Upstash Redis for run state and the audio cache. It needs a
Gemini API key, an Upstash Redis, and QStash credentials.

```bash
git clone https://github.com/walusungungulube-stack/afrispeech-web-tts
cd afrispeech-web-tts
cp .env.example .env    # then fill it in
npm install
npm test
npm start               # node server.mjs, reads .env
```

Set `LISTEN_ALLOWED_ORIGINS` to the origins allowed to call it, comma separated.

**Know what this does and does not do.** Neither the key nor the allowlist is
access control:

- The key is in your page source. Every visitor can read it. It is a label
  saying "this is widget traffic", nothing more.
- An `Origin` header is set by the browser and only the browser. `curl` sends
  none, so the allowlist is skipped, and anyone who wants to send one can.

The allowlist is worth having, because it stops other people's *pages* from
spending your quota out of a reader's browser. But what actually caps what a
caller can cost you is the rate limits:

| Setting | Default | What it caps |
| --- | --- | --- |
| `LISTEN_RATE_PER_MINUTE` | 5 | Starts per address, per minute. |
| `LISTEN_RATE_PER_DAY` | 100 | Starts per address, per day. |
| `LISTEN_BUDGET_PER_DAY` | 5000 | Starts across everyone, per day. |

Only starts are counted, so polling and collecting audio are never throttled.
The per-address limits are all bypassed by rotating address, which is why the
shared daily budget is the one that matters. All of them bound the damage; none
of them make the endpoint private. Set any to 0 to switch it off.

| Variable | What it is |
| --- | --- |
| `GEMINI_API_KEY` | Gemini access, with the TTS models enabled. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Run state and the audio cache. |
| `UPSTASH_WORKFLOW_URL` | The public URL QStash calls back on. **Required.** |
| `QSTASH_REGION`, `<REGION>_QSTASH_URL` / `_TOKEN` | QStash client for that region. |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Runs the workflow, and verifies the callback. |
| `LISTEN_API_KEY` | The browser key, if you use one. |
| `LISTEN_ALLOWED_ORIGINS` | Origins allowed to call this. |
| `LISTEN_MAX_CHARS` | Ceiling on how much of a page is read. |

Full list with defaults in [`.env.example`](.env.example).

## How it works

Short version, because it mostly does not concern you unless you are debugging.

A request does not wait for audio. `POST /speak` hands the job to an Upstash
Workflow and immediately returns a run id, so nothing times out behind a long
article. The client polls `/status` and collects the audio when it is ready.

Inside the run: the text that was sent is clipped to a length cap, translated
through Thai, and spoken by Gemini Live in pieces that are joined into one MP3. Each piece is retried on failure and halved if it keeps
failing, because a piece that is too long for the model to hold open is the
common case rather than the exceptional one.

Finished audio is cached in Redis for 14 days, keyed by the text, the language,
the voice and the model, so the same article read twice is paid for once. An
entry that is not valid audio is discarded rather than served.

Two details that matter if you are reading a log. A run that fails records the
reason in Redis and answers `state: "error"` with something a reader can act on,
because the SDK does not deliver a failure callback for a first invocation. And
a translation still in Thai is asked for again rather than recorded, since Google
reports a language it will not produce by handing back the Thai it was given,
with nothing in the response to say so.

## Development

```bash
npm test           # 100 checks, no network or keys needed
npm run test:e2e   # real Gemini, real Redis, decodes the MP3 to check it is speech
```

| | |
| --- | --- |
| `src/index.mjs` | Routes, the workflow, error handling. |
| `src/lib/translate.mjs` | Translation through the Thai pivot. |
| `src/lib/pivot.mjs` | Checks the pivot out of Thai actually happened. |
| `src/lib/live-tts.mjs` | Gemini Live session, PCM out. |
| `src/lib/store.mjs` | Redis state, audio, and the caches. |
| `test/` | One file per area, each runnable on its own. |


---

## Notes for anyone running this

The three sections above are reference: what the service is, what happens inside
a run, and where the code lives. They are here rather than in the README because
the README is for people embedding the widget.

One trap worth writing down, because it cost a deploy: **`UPSTASH_WORKFLOW_URL`
is required, and nothing in this repository's own source mentions it.** The
`@upstash/workflow` SDK reads it as the base URL it hands to QStash for the
callback. Leave it unset and the SDK falls back to deriving that URL from the
incoming request, which on a container or a box looks like an internal address.
QStash then refuses to deliver, with one of:

    endpoint resolves to a loopback address: 127.0.0.1
    endpoint resolves to a private address: 172.18.0.21

The run never starts, and `/speak` answers 500. Grepping the application source
for the variable finds nothing, because the reader is the SDK in `node_modules`.

The same applies to `QSTASH_REGION` and its `<REGION>_QSTASH_URL` /
`<REGION>_QSTASH_TOKEN` pair. The SDK resolves the client credentials from the
region name, so an account in `eu-central-1` uses `EU_CENTRAL_1_QSTASH_URL`. A
region with no matching credentials does not fail loudly; it logs

    QSTASH_REGION is set to "EU_CENTRAL_1" but credentials are missing.
    Falling back to default credentials.

on every request, and then uses the wrong account's endpoint, which surfaces
later as a signature verification failure on the callback.
