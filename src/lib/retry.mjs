/**
 * Retrying a step that talks to a model.
 *
 * A dropped socket or a throttled response is worth repeating; a piece that is
 * simply too long for the model to finish in one turn is not, and will fail the
 * same way five times. So a later attempt is allowed to change the work rather
 * than just repeat it.
 *
 * The delay grows between attempts. Several pieces are in flight at once, so
 * retrying instantly would pile the same load back onto a service that has just
 * refused it.
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
 * `onFailure(attempt, error)` runs before each wait and may return an
 * alternative attempt, which is what lets a long piece be retried as two shorter
 * ones. Returning nothing simply repeats the same work.
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
        if (alternative) return alternative(attempt + 1);
      }
      await sleep(backoff(attempt, baseMs));
    }
  }
  throw lastError;
}

/**
 * Split text near the middle, on a word boundary.
 *
 * Used as the recovery for a piece the model will not finish: two shorter
 * pieces are more likely to succeed than the same long one asked again.
 */
export function bisect(text) {
  const clean = String(text).trim();
  if (clean.length < 2) return null;
  const middle = Math.floor(clean.length / 2);
  const space = clean.indexOf(' ', middle);
  if (space === -1 || space === 0) return null;
  return [clean.slice(0, space).trim(), clean.slice(space + 1).trim()];
}
