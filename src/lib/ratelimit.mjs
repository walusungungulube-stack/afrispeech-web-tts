/** In-memory rate limiting — replaces Redis counters. */
import { config } from './config.mjs';

const MINUTE = 60;
const DAY = 24 * 60 * 60;

const counters = new Map();

let cleanupTimer = null;
function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of counters) { if (now > v.expires) counters.delete(k); }
    cleanupTimer = null;
  }, 60 * 1000);
  if (cleanupTimer && cleanupTimer.unref) cleanupTimer.unref();
}
export function callerId(request) {
  const direct = request.headers.get('cf-connecting-ip');
  if (direct) return direct.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return null;
}

function hit(key, windowMs) {
  scheduleCleanup();
  const now = Date.now();
  const entry = counters.get(key);
  if (!entry || now > entry.expires) {
    counters.set(key, { count: 1, expires: now + windowMs });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

let counter = hit;
export function setCounter(fn) { counter = fn; }

export async function checkFlood(request) {
  if (!config.rateEnabled) return { ok: true };
  const id = callerId(request);
  if (!id) return { ok: true };
  const perMinute = config.ratePerMinute;
  if (perMinute > 0) {
    const count = await counter(`listen:rl:min:${id}`, MINUTE);
    if (count > perMinute) return { ok: false, status: 429, scope: 'minute', retryAfter: MINUTE, error: `Too many requests. You can start ${perMinute} a minute; try again shortly.` };
  }
  return { ok: true };
}

export async function claimBudget(request) {
  if (!config.rateEnabled) return { ok: true };
  const id = callerId(request);
  if (id) {
    const perDay = config.ratePerDay;
    if (perDay > 0) {
      const count = await counter(`listen:rl:day:${id}`, DAY);
      if (count > perDay) return { ok: false, status: 429, scope: 'day', retryAfter: DAY, error: `You have reached the daily limit of ${perDay}. It resets in 24 hours.` };
    }
  }
  const budget = config.budgetPerDay;
  if (budget > 0) {
    const count = await counter('listen:rl:budget:day', DAY);
    if (count > budget) return { ok: false, status: 503, scope: 'budget', retryAfter: DAY, error: 'AfriSpeech Listen has reached its daily limit and is resting until tomorrow.' };
  }
  return { ok: true };
}
