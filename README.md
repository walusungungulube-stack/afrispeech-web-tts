# AfriSpeech Listen

Turn any web page into audio, in the reader's own language.

Drop one script tag on your site and readers get a **Listen** button that reads
the page they are on, translated into any of 43 African languages and spoken
aloud. No build step, no framework, no SDK to install.

## Add it to your page

Put this in the `<head>` of any page with article text on it:

```html
<script src="https://afrispeech.org/afrispeech-listen.js" defer></script>
```

That is the whole integration. A button appears in the corner, and pressing it
reads the page.

The page is read **in the reader's browser**, not fetched by our server, so it
works on pages that block automated requests and on anything rendered by
JavaScript. Readability is only downloaded once someone actually presses the
button, so you pay nothing until a reader uses it.

### Options

All optional, set on the script tag:

```html
<script
  src="https://afrispeech.org/afrispeech-listen.js"
  data-lang="swh"
  data-position="bottom-left"
  data-label="Soma"
  defer></script>
```

| Attribute       | Default   | What it does                                              |
| --------------- | --------- | --------------------------------------------------------- |
| `data-lang`     | reader's  | Start in this language instead of asking. An AfriSpeech code, e.g. `swh`. |
| `data-position` | `bottom-right` | `bottom-right` or `bottom-left`.                       |
| `data-label`    | `Listen`  | The button text.                                           |
| `data-endpoint` | the hosted service | Point it at your own deployment instead.         |
| `data-key`      | none      | A browser key, if you run your own deployment.             |

### Before you go live

If you are pointing the widget at your own deployment, add your site's origin to
its `LISTEN_ALLOWED_ORIGINS`. Requests from anywhere else are refused. There is
more on that under [Running your own](#running-your-own).

## Build your own player

The widget is a thin client over four endpoints. If you would rather build the
button yourself, this is the whole contract.

Base URL: `https://listen.afrispeech.org`

### 1. List the languages

```http
GET /languages
```

```json
{ "languages": [ { "code": "swh", "name": "Swahili", "google": "sw", "countries": ["KE", "TZ"] } ] }
```

Free, and not behind the key, because a client needs it before it has anything
else and because guessing is worse than it sounds: an unrecognised code is not
refused, it falls back to English, so a reader who asked for one language is
quietly given another. **Fetch this rather than hardcoding codes.**

### 2. Ask for the audio

```http
POST /speak
x-listen-key: <your key>
content-type: application/json

{ "url": "https://example.com/article", "lang": "swh" }
```

Either `url` or `text`. Also accepts `locale` to match the browser's region and
`source` when you already know the input language.

The work takes a minute or two, so this does not return audio. It returns a run
to collect it from:

```json
{ "workflowRunId": "wfr_...", "finishCondition": "x-afrispeech-audio-ready" }
```

### 3. Poll for it

```http
GET /status?run=wfr_...
x-listen-key: <your key>
```

```json
{ "state": "done", "language": "Swahili", "languageCode": "swh", "chars": 998,
  "totalChars": 96384, "truncated": true, "via": "cache", "seconds": 104.4,
  "bytes": 313524, "runId": "wfr_..." }
```

`state` is `queued`, `running`, `done` or `error`. On failure:

```json
{ "state": "error", "error": "Sorry, this webpage is not supported." }
```

Poll every second or so. A long article takes a couple of minutes.

### 4. Get the audio

```http
GET /audio?run=wfr_...
x-listen-key: <your key>
```

`audio/mpeg`, 16 kHz mono. Fetch it with the header and make a blob URL:

```js
const res = await fetch(`${BASE}/audio?run=${runId}`, { headers: { 'x-listen-key': KEY } });
const url = URL.createObjectURL(await res.blob());
audio.src = url;   // do not point <audio> straight at the endpoint
```

Pointing an `<audio src>` at `/audio` directly does not work: a media element
cannot send a custom header, and the request comes back 401.

### A whole client, in twenty lines

```js
const BASE = 'https://listen.afrispeech.org';
const KEY = 'your-key';
const headers = { 'x-listen-key': KEY, 'content-type': 'application/json' };

const { workflowRunId: run } = await fetch(`${BASE}/speak`, {
  method: 'POST', headers,
  body: JSON.stringify({ url: location.href, lang: 'swh' }),
}).then((r) => r.json());

const status = await (async () => {
  for (;;) {
    const s = await fetch(`${BASE}/status?run=${run}`, { headers }).then((r) => r.json());
    if (s.state === 'done' || s.state === 'error') return s;
    await new Promise((r) => setTimeout(r, 1500));
  }
})();

if (status.state === 'error') throw new Error(status.error);

const res = await fetch(`${BASE}/audio?run=${run}`, { headers });
audio.src = URL.createObjectURL(await res.blob());
audio.play();
```

## The languages

43, chosen because they are the ones with speakers, not the ones with the
best models. All are translated through a Thai pivot, which is where the
translation quality comes from.

```js
const { languages } = await fetch(`${BASE}/languages`).then((r) => r.json());
```

`code` is the AfriSpeech code you pass to `/speak`. `google` is the underlying
Google Translate code, and is there so you can see what is underneath.

One thing worth knowing: **the voice is English.** The text is translated into
the target language, then spoken by an English voice reading it. It is clear and
correct, and it is not a native speaker of that language. This is deliberate:
native voices for 43 languages are not available in one service, and a
mispronounced word is worse than a foreign accent.

## Running your own

The service is a Cloudflare Worker plus an Upstash Workflow. It needs a Gemini
API key, an Upstash Redis, and a QStash token.

```bash
git clone https://github.com/walusungungulube-stack/afrispeech-web-tts
cd afrispeech-web-tts
cp .env.example .env    # then fill it in
npm install
npm test
npm start               # wrangler dev
```

Set `LISTEN_ALLOWED_ORIGINS` to the origins allowed to call it, comma separated.
**This is the only real access control.** A key handed to a browser is readable
by anyone who views the source; it exists to tell your traffic apart from stray
calls, not to keep anyone out. The origin allowlist is what does that.

| Variable | What it is |
| --- | --- |
| `GEMINI_API_KEY` | Gemini access, with the TTS models enabled. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Run state and the audio cache. |
| `QSTASH_REGION`, `EU_CENTRAL_1_QSTASH_URL` / `_TOKEN` | Runs the workflow off a request. |
| `UPSTASH_WORKFLOW_URL` | Where the workflow endpoint is, once deployed. |
| `LISTEN_API_KEY` | The browser key, if you use one. |
| `LISTEN_ALLOWED_ORIGINS` | Origins allowed to call this. |
| `LISTEN_MAX_CHARS` | Ceiling on how much of a page is read. |

Full list with defaults in [`.env.example`](.env.example).

## How it works

Short version, because it mostly does not concern you unless you are debugging.

A request does not wait for audio. `POST /speak` hands the job to an Upstash
Workflow and immediately returns a run id, so nothing times out behind a long
article. The client polls `/status` and collects the audio when it is ready.

Inside the run: the page is fetched and reduced to its article text, clipped to
a length cap, translated through Thai, and spoken by Gemini Live in pieces that
are joined into one MP3. Each piece is retried on failure and halved if it keeps
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
npm test           # 85 checks, no network or keys needed
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
