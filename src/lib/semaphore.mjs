/**
 * A cap on how many speech sessions may be open at once, across every request
 * being served — in memory.
 *
 * The Redis version existed because a workflow step is an independent
 * invocation with no memory of the others. In one process a plain counter is
 * atomic by construction: JavaScript runs one thing at a time, so two callers
 * cannot both read "one slot left" and both take it. No lease is needed either,
 * because a crash loses everything anyway, including the counter.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let held = 0;

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
  now = () => Date.now(),
  wait = sleep,
} = {}) {
  const started = now();

  for (;;) {
    if (held < limit) {
      held += 1;
      try {
        return await work();
      } finally {
        // Released whatever happened, including a thrown error, so one bad
        // request cannot shrink the service.
        held = Math.max(0, held - 1);
      }
    }

    if (now() - started >= maxWaitMs) {
      throw Object.assign(new Error('The service is busy. Please try again in a moment.'), {
        code: 'BUSY',
        status: 503,
      });
    }
    // Jitter, so slots freed by one request are not all taken by the waiters at once.
    await wait(200 + Math.floor(Math.random() * 400));
  }
}

/** How many slots are held right now. For tests and diagnostics. */
export async function inUse() {
  return held;
}
