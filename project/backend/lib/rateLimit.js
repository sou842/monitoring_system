import {
  LOGIN_ATTEMPTS_PER_ACCOUNT,
  LOGIN_ATTEMPTS_PER_IP,
  LOGIN_WINDOW_MS,
  RATE_LIMIT_EVENTS_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  SIGNUPS_PER_IP,
  SIGNUP_WINDOW_MS,
} from './constants.js';

/**
 * Fixed-window counters stored in MongoDB, so limits hold across all
 * serverless instances. Counter documents expire on their own (TTL index).
 *
 * @returns {Promise<{ allowed: boolean, retryAfterSeconds: number }>}
 */
export async function consume(db, key, amount, limit, windowMs, now = Date.now()) {
  const windowStart = now - (now % windowMs);
  const windowEnd = windowStart + windowMs;
  const doc = await db.collection('rate_limits').findOneAndUpdate(
    { _id: `${key}:${windowStart}` },
    { $inc: { count: amount }, $setOnInsert: { expiresAt: new Date(windowEnd + windowMs) } },
    { upsert: true, returnDocument: 'after' },
  );
  return { allowed: doc.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)) };
}

/** Per-project event budget per minute. */
export function consumeEventBudget(db, projectId, eventCount, now = Date.now()) {
  return consume(db, String(projectId), eventCount, RATE_LIMIT_EVENTS_PER_MINUTE, RATE_LIMIT_WINDOW_MS, now);
}

/** One login attempt: limited per IP and per account+IP, so guessing one password or many accounts is slow. */
export async function consumeLoginAttempt(db, ip, email, now = Date.now()) {
  const [byIp, byAccount] = await Promise.all([
    consume(db, `login-ip:${ip}`, 1, LOGIN_ATTEMPTS_PER_IP, LOGIN_WINDOW_MS, now),
    consume(db, `login:${ip}:${email}`, 1, LOGIN_ATTEMPTS_PER_ACCOUNT, LOGIN_WINDOW_MS, now),
  ]);
  return byIp.allowed && byAccount.allowed
    ? { allowed: true, retryAfterSeconds: 0 }
    : { allowed: false, retryAfterSeconds: Math.max(byIp.retryAfterSeconds, byAccount.retryAfterSeconds) };
}

export function consumeSignup(db, ip, now = Date.now()) {
  return consume(db, `signup:${ip}`, 1, SIGNUPS_PER_IP, SIGNUP_WINDOW_MS, now);
}
