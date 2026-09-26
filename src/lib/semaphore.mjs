/**
 * A cap on how many Gemini Live sessions may be open at once, across every
 * request being served.
 *
 * The limit has to live outside the process. An article is synthesised by a
 * workflow, and a workflow step is an independent invocation with no memory of
 * the others, so a counter in a variable would start at zero every time and cap
 * nothing. Redis is the one place all of them can see.
 *
 * The count is a plain counter with a lease on it. If a step is killed midway,
 * the counter would keep a slot that nobody will ever return, so every acquire
 * also refreshes an expiry and an idle key resets itself. A slot is therefore
 * lost for at most the lease, not forever.
 */

/* Counted and released in one round trip, so two steps cannot both read "one
   slot left" and both take it. */
const ACQUIRE = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then return -1 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return current + 1
`;

const RELEASE = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 1 then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('DECR', KEYS[1])
return current - 1
`;

const key = 'listen:sem:live';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold a slot for the length of `work`.
 *
 * When the cap is reached this waits its turn rather than refusing, because a
 * reader who has already been told their article is being read should not be
 * told no. `maxWaitMs` is the point at which that stops being reasonable.
 */
export async function withSlot(work, {
  limit,
  maxWaitMs = 60_000,
  leaseSeconds = 120,
  redis,
  now = () => Date.now(),
  wait = sleep,
} = {}) {
  const client = redis || (await import('./store.mjs')).redis();
  const started = now();

  for (;;) {
    const taken = await client.eval(ACQUIRE, [key], [limit, leaseSeconds]);
    if (taken !== -1) {
      try {
        return await work();
      } finally {
        // Released whatever happened, including a thrown error or a step the
        // platform cut short, so one bad request cannot shrink the service.
        await client.eval(RELEASE, [key], []).catch(() => {});
      }
    }

    if (now() - started >= maxWaitMs) {
      throw Object.assign(new Error('The service is busy. Please try again in a moment.'), {
        code: 'BUSY',
        status: 503,
      });
    }
    // Jitter, so slots freed by one step are not all taken by the waiters at once.
    await wait(200 + Math.floor(Math.random() * 400));
  }
}

/** How many slots are held right now. For tests and diagnostics. */
export async function inUse(redis) {
  const client = redis || (await import('./store.mjs')).redis();
  return Number((await client.get(key)) || 0);
}
