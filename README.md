# AfriSpeech Listen

Turn any web page into audio, in the reader's own language.

Drop one script tag on your site and readers get a **Listen** button that reads
the page they are on, translated into any of 43 African languages and spoken
aloud. No build step, no framework, no SDK to install.

## Add it to your page

Put this in the `<head>` of any page with article text on it:

```html
<script
  src="https://afrispeech.org/afrispeech-listen.js"
  data-endpoint="https://afrispeech-listen.walusungungulube.workers.dev"
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

## Build your own player

The widget is a thin client over four endpoints. If you would rather build the
button yourself, this is the whole contract.

Base URL: `https://afrispeech-listen.walusungungulube.workers.dev`

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
const BASE = 'https://afrispeech-listen.walusungungulube.workers.dev';
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
best models. All are translated through a Thai pivot, which is where the
translation quality comes from.

```js
const { languages } = await fetch(`${BASE}/languages`).then((r) => r.json());
```

`code` is the AfriSpeech code you pass to `/speak`. `google` is the underlying
Google Translate code, and is there so you can see what is underneath. The
service is the only authority on this list, so read it from `/languages` rather
than hardcoding it; the 43 currently returned are:

Afrikaans, Akan, Amharic, Baoulé, Bemba (Zambia), Chichewa, Dinka, Dombe,
Dyula, Ewe, Fon, Fulah, Igbo, Kinyarwanda, Kongo, Krio, Lingala,
Luo (Kenya and Tanzania), Malagasy, Ndau, Nuer, Oromo, Pedi, Rundi, Sango,
Seselwa Creole French, Shona, Somali, South Ndebele, Southern Sotho,
Standard Moroccan Tamazight, Swahili (individual language), Swati, Tigrinya,
Tiv, Tsonga, Tswana, Tumbuka, Venda, Wolof, Xhosa, Yoruba, Zulu.

One thing worth knowing: **the voice is English.** The text is translated into
the target language, then spoken by an English voice reading it. It is clear and
correct, and it is not a native speaker of that language. This is deliberate:
native voices for 43 languages are not available in one service, and a
mispronounced word is worse than a foreign accent.

## Running it yourself

The service is a Node server in front of an Upstash Workflow, with Upstash Redis
for run state and the audio cache. It needs a Gemini API key, a Redis database
and QStash credentials. Setup, the full list of configuration, and a verified
end-to-end check are in [DEPLOY.md](DEPLOY.md).

## Licence

MIT. See [LICENSE](LICENSE). That covers this code and the widget; it does not
grant anything against the hosted service, which stays subject to the rate
limits described in `DEPLOY.md`.
