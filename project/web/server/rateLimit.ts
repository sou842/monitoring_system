import type { Db, ObjectId } from 'mongodb';
import {
  IPV6_GROUPS,
  IPV6_RATE_LIMIT_GROUPS,
  LOGIN_ATTEMPTS_PER_ACCOUNT,
  LOGIN_ATTEMPTS_PER_IP,
  LOGIN_WINDOW_MS,
  MAX_IP_LENGTH,
  RATE_LIMIT_EVENTS_PER_IP_PER_MINUTE,
  RATE_LIMIT_EVENTS_PER_MINUTE,
  RATE_LIMIT_TRANSACTIONS_PER_IP_PER_MINUTE,
  RATE_LIMIT_TRANSACTIONS_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  SIGNUPS_PER_IP,
  SIGNUP_WINDOW_MS,
} from './constants.ts';
import { collections } from './db.ts';

export interface Budget {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters stored in MongoDB, so limits hold across all
 * serverless instances. Counter documents expire on their own (TTL index).
 */
export async function consume(db: Db, key: string, amount: number, limit: number, windowMs: number, now = Date.now()): Promise<Budget> {
  const windowStart = now - (now % windowMs);
  const windowEnd = windowStart + windowMs;
  const doc = await collections(db).rateLimits.findOneAndUpdate(
    { _id: `${key}:${windowStart}` },
    { $inc: { count: amount }, $setOnInsert: { expiresAt: new Date(windowEnd + windowMs) } },
    { upsert: true, returnDocument: 'after' },
  );
  // With upsert and returnDocument "after" there is always a document.
  const count = doc === null ? amount : doc.count;
  return { allowed: count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)) };
}

/** Per-project event budget per minute; always allowed when RATE_LIMIT_EVENTS_PER_MINUTE is null. */
export function consumeEventBudget(db: Db, projectId: ObjectId, eventCount: number, now = Date.now()): Promise<Budget> {
  if (RATE_LIMIT_EVENTS_PER_MINUTE === null) return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
  return consume(db, String(projectId), eventCount, RATE_LIMIT_EVENTS_PER_MINUTE, RATE_LIMIT_WINDOW_MS, now);
}

/** Per-project page-view (transaction event) budget per minute, separate from the event budget. */
export function consumeTransactionBudget(db: Db, projectId: ObjectId, count: number, now = Date.now()): Promise<Budget> {
  return consume(db, `${projectId}:transactions`, count, RATE_LIMIT_TRANSACTIONS_PER_MINUTE, RATE_LIMIT_WINDOW_MS, now);
}

/**
 * The source a request is counted against: an IPv4 address as is, an IPv6
 * address cut to its /64 network (`2001:db8:a:b::/64`), since one client can
 * rotate through a whole /64.
 */
export function ipBucket(ip: unknown): string {
  const text = String(ip || 'unknown').trim().slice(0, MAX_IP_LENGTH).replace(/%.*$/, '').toLowerCase();
  if (!text.includes(':')) return text;
  const mapped = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const [head, tail = ''] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = text.includes('::')
    ? [...left, ...Array<string>(Math.max(0, IPV6_GROUPS - left.length - right.length)).fill('0'), ...right]
    : left;
  const prefix = groups.slice(0, IPV6_RATE_LIMIT_GROUPS).map((group) => (parseInt(group, 16) || 0).toString(16));
  return `${prefix.join(':')}::/${IPV6_RATE_LIMIT_GROUPS * 16}`;
}

/** Per-project, per-IP event budget per minute, so one source can't use up the project budget. */
export function consumeIpEventBudget(db: Db, projectId: ObjectId, ip: string, eventCount: number, now = Date.now()): Promise<Budget> {
  return consume(db, `ingest-ip:${projectId}:${ipBucket(ip)}`, eventCount, RATE_LIMIT_EVENTS_PER_IP_PER_MINUTE, RATE_LIMIT_WINDOW_MS, now);
}

/** Per-project, per-IP page-view budget per minute. */
export function consumeIpTransactionBudget(db: Db, projectId: ObjectId, ip: string, count: number, now = Date.now()): Promise<Budget> {
  return consume(db, `ingest-ip:${projectId}:${ipBucket(ip)}:transactions`, count, RATE_LIMIT_TRANSACTIONS_PER_IP_PER_MINUTE, RATE_LIMIT_WINDOW_MS, now);
}

/** One login attempt: limited per IP and per account+IP, so guessing one password or many accounts is slow. */
export async function consumeLoginAttempt(db: Db, ip: string, email: string, now = Date.now()): Promise<Budget> {
  const [byIp, byAccount] = await Promise.all([
    consume(db, `login-ip:${ip}`, 1, LOGIN_ATTEMPTS_PER_IP, LOGIN_WINDOW_MS, now),
    consume(db, `login:${ip}:${email}`, 1, LOGIN_ATTEMPTS_PER_ACCOUNT, LOGIN_WINDOW_MS, now),
  ]);
  return byIp.allowed && byAccount.allowed
    ? { allowed: true, retryAfterSeconds: 0 }
    : { allowed: false, retryAfterSeconds: Math.max(byIp.retryAfterSeconds, byAccount.retryAfterSeconds) };
}

/** One account creation from this IP. */
export function consumeSignup(db: Db, ip: string, now = Date.now()): Promise<Budget> {
  return consume(db, `signup:${ip}`, 1, SIGNUPS_PER_IP, SIGNUP_WINDOW_MS, now);
}
