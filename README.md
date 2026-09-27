# AfriSpeech Listen

Turn any web page into audio, in the reader's own language.

Drop one script tag on your site and readers get a **Listen** button that reads
the page they are on, translated into any of 43 African languages and spoken
aloud. No build step, no framework, no SDK to install.

## Before you integrate this: it is your endpoint, not a shared one

This repository is code to deploy, not a service to point at. Whoever runs an
instance pays for the model calls themselves, so what an instance can serve is
bounded by their plan rather than by anyone else's. `GET /languages` carries the
same statement as `notice`, so an integration reads it rather than has to know
it:

```json
{ "notice": { "status": "self-hosted", "message": "...", "production": "..." } }
```

The short version is in [Running it yourself](#running-it-yourself) below: deploy
it with your own keys, and keep the paid ones server-side.

## Add it to your page

Put this in the `<head>` of any page with article text on it:

```html
<script
  src="https://cdn.example.org/listen.js"
  data-endpoint="https://listen.example.org"
  defer></script>
```

That is the whole integration. A button appears in the corner, and pressing it
reads the page.

`data-endpoint` is where the audio comes from. There is no default: a script tag
without one gets a widget that cannot reach a service, which is a confusing
thing to hand someone, so it says so on the language list instead of failing
quietly.

The page is read **in the reader's browser**, not fetched by our server, so it
works on pages that block automated requests and on anything rendered by
JavaScript. Readability is only downloaded once someone actually presses the
button, so you pay nothing until a reader uses it.

### Options

All optional, set on the script tag:

```html
<script
  src="https://cdn.example.org/listen.js"
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
| `data-endpoint` | none, required | The synthesis service to call. There is no default. |
| `data-key`      | none      | A browser key, if you run your own deployment.             |

### Before you go live

**Which sites may use a service is that service's decision, not yours.**
`LISTEN_ALLOWED_ORIGINS` is enforced as a CORS check, and a page on an origin
that is not allowed gets no error you can read: the page loads, the button
appears, and pressing it does nothing. Worth knowing about, because it is the
one thing that can stop an integration working and it fails quietly.

If you run your own service — which is the only way to run one — narrow it to
the origins you expect:

    wrangler secret put LISTEN_ALLOWED_ORIGINS
    # comma-separated origins, or * for any

Check which situation you are in by loading your page and watching the network
tab for the `/languages` request the widget makes on load. A `200` means you are
allowed. A CORS error, or no request at all, means you are not.

That same response carries the `notice` field, and a service you did not deploy
will say so there.

## Build your own player

The widget is a thin client over four endpoints. If you would rather build the
button yourself, this is the whole contract.

Base URL: `https://listen.example.org`

Use whatever address your deployment publishes to.

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

{ "text": "Habari yako. Karibu Nairobi.", "lang": "swh" }
```

`text` is required, and is the only thing to be read. It also accepts `locale` to
match the browser's region and `source` when you already know the input language.

This service does not fetch web addresses, and never did so from a caller's
request. Read the page in the browser, send the words, and let the service
synthesise them.

The work takes a minute or two, so this does not return audio. It returns a run
to collect it from:

```json
{ "workflowRunId": "wfr_...", "finishCondition": "success" }
```

### 3. Poll for it

```http
GET /status?run=wfr_...
x-listen-key: <your key>
```

```json
{ "state": "done", "language": "Swahili", "languageCode": "swh", "chars": 863,
  "totalChars": 4719, "truncated": true, "via": "readability", "cached": false,
  "seconds": 54.56, "bytes": 163712, "firstByteMs": 570, "synthMs": 20900,
  "pieces": 7, "runId": "wfr_..." }
```

`seconds` is the length of the recording, `bytes` its size, and `pieces` how many
segments the page was spoken in. A hit on the audio cache reports the original
recording's timings and `cached: true`.

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
const BASE = 'https://listen.example.org';
const KEY = 'your-key';
const headers = { 'x-listen-key': KEY, 'content-type': 'application/json' };

const { workflowRunId: run } = await fetch(`${BASE}/speak`, {
  method: 'POST', headers,
  body: JSON.stringify({ text: articleText, lang: 'swh' }),
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
best models. The page is translated into the reader's language and then spoken
in full, so what comes back is the page rather than a summary of it.

```js
const { languages } = await fetch(`${BASE}/languages`).then((r) => r.json());
```

`code` is the AfriSpeech code you pass to `/speak`. `google` is the provider
code the translation is asked for by, carried over from when this list was
built around Google Translate. It is still returned, and still accepted, so
existing integrations keep working.
The service is the only authority on this list, so read it from `/languages`
rather than hardcoding it; the 43 currently returned are:

Afrikaans, Akan, Amharic, Baoulé, Bemba (Zambia), Chichewa, Dinka, Dombe,
Dyula, Ewe, Fon, Fulah, Igbo, Kinyarwanda, Kongo, Krio, Lingala,
Luo (Kenya and Tanzania), Malagasy, Ndau, Nuer, Oromo, Pedi, Rundi, Sango,
Seselwa Creole French, Shona, Somali, South Ndebele, Southern Sotho,
Standard Moroccan Tamazight, Swahili (individual language), Swati, Tigrinya,
Tiv, Tsonga, Tswana, Tumbuka, Venda, Wolof, Xhosa, Yoruba, Zulu.

One thing worth knowing: **there is one voice, and it is not a native speaker
of any of these 43 languages.** Whichever engine is configured reads the page in
the target language with a voice chosen for clarity, which produces the right
words with an accent a speaker of that language would not use. There is no
per-language voice to select from, so the claim cannot honestly be made that a
given language has been heard pronounced correctly. Where that matters, the
route to fix it is a voice per language, not a better prompt.

## Running it yourself

The widget is the same either way; what changes is who owns the keys.

The service is a Node server in front of an Upstash Workflow, with Upstash Redis
for run state and the audio cache. Two services do the work, and they are chosen
as a pair in the configuration:

|          | Translation                      | Speech        |
| -------- | -------------------------------- | ------------- |
| production | Google Cloud Translation API   | Gemini TTS    |
| demo     | free translate endpoint          | Gemini Live   |

The production pair is billed, quota you can see, and has no long-lived sockets
in it. The demo pair needs no account, so it is the quickest way to see this
work, and it is also the pair that was measured at 8 concurrent Live sessions
served and 16 with 11 refused for quota — the reason the production pair is the
default. Setup, the full list of configuration, and a verified end-to-end check
are in [DEPLOY.md](DEPLOY.md).

### The key stays on your server

Get a key from [Google AI Studio](https://aistudio.google.com/apikey) and enable
billing on the project. Then, roughly:

```bash
wrangler secret put GEMINI_API_KEY              # the key the models are called with
wrangler secret put GOOGLE_TRANSLATE_API_KEY    # when LISTEN_TRANSLATE_ENGINE=cloud
wrangler secret put LISTEN_API_KEY              # the shared client key the widget sends
wrangler secret put QSTASH_TOKEN
wrangler secret put UPSTASH_REDIS_REST_TOKEN
npm run deploy
```

Three rules, in the order they will bite you:

1. **Never put a Gemini key in browser code.** Anything shipped to the browser
   is readable by every visitor, and they will spend your quota. The widget only
   ever holds the shared client key; the Gemini key is a Worker secret.
2. **Set your own rate limits.** The defaults (5 per minute per address, 100 per
   day, and a daily budget) are what protect a shared key. Decide your own
   numbers for a key you are paying for.
3. **Budget alert on in AI Studio.** Turns are billed by output audio, and this
   endpoint is a public HTTP endpoint. The alert is how you find out before the
   bill does.

### Or just call Gemini yourself

If you would rather not run this service, the widget can point at anything that
answers the same three routes (`POST /speak`, `GET /status`, `GET /audio`). A
small serverless function that opens a Gemini Live session and returns the MP3
is enough. Keep the key in that function's environment, never in the page.

## Licence

MIT. See [LICENSE](LICENSE).
