# Deploying afrispeech-listen

How to run the synthesis service, what it needs in its environment, and how to
point the website widget at it. The service itself is described in
[README.md](README.md); this file is only about getting it running somewhere.

## Whose Gemini key is it

**This is a `LISTEN_API_KEY` you supply, on your own billing.** The key is the
only real cost in this service, and it is the one thing you cannot share.

The shared deployment at `afrispeech-listen.walusungungulube.workers.dev` uses
this project's key and returns a `notice` on `GET /languages` saying so. It is
there for integrating and demonstrating the widget. It is a public HTTP
endpoint in front of a metered API, and there is no way to bill the person
pressing the button, so it is not a production dependency for anyone.

If you are deploying for real, the difference is entirely in these:

- `LISTEN_API_KEY` is a key you created, with billing enabled, and you accept
  the cost per turn.
- It is a Worker secret, never a variable in `wrangler.jsonc` and never anything
  in browser code. Anything shipped to the browser is readable by every visitor.
- `LISTEN_RATE_*` and `LISTEN_BUDGET_PER_DAY` are set to limits you chose. The
  defaults protect someone else's key; yours needs its own.
- Turn on a budget alert in AI Studio. This service is reachable by the public
  and you are billed by output audio, so the alert is how you find out before
  the invoice does.

Set `LISTEN_MAX_LIVE_SESSIONS` with the same thought. The default of 300 is a
queue length, not a figure anyone has measured: what your key sustains is a
property of the key. See "What `LISTEN_MAX_LIVE_SESSIONS` counts" below.

## What gets deployed

One Cloudflare Worker, published to a `workers.dev` address. `src/worker.mjs` is
the entry point; it hands the precompiled MP3 encoder to `src/lib/mp3.mjs` and
re-exports the shared `fetch` handler in `src/index.mjs`, so the routes are the
same code whichever runtime serves them.

The same service still runs on Node through `server.mjs`, which adapts Node's
`http` server to that same handler. That is how the test suite runs and how you
work on it locally; it is not what is deployed.

**Earlier versions of this file ruled Workers out**, on the grounds that
workerd leaves `process.env` empty and that configuration therefore has to arrive
as the `env` argument to `fetch`. That is wrong. Under the `nodejs_compat` flag
workerd populates `process.env` from vars and secrets, at module scope, which is
where `src/lib/config.mjs` reads it. The configuration layer was never the
problem and was never rewritten.

