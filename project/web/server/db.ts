import { MongoClient, type Db } from 'mongodb';
import { EVENT_RETENTION_DAYS, ISSUE_RETENTION_DAYS, ROLLUP_RETENTION_DAYS, SECONDS_PER_DAY, TRANSACTION_RETENTION_DAYS } from './constants.ts';
import { requireEnv } from './env.ts';
import type { EventDoc, IssueDoc, ProjectDoc, RateLimitDoc, RollupDoc, TransactionDoc, UserDoc } from './models.ts';

interface DbState {
  client: MongoClient | null;
  db: Db | null;
  indexes: Promise<void> | null;
}

declare global {
  var __errorTrackerDb: DbState | undefined;
}

/**
 * One MongoClient per server instance, reused across requests. On Vercel a
 * warm function keeps it between invocations; globalThis also survives
 * module reloads in local development.
 */
const state: DbState = (globalThis.__errorTrackerDb ??= { client: null, db: null, indexes: null });

/** Returns the connected database, creating indexes on first use. */
export async function getDb(): Promise<Db> {
  if (state.db === null) {
    const client = new MongoClient(requireEnv('MONGODB_URI'), {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
    });
    await client.connect();
    state.client = client;
    state.db = client.db(process.env.MONGODB_DB || 'monitor');
  }
  const db = state.db;
  state.indexes ??= ensureIndexes(db).catch((error: unknown) => {
    state.indexes = null; // retry on the next request
    throw error;
  });
  await state.indexes;
  return db;
}

/** Closes the shared connection (used by tests and scripts). */
export async function closeDb(): Promise<void> {
  if (state.client !== null) await state.client.close();
  state.client = null;
  state.db = null;
  state.indexes = null;
}

/** Typed collections, so every query knows its document shape. */
export const collections = (db: Db) => ({
  users: db.collection<UserDoc>('users'),
  projects: db.collection<ProjectDoc>('projects'),
  issues: db.collection<IssueDoc>('issues'),
  events: db.collection<EventDoc>('events'),
  transactions: db.collection<TransactionDoc>('transactions'),
  rollups: db.collection<RollupDoc>('perf_rollups'),
  rateLimits: db.collection<RateLimitDoc>('rate_limits'),
});

/**
 * Creates the indexes the app relies on. Idempotent: MongoDB ignores
 * indexes that already exist with the same definition.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('projects').createIndex({ apiKeyHash: 1 }, { unique: true }),
    db.collection('projects').createIndex({ ownerId: 1, createdAt: -1 }),
    db.collection('users').createIndex({ email: 1 }, { unique: true }),

    // One issue per (project, fingerprint): this is what groups repeated errors.
    db.collection('issues').createIndex({ projectId: 1, fingerprint: 1 }, { unique: true }),
    db.collection('issues').createIndex({ projectId: 1, status: 1, lastSeen: -1 }),
    db.collection('issues').createIndex({ projectId: 1, count: -1 }),
    // Issues nobody has seen for 90 days are removed automatically.
    db.collection('issues').createIndex({ lastSeen: 1 }, { expireAfterSeconds: ISSUE_RETENTION_DAYS * SECONDS_PER_DAY }),

    db.collection('events').createIndex({ issueId: 1, receivedAt: -1 }),
    db.collection('events').createIndex({ projectId: 1, receivedAt: -1 }),
    // Find the events that recorded one API call by its `_id` (multikey: one entry per call).
    db.collection('events').createIndex({ 'payload.performance.api_calls._id': 1 }),
    // Events older than 30 days are removed automatically.
    db.collection('events').createIndex({ receivedAt: 1 }, { expireAfterSeconds: EVENT_RETENTION_DAYS * SECONDS_PER_DAY }),

    // Page views: newest first per project, and "slowest calls to this endpoint".
    db.collection('transactions').createIndex({ projectId: 1, receivedAt: -1 }),
    db.collection('transactions').createIndex({ projectId: 1, route: 1, receivedAt: -1 }),
    db.collection('transactions').createIndex({ projectId: 1, 'spans.key': 1, receivedAt: -1 }),
    db.collection('transactions').createIndex({ 'spans._id': 1 }),
    db.collection('transactions').createIndex({ receivedAt: 1 }, { expireAfterSeconds: TRANSACTION_RETENTION_DAYS * SECONDS_PER_DAY }),
    // One rollup row per (project, hour, environment, page or endpoint).
    db.collection('perf_rollups').createIndex({ projectId: 1, kind: 1, key: 1, environment: 1, hour: 1 }, { unique: true }),
    db.collection('perf_rollups').createIndex({ projectId: 1, hour: 1 }),
    db.collection('perf_rollups').createIndex({ hour: 1 }, { expireAfterSeconds: ROLLUP_RETENTION_DAYS * SECONDS_PER_DAY }),

    // Rate-limit counters expire right after their minute is over.
    db.collection('rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}
