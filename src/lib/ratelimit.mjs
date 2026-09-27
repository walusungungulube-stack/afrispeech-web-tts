/**
 * Who may start a run, and how often.
 *
 * The service is public and cannot be otherwise: the endpoint and the key are
 * both in the page source, and the key is not a secret in any case. A browser
 * is the only thing that sends an Origin header honestly, so the allowlist
 * stops other people's pages from spending the quota, and stops nothing else.
 * Anyone with curl can reach /speak, and would otherwise be able to spend the
 * Gemini key as fast as they liked.
 *
 * So the aim is not to keep callers out. It is to put a ceiling on what one
 * caller, or many callers, can cost. Three limits, cheapest first:
 *
 *   - per address, per minute, so one caller cannot flood;
 *   - per address, per day, so a caller who waits a minute between requests
 *     still cannot run all day;
 *   - across everyone, per day, which is the one that matters. Per-address
 *     limits are all bypassed by rotating addresses, and a budget is not.
 *
 * Only starts are counted. Status polling and fetching finished audio are free
 * and must not be limited, or a legitimate client would be throttled for
 * waiting.
 */

import { redis } from './store.mjs';
import { config } from './config.mjs';

const MINUTE = 60;
const DAY = 24 * 60 * 60;

/**
 * Who to count this against.
 *
 * Cloudflare sets CF-Connecting-IP and it cannot be forged by a client, so it
 * is preferred. Behind no proxy there is nothing trustworthy to read, and
 * rather than invent an identity from a header anyone can set, the request is
 * counted against nobody in particular and only the shared budget applies.
 *
 * @param {Request} request
 * @returns {string|null}
 */
export function callerId(request) {
  const direct = request.headers.get('cf-connecting-ip');
  if (direct) return direct.trim();

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();

  return null;
}

/**
 * Count one hit, and put an expiry on the window the first time it is used.
 *
 * The expiry is only set when the counter is created, otherwise every request
 * would push the window along and a caller could never run out of it.
 */
async function hit(key, window) {
  const client = redis();
  const count = await client.incr(key);
  if (count === 1) await client.expire(key, window);
  return count;
}

let counter = hit;

/**
 * Swap the counter, for the checks.
 *
 * A module namespace cannot be patched from outside, so the seam has to be a
 * function the module calls rather than an import the test replaces.
 *
 * @param {(key: string, window: number) => Promise<number>} fn
 */
export function setCounter(fn) {
  counter = fn;
}

/**
 * Decide whether a run may start.
 *
 * @param {Request} request
 * @returns {Promise<{ok: boolean, status?: number, error?: string,
 *   retryAfter?: number, scope?: string}>}
 */
export async function checkStart(request) {
  if (!config.rateEnabled) return { ok: true };

  const id = callerId(request);

  // Per address first, so a flood is stopped before it reaches the shared
  // counter and eats the day's budget for everyone else.
  if (id) {
    const perMinute = config.ratePerMinute;
    if (perMinute > 0) {
      const count = await counter(`listen:rl:min:${id}`, MINUTE);
      if (count > perMinute) {
        return {
          ok: false,
          status: 429,
          scope: 'minute',
          retryAfter: MINUTE,
          error: `Too many requests. You can start ${perMinute} a minute; try again shortly.`,
        };
      }
    }

    const perDay = config.ratePerDay;
    if (perDay > 0) {
      const count = await counter(`listen:rl:day:${id}`, DAY);
      if (count > perDay) {
        return {
          ok: false,
          status: 429,
          scope: 'day',
          retryAfter: DAY,
          error: `You have reached the daily limit of ${perDay}. It resets in 24 hours.`,
        };
      }
    }
  }

  // The ceiling on the whole service's spend for the day. This is the limit
  // that cannot be got around by changing address.
  const budget = config.budgetPerDay;
  if (budget > 0) {
    const count = await counter('listen:rl:budget:day', DAY);
    if (count > budget) {
      return {
        ok: false,
        status: 503,
        scope: 'budget',
        retryAfter: DAY,
        error: 'AfriSpeech Listen has reached its daily limit and is resting until tomorrow.',
      };
    }
  }

  return { ok: true };
}