What did have to change is the encoder. See
[Deploying on Cloudflare Workers](#deploying-on-cloudflare-workers) for the
`CompiledWasm` rule and the staging step, because that is the part that is
specific to Workers and the part that will bite anyone who skips it.

## Requirements

- A Cloudflare account, to deploy the Worker. Node 22.9 or newer is also needed
  locally: the test suite and `server.mjs` run on it, and the start script uses
  `--env-file-if-exists`.
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
| `UPSTASH_WORKFLOW_URL` | no | The **public** URL QStash calls back on. Required on a Box or container, unnecessary on Workers, where the request URL is already public. See the note at the end. Nothing in this repo reads it; the `@upstash/workflow` SDK does, as its callback base URL. Without it the SDK derives one from the incoming request, which on a container or a box is a private address and QStash refuses to deliver. See the note at the end. |
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
| `LISTEN_MAX_CHARS` | `3000` | 200 to 3000 | Ceiling on how much of a page is sent to the model. The cap cannot be raised above 3000. |
| `LISTEN_SUMMARY_MAX_CHARS` | `500` | 100 to 500 | Ceiling on how much is spoken, counted in characters of the reader's language. The model is told this number and asked to fit the summary inside it; it is not trimmed afterwards, because only audio comes back. Cannot be raised above 500. |
| `LISTEN_MP3_KBPS` | `24` | 8 to 128 | Bitrate of the joined audio. |
| `LISTEN_MP3_SAMPLE_RATE` | `16000` | 8000 to 24000 | Sample rate of the joined audio. |
| `LISTEN_CACHE_TTL_SECONDS` | `1209600` | | How long a finished recording is kept for reuse. 14 days. |
| `LISTEN_TTS_MODEL` | `gemini-3.1-flash-live-preview` | | The Live model that speaks. |
| `LISTEN_TTS_VOICE` | `Zephyr` | | The voice. |
| `LISTEN_TTS_TIMEOUT_MS` | `120000` | 10000 to 300000 | How long one turn may take. |
| `LISTEN_TTS_MAX_ATTEMPTS` | `5` | 1 to 10 | Retries for a failing turn. |
| `LISTEN_MAX_LIVE_SESSIONS` | `300` | 1 to 512 | Live sessions open across all readers. This is the real ceiling on how many readers can be served at the same instant; readers past it wait in a queue rather than being refused. |
| `LISTEN_MAX_SLOT_WAIT_MS` | `60000` | 1000 to 300000 | How long a reader waits for a session before being told the service is busy. |
| `LISTEN_RATE_ENABLED` | on | set `0` to switch off | Turns the per-address limits off. |
| `LISTEN_RATE_PER_MINUTE` | `5` | 0 to 600 | Per address, per minute. 0 switches that limit off. |
| `LISTEN_RATE_PER_DAY` | `100` | 0 to 100000 | Per address, per day. 0 switches that limit off. |
| `LISTEN_BUDGET_PER_DAY` | `5000` | 0 to 1000000 | Across everyone, per day. The per-address limits are all bypassed by rotating address; this is the one that is not. 0 removes the cap. |
| `LISTEN_HELD_BACK_LANGUAGES` | empty | | Comma separated codes to hide from the picker. |

## Deploying on Cloudflare Workers

This is how the service is deployed. The address it answers on is a
`workers.dev` URL, so there is no domain to buy, no DNS to point and nothing to
renew.

### The API token

A scoped API token, not the Global API Key. Cloudflare's **Edit Cloudflare
Workers** template is exactly the right set: **Account / Workers Scripts / Edit**,
**Account / Account Settings / Read**, and **User / User Details / Read**, with
Account Resources scoped to your account. You do not need Zone permissions; those
are only for attaching a custom domain, which this does not do.

Give it to wrangler as `CLOUDFLARE_API_TOKEN`. It is a credential, so treat it
as spent once it has been through a shell history or a transcript.

### One manual step: the workers.dev subdomain

The first deployment fails with *"You need to register a workers.dev subdomain"*
until the account has one. Create it in the dashboard: **Workers & Pages** in the
sidebar, then accept the prompt on first visit, or set it under **Settings /
Domains & Routes**.

This one cannot be scripted with an API token. `POST
/accounts/{id}/workers/subdomain` answers `Method not allowed for this
authentication scheme`; Cloudflare allows only the Global API Key or a browser
session there. It is a single click, and it is once per account.

### Deploying

```sh
git clone https://github.com/walusungungulube-stack/afrispeech-web-tts
cd afrispeech-web-tts
git checkout read-the-words-not-the-address
npm install
npm run deploy
```

Secrets go in as secrets, never into `wrangler.jsonc`:

```sh
printf '%s' "$GEMINI_API_KEY"   | npx wrangler secret put GEMINI_API_KEY
printf '%s' "$LISTEN_API_KEY"    | npx wrangler secret put LISTEN_API_KEY
printf '%s' "$UPSTASH_REDIS_REST_TOKEN" | npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
printf '%s' "$QSTASH_TOKEN"      | npx wrangler secret put QSTASH_TOKEN
printf '%s' "$QSTASH_CURRENT_SIGNING_KEY" | npx wrangler secret put QSTASH_CURRENT_SIGNING_KEY
printf '%s' "$QSTASH_NEXT_SIGNING_KEY"     | npx wrangler secret put QSTASH_NEXT_SIGNING_KEY
```

Use `printf`, not `echo`. `echo` appends a newline, and a secret set that way
comes back as `"eu-central-1\n"`, which does not match anything. That cost a
deploy here too, in a place where it looked like an origin problem.

`LISTEN_ALLOWED_ORIGINS` is also a secret, deliberately. It differs per
deployment, and the values a given deployment uses are internal hostnames that
have no business in a public repository.

**The public deployment sets it to `*`.** That is a deliberate choice, and the
reasoning is worth keeping, because the allowlist looks like the thing
protecting the quota and it is not.

The allowlist is a browser check, and it only binds browsers. A request with no
`Origin` header is not a browser request and skips it entirely, which is why
this is the wrong thing to point a security argument at. What actually bounds
spend is in `ratelimit.mjs`:

| Limit | This deployment | Scope |
| --- | --- | --- |
| `LISTEN_RATE_PER_MINUTE` | 5 | per client IP |
| `LISTEN_RATE_PER_DAY` | 100 | per client IP |
| `LISTEN_MAX_LIVE_SESSIONS` | 300 | everyone, concurrently, then a queue |

The per-client IP comes from `cf-connecting-ip`, which on Workers is set by
Cloudflare and cannot be forged by the caller.

`LISTEN_BUDGET_PER_DAY`, which capped the whole service at 5000 runs a day, is
**off** here, set to 0. That was a deliberate choice, and it is the one place
this configuration is weaker than the code's defaults, so it is worth stating
plainly rather than discovering later:

- the two per-address limits are bypassed by rotating address, which the budget
  was not;
- so there is now no ceiling on total daily spend. What remains is
  `LISTEN_MAX_LIVE_SESSIONS`, 16, which bounds how fast the quota can be drained
  but not how much of it can be spent over a day. It is worth being precise
  about what that counts, because it is not what the name suggests: a *slot* is
  one utterance being spoken, not one reader. See the note below.

A deployment that is not public should set it, and a public one should decide
knowing that the daily ceiling is the only limit that cannot be rotated past.
The code is unchanged and the switch is still there; only the value is 0.

### What `LISTEN_MAX_LIVE_SESSIONS` counts

A slot is **one turn being spoken**, and one turn is one reader. The model is
given the whole page at once and reduces it before speaking, so a reader holds
exactly one slot for the length of a single turn however long the page was. The
number of readers served at the same instant is therefore the slot count, which
is set to 300.

That number is deliberately high, and it should be read as a **queue length,
not a measurement**. The real ceiling is how many concurrent Live sessions the
key behind `LISTEN_API_KEY` will hold, which is a property of the key rather
than of this configuration. Setting a low cap would hide that ceiling until
traffic arrived; setting a high one turns the ceiling into the error you get
instead, which is the more useful failure:

| | |
| --- | --- |
| Readers arriving together, 300 or fewer | All served at once, one slot each |
| More than 300 | The surplus waits, jittered, for up to `LISTEN_MAX_SLOT_WAIT_MS` |
| Still waiting after that | 503, `BUSY`: "The service is busy. Please try again in a moment." |

A turn runs about 25 to 35 seconds for a full page, so the 60-second default
wait covers roughly two of them. Raise `LISTEN_MAX_SLOT_WAIT_MS` if you would
rather a reader wait longer than be turned away, at the cost of them sitting on
a connection while they wait.

To find the real ceiling for your own key, raise `LISTEN_MAX_LIVE_SESSIONS`
above what you believe it can take and watch for `BUSY` or upstream errors. That
is the honest way to measure it; the number above is a starting point, not a
figure anyone has verified.

Two other things are true of it and are easy to miss:

- **The counter is in Redis, not in memory.** `listen:sem:live` is a Lua
  compare-and-increment with a 120-second lease. It has to be: Workers run many
  isolates at once, so an in-process counter would count each isolate's own
  sessions separately and cap nothing globally. A lease rather than a plain
  counter is what stops a step the platform cuts short from leaking a slot, and
  the release runs in a `finally` for the same reason.
- **Waiting is the design, not refusal.** A reader who has been told their
  article is being read is not told no; the request queues for up to
  `LISTEN_MAX_SLOT_WAIT_MS` (60s) and only then gets a 503.

**Nothing about this number comes from memory.** There is no memory or heap
calculation anywhere in `semaphore.mjs` or the config, and 16 is a value someone
chose. What it should be sized against is how many Live TTS sessions Gemini will
hold open at once for one API key, since each slot is a WebSocket held open for
the length of an utterance. Raise it past what the upstream allows and runs
start failing at the point of synthesis, which is a worse failure than waiting
because the reader has already been told it is working.

An allowlist you control is also how you find out who is using the service, and
`*` gives that up. If per-site attribution is ever wanted, the way back is a key
per site rather than an origin per site.

### The encoder, and why there is a staging script

workerd will not compile a WebAssembly binary at runtime. It refuses
`WebAssembly.instantiate` and `WebAssembly.compile` for *any* input, down to an
empty ten-byte module, with `Wasm code generation disallowed by embedder`. So the
MP3 encoder cannot be built the way `wasm-media-encoders` builds it, from a
base64 data URI compiled on the spot. Every run failed at that step, holding
Gemini's audio and unable to encode it.

The way through is to have the module compiled during the build, which arrives as
an already-built `WebAssembly.Module` that `WebAssembly.instantiate` accepts as
readily as bytes. Two things are needed for that and both are easy to get wrong:

- `src/lib/mp3.wasm`, which `src/worker.mjs` imports. It is **staged** from the
  installed dependency by `scripts/stage-wasm.mjs`, which `npm run deploy` and
  `npm run dev:worker` both run first. Nothing binary is committed, so the
  lockfile stays the only thing that decides which encoder ships.
- A `CompiledWasm` rule in `wrangler.jsonc`, or the bundler reports
  `No loader is configured for ".wasm" files`.

The rule does not reach inside `node_modules`, which is why the file is copied
into `src/lib` and imported by relative path rather than imported by package
name. Importing `wasm-media-encoders/wasm/mp3` directly fails to bundle however
the glob is written. The other documented route, a `wasm_modules` binding, is
refused outright for a module-based Worker: *Wasm bindings are not allowed in
modules-based scripts*.

Node is unaffected. It is free to compile the encoder at runtime, so `pcmToMp3`
falls back to the bundled copy when it has not been handed a module, and the
suite passes without any of the above.

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

`PUBLIC_LISTEN_ENDPOINT` is required, and there is deliberately no fallback baked
into the widget. A build with a page that enables the widget and no endpoint
fails, rather than shipping a button that cannot work:

    PUBLIC_LISTEN_ENDPOINT is not set, but this page enables the Listen widget
    (/about/). Set it to the URL of the synthesis service, or pass
    listen={false} to opt this page out.
## Running your own

The service is a Worker in front of an Upstash Workflow, with Upstash Redis for
run state and the audio cache. It needs a Gemini API key, an Upstash Redis, and
QStash credentials. On Node it is the same handler behind `server.mjs`.

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
| `UPSTASH_WORKFLOW_URL` | The public URL QStash calls back on. **Required on a Box or container, not on Workers.** |
| `QSTASH_REGION`, `<REGION>_QSTASH_URL` / `_TOKEN` | QStash client for that region. |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Runs the workflow, and verifies the callback. |
| `LISTEN_API_KEY` | The browser key, if you use one. |
| `LISTEN_ALLOWED_ORIGINS` | Origins allowed to call this. |
| `LISTEN_MAX_CHARS` | Ceiling on how much of a page is sent to the model. |
| `LISTEN_SUMMARY_MAX_CHARS` | Ceiling on how much is spoken. Part of the cache key. |

Full list with defaults in [`.env.example`](.env.example).

## How it works

Short version, because it mostly does not concern you unless you are debugging.

A request does not wait for audio. `POST /speak` hands the job to an Upstash
Workflow and immediately returns a run id, so nothing times out behind a long
article. The client polls `/status` and collects the audio when it is ready.

Inside the run: the text that was sent is clipped to `LISTEN_MAX_CHARS`, then
handed to **one** Gemini Live turn, in the language it was already written in.
The model is told the reader's target language and the `LISTEN_SUMMARY_MAX_CHARS`
budget, and asked to reduce the page to a summary within that budget and speak
only that. The result is one PCM stream, encoded to a single MP3. There is no
translation service in the path and no second call to coordinate.

A failing turn is retried up to `LISTEN_TTS_MAX_ATTEMPTS` times. It is not
halved on failure: two halves would be two summaries and so twice the character
budget, and the page no longer arrives as one piece of text to be summarised.

The 500-character budget is an instruction to the model, not a trim afterwards.
Only audio comes back, so there is nothing to measure the result against and
nothing to cut. The page itself *is* capped, and that cap is enforced. If the
budget has to be a guarantee rather than a request, that needs a transcript to
check the length against, which is a different design.

Finished audio is cached in Redis for 14 days, keyed by the text, the language,
the summary budget, the voice and the model, so the same article read twice is
paid for once, and a changed budget is a different recording rather than a stale
hit. An entry that is not valid audio is discarded rather than served.

A run that fails records the reason in Redis and answers `state: "error"` with
something a reader can act on, because the SDK does not deliver a failure
callback for a first invocation. Upstream failures are reported as what they
are: a busy Gemini or a dropped connection is not reported as an unreadable
page, which is what a reader would then go and check.

## Development

```bash
npm test           # the unit suite, no network or keys needed
npm run test:e2e   # real Gemini, real Redis, decodes the MP3 to check it is speech
```

| | |
| --- | --- |
| `src/index.mjs` | Routes, the workflow, the usage notice, error handling. |
| `src/lib/live-tts.mjs` | The one Gemini Live turn: prompt, voice, PCM out. |
| `src/lib/pipeline.mjs` | Read, cap, resolve language, speak, encode, cache. |
| `src/lib/store.mjs` | Redis state, audio, and the caches. |
| `test/` | One file per area, each runnable on its own. |


---

## Notes for anyone running this

The three sections above are reference: what the service is, what happens inside
a run, and where the code lives. They are here rather than in the README because
the README is for people embedding the widget.

One trap worth writing down, because it cost a deploy: **`UPSTASH_WORKFLOW_URL`
is required on a Box, and nothing in this repository's own source mentions it.**
On Workers it is not needed at all, because the request URL QStash calls back is
already the public one. The
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
