/**
 * Small in-memory rate limiter (fixed window per key). Good enough for a
 * single-instance deployment (apphosting.yaml: maxInstances 1); with several
 * instances each one enforces the limit independently, which is still a cap.
 *
 * Usage:
 *   const verdict = rateLimit(`sms:${ip}`, { limit: 30, windowMs: 60_000 });
 *   if (!verdict.allowed) return 429 with `Retry-After: ${verdict.retryAfterSec}`.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 10_000;
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000 && buckets.size < MAX_TRACKED_KEYS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear(); // pathological flood: reset rather than grow unbounded
}

export function rateLimit(key: string, options: { limit: number; windowMs: number }): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, remaining: options.limit - 1, retryAfterSec: 0 };
  }
  bucket.count++;
  if (bucket.count > options.limit) {
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { allowed: true, remaining: options.limit - bucket.count, retryAfterSec: 0 };
}

/**
 * Returns true at most once per `everyMs` for a key: used to send one alert
 * for a burst of events instead of one per event.
 */
const lastNotified = new Map<string, number>();
export function onceEvery(key: string, everyMs: number): boolean {
  const now = Date.now();
  const last = lastNotified.get(key) ?? 0;
  if (now - last < everyMs) return false;
  lastNotified.set(key, now);
  return true;
}
