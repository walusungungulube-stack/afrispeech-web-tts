/**
 * The route module itself, loaded and exercised.
 *
 * Every other check imports the pipeline directly, so a mistake in the file
 * that wires the routes to the pipeline would pass all of them. A wrong import
 * name in index.mjs is exactly that: nothing failed until the server was
 * started.
 *
 * Run with: node test/routes.mjs
 */
import assert from 'node:assert/strict';

process.env.LISTEN_API_KEY ||= 'test-key-for-routes';
/* The limiter keeps counters in Redis, and these checks are about routing and
   validation with no Redis anywhere. It has its own checks, in
   test/ratelimit.mjs, against a stub. */
process.env.LISTEN_RATE_ENABLED = '0';

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
};

// Loading is the point: this fails on a bad import before anything is called.
const { default: worker } = await import('../src/index.mjs');

const call = (path, init = {}) => worker.fetch(new Request(`https://example.test${path}`, {
  ...init,
  headers: { 'x-listen-key': 'test-key-for-routes', ...(init.headers || {}) },
}));

await check('the module loads and exposes a fetch handler', () => {
  assert.equal(typeof worker.fetch, 'function');
});

await check('a request without the key is refused', async () => {
  const response = await worker.fetch(new Request('https://example.test/status?run=wfr_abc123'));
  assert.equal(response.status, 401);
});

await check('the language list is offered, so no client has to guess a code', async () => {
  const r = await call('/languages');
  assert.equal(r.status, 200);
  // Offered without a key, because a client needs it before it has anything
  // else, and it is the one answer here that costs nothing to give away.
  const open = await worker.fetch(new Request('https://example.test/languages'));
  assert.equal(open.status, 200);
  const { languages } = await r.json();
  assert.ok(languages.length >= 40, 'every language is offered');
  const swahili = languages.find((l) => l.code === 'swh');
  assert.ok(swahili, 'Swahili is reachable by a code that exists');
  assert.equal(swahili.google, 'sw');
  // Guessing a code is the failure this route exists to prevent: an
  // unrecognised one is not refused, it falls back to English. Every code handed
  // out here has to therefore be one that comes back as itself.
  const { resolveLanguage } = await import('../src/lib/pipeline.mjs');
  for (const l of languages) {
    assert.equal(resolveLanguage(l.code).code, l.code, `${l.code} resolves to itself`);
  }
});

await check('audio survives the trip through a step, which is where it used to die', async () => {
  // What the queue does to a Buffer on the way through: parsed JSON, no bytes.
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01, 0x02, 0x03]);
  const throughTheQueue = JSON.parse(JSON.stringify({ mp3 })).mp3;
  assert.equal(Buffer.isBuffer(throughTheQueue), false, 'a Buffer does not survive JSON');
  assert.equal(String(throughTheQueue.toString('base64')), '[object Object]',
    'encoding it as the code did produced nine bytes of noise');

  const { audioIn, audioOut } = await import('../src/index.mjs');
  // audioOut is handed what a step returns, which is a result object around the
  // bytes, not the bytes themselves.
  const out = audioOut({ mp3, seconds: 95, pieces: 8 });
  assert.equal(typeof out.mp3, 'string', 'the bytes are left as text');
  assert.equal(out.seconds, 95, 'and the rest of the result is carried through');
  assert.equal(out.pieces, 8);
  const back = audioIn(out.mp3);
  assert.ok(Buffer.isBuffer(back), 'it comes back as bytes');
  assert.equal(back.length, mp3.length, 'all of it comes back');
  assert.deepEqual([...back], [...mp3], 'byte for byte');

  // A cache hit carries its audio the same way, and must not be assumed to be bytes.
  assert.deepEqual([...audioIn(throughTheQueue)], [...mp3], 'even from parsed JSON');
  assert.throws(() => audioIn(42), /other than audio/, 'and it says so when it is not audio');
});

await check('a bad run id is rejected before any lookup', async () => {
  const response = await call('/status?run=not-a-run-id');
  assert.equal(response.status, 400);
});

await check('an unknown route is a 404, not a crash', async () => {
  const response = await call('/nope');
  assert.equal(response.status, 404);
});

await check('a preflight is answered without the key', async () => {
  const response = await worker.fetch(new Request('https://example.test/speak', { method: 'OPTIONS' }));
  assert.equal(response.status, 204);
});

await check('a body that is not an object is refused plainly', async () => {
  const response = await call('/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '"just a string"',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /text.*url|url.*text/i);
});

await check('a non-JSON body is refused', async () => {
  const response = await call('/speak', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(response.status, 415);
});

await check('a request with nothing to read is refused before a run starts', async () => {
  for (const body of ['{}', '{"text":""}', '{"text":"   "}', '{"lang":"swh"}']) {
    const response = await call('/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(response.status, 400, `${body} should be refused, got ${response.status}`);
  }
});

await check('malformed JSON is refused', async () => {
  const response = await call('/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"text": "unterminated',
  });
  assert.equal(response.status, 400);
});

console.log(`\n  ${passed} route checks passed`);
