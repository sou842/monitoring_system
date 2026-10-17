import { RATE_LIMIT_EVENTS_PER_MINUTE, RATE_LIMIT_WINDOW_MS } from './constants.js';

/**
 * Per-project event budget per minute, counted in MongoDB so it holds across
 * all serverless instances. Counter documents expire on their own (TTL index).
 *
 * @returns {Promise<{ allowed: boolean, retryAfterSeconds: number }>}
 */
export async function consumeEventBudget(db, projectId, eventCount, now = Date.now()) {
  const windowStart = now - (now % RATE_LIMIT_WINDOW_MS);
  const windowEnd = windowStart + RATE_LIMIT_WINDOW_MS;
  const doc = await db.collection('rate_limits').findOneAndUpdate(
    { _id: `${projectId}:${windowStart}` },
    { $inc: { count: eventCount }, $setOnInsert: { expiresAt: new Date(windowEnd + RATE_LIMIT_WINDOW_MS) } },
    { upsert: true, returnDocument: 'after' },
  );
  return {
    allowed: doc.count <= RATE_LIMIT_EVENTS_PER_MINUTE,
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
  };
}
