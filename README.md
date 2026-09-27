# AfriSpeech Listen

Turn any web page into audio, in the reader's own language.

Drop one script tag on your site and readers get a **Listen** button that reads
the page they are on, translated into any of 43 African languages and spoken
aloud. No build step, no framework, no SDK to install.

## Before you integrate this: the public endpoint is for testing

The deployment at `listen.example.org` synthesises
speech by opening a **Gemini Live** session with an API key that this project
pays for. That budget is shared, finite, and yours cannot be billed against it.

Use it to develop and to demonstrate the widget. Do not point production
traffic at it. A reader who presses the button on a page with real readers on it
is spending this project's quota, and when it runs out they get an error, not a
clip. The same notice is returned in the first API response, as `notice` on
`GET /languages`, so an integration reads it rather than has to know it.

For production, see [Running it yourself](#running-it-yourself) below. The short
version: call Gemini from your own backend with your own paid key.

## Add it to your page

Put this in the `<head>` of any page with article text on it:

```html
<script
  src="https://cdn.example.org/afrispeech-listen.js"
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
  src="https://cdn.example.org/afrispeech-listen.js"
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

Ours accepts any origin, so pointing the widget at it is the script tag above
and nothing else. Use it from your site, a colleague's, or your own notes.

If you run your own service, narrow it to the origins you expect:

    wrangler secret put LISTEN_ALLOWED_ORIGINS
    # comma-separated origins, or * for any

Check which situation you are in by loading your page and watching the network
tab for the `/languages` request the widget makes on load. A `200` means you are
allowed. A CORS error, or no request at all, means you are not.

That same response carries the `notice` field. If it says `testing-only`, you are
pointed at our shared budget, and the next section is the part that matters.

## Build your own player

The widget is a thin client over four endpoints. If you would rather build the
button yourself, this is the whole contract.

Base URL: `https://listen.example.org`

That is a `workers.dev` address, which is what this deployment publishes to. It
has no custom domain behind it, so there is nothing to point DNS at and nothing
to renew.

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
best models. The model is given the page in whatever language it is already
written in and asked to reduce it in the reader's own language, so there is no
translation service in the path and no pivot language to lose anything through.

```js
const { languages } = await fetch(`${BASE}/languages`).then((r) => r.json());
```

`code` is the AfriSpeech code you pass to `/speak`. `google` is the provider
code carried over from when this list was built around Google Translate. It is
still returned, and still accepted, so existing integrations keep working, but
nothing is translated with it: it is now only a second label on the language.
The service is the only authority on this list, so read it from `/languages`
rather than hardcoding it; the 43 currently returned are:

Afrikaans, Akan, Amharic, Baoulé, Bemba (Zambia), Chichewa, Dinka, Dombe,
Dyula, Ewe, Fon, Fulah, Igbo, Kinyarwanda, Kongo, Krio, Lingala,
Luo (Kenya and Tanzania), Malagasy, Ndau, Nuer, Oromo, Pedi, Rundi, Sango,
Seselwa Creole French, Shona, Somali, South Ndebele, Southern Sotho,
Standard Moroccan Tamazight, Swahili (individual language), Swati, Tigrinya,
Tiv, Tsonga, Tswana, Tumbuka, Venda, Wolof, Xhosa, Yoruba, Zulu.

One thing worth knowing: **there is one voice, and it is not a native speaker
of any of these 43 languages.** Gemini Live reads the summary in the target
language with a voice chosen for clarity, which produces the right words with
an accent a speaker of that language would not use. This is deliberate: there is
no per-language voice to select from, so the claim cannot honestly be made that
a given language has been heard pronounced correctly. Where that matters, the
route to fix it is a voice per language, not a better prompt.

## Running it yourself

This is the production path. The widget is the same either way; what changes is
who owns the Gemini key.

The service is a Node server in front of an Upstash Workflow, with Upstash Redis
for run state and the audio cache. It needs **your own paid Gemini API key**, a
Redis database and QStash credentials. Setup, the full list of configuration,
and a verified end-to-end check are in [DEPLOY.md](DEPLOY.md).

### The key stays on your server

Get a key from [Google AI Studio](https://aistudio.google.com/apikey) and enable
billing on the project. Then, roughly:

```bash
wrangler secret put LISTEN_API_KEY     # your paid Gemini key
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

MIT. See [LICENSE](LICENSE). That covers this code and the widget; it does not
grant anything against the hosted service, which stays subject to the rate
limits described in `DEPLOY.md`.
