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
 *
 * `shouldRetry` exists for the error that repeating cannot fix. A refused quota
 * is the clear case: the same request sent again cannot succeed, and every
 * repeat spends another attempt against a limit that is already spent while
 * other readers wait behind it. Measured on one key, sixteen concurrent turns
 * was enough to have eleven refused for quota, so retrying each of those would
 * have made the shortfall considerably worse rather than papered over it.
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
 *
 * `shouldRetry(error, attempt)` returning false rethrows without waiting. It
 * defaults to retrying everything, which is right for the dropped sockets and
 * throttled responses this is built for.
 */
export async function withRetry(attempt_, {
  attempts = 5,
  baseMs = DEFAULT_BASE_MS,
  onFailure = null,
  shouldRetry = null,
  sleep = wait,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await attempt_(attempt);
    } catch (error) {
      // Asked for last, because an error that repeating cannot fix should be
      // handed straight back rather than spending the remaining attempts on it.
      if (shouldRetry && !shouldRetry(error, attempt)) throw error;
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

/**
 * Split text near the middle, on a word boundary.
 *
 * Used as the recovery for a piece the model will not finish: two shorter pieces
 * are more likely to succeed than the same long one asked again. Splitting is
 * only ever a recovery from a failure, never the normal path, because the pieces
 * are joined back into one recording and a split costs an extra session.
 */
export function bisect(text) {
  const clean = String(text).trim();
  if (clean.length < 2) return null;
  const middle = Math.floor(clean.length / 2);
  const space = clean.indexOf(' ', middle);
  if (space === -1 || space === 0) return null;
  return [clean.slice(0, space).trim(), clean.slice(space + 1).trim()];
}
