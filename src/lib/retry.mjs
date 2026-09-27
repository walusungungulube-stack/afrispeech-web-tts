/**
 * Retrying a step that talks to a model.
 *
 * A dropped socket or a throttled response is worth repeating, and usually
 * succeeds the second time. The delay grows between attempts, because retrying
 * instantly would pile the same load back onto a service that has just refused
 * it, while other readers are waiting on it too.
 *
 * A caller that can recover by doing something *different* rather than
 * repeating may say so with `onFailure`. The synthesis pipeline does not: the
 * model reduces the page before speaking, so a turn is already short, and the
 * only alternative to one turn would be two turns and twice the character
 * budget.
 */

const DEFAULT_BASE_MS = 400;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with a ceiling, so a long wait never becomes minutes. */
export function backoff(attempt, baseMs = DEFAULT_BASE_MS, capMs = 8000) {
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}

/**
 * Run `attempt`, and if it throws, try again up to `attempts` times in total.
 *
 * `onFailure(attempt, error)` runs before each wait, for callers that can
 * recover by changing the work. Return nothing to simply repeat the same work, a
 * function to run as the next attempt, or a value to use as the result.
 */
export async function withRetry(attempt_, {
  attempts = 5,
  baseMs = DEFAULT_BASE_MS,
  onFailure = null,
  sleep = wait,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await attempt_(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      if (onFailure) {
        const alternative = await onFailure(attempt, error);
        if (alternative) {
          /* A function is a different attempt to run. Anything else is already
             the answer: recovering from a failure often means doing the work a
             different way, and the caller has that result in hand. */
          return typeof alternative === 'function' ? alternative(attempt + 1) : alternative;
        }
      }
      await sleep(backoff(attempt, baseMs));
    }
  }
  throw lastError;
}
