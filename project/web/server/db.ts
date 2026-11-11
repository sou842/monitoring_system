import { MongoClient, type Db } from 'mongodb';
import { CHAT_RETENTION_DAYS, EVENT_RETENTION_DAYS, ISSUE_RETENTION_DAYS, ROLLUP_RETENTION_DAYS, SECONDS_PER_DAY, TRANSACTION_RETENTION_DAYS } from './constants.ts';
import { requireEnv } from './env.ts';
import type { ChatMessageDoc, ChatReadDoc, EventDoc, IssueDoc, ProjectDoc, ProjectMemberDoc, RateLimitDoc, RollupDoc, TransactionDoc, UserDoc } from './models.ts';

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
/** Name of the events index behind the AI's SDK-version queries (`payload.sdk.version`; they pass it as a hint). */
export const EVENTS_SDK_VERSION_INDEX = 'projectId_sdkVersion_receivedAt_issueId';

export const collections = (db: Db) => ({
  users: db.collection<UserDoc>('users'),
  projects: db.collection<ProjectDoc>('projects'),
  issues: db.collection<IssueDoc>('issues'),
  events: db.collection<EventDoc>('events'),
  transactions: db.collection<TransactionDoc>('transactions'),
  rollups: db.collection<RollupDoc>('perf_rollups'),
  rateLimits: db.collection<RateLimitDoc>('rate_limits'),
  members: db.collection<ProjectMemberDoc>('project_members'),
  chatMessages: db.collection<ChatMessageDoc>('chat_messages'),
  chatReads: db.collection<ChatReadDoc>('chat_reads'),
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

    // Project members: one row per (project, user); "my shared projects" by user.
    db.collection('project_members').createIndex({ projectId: 1, userId: 1 }, { unique: true }),
    db.collection('project_members').createIndex({ userId: 1 }),
    // Project chat: newest messages of a channel; one read marker per (project, user).
    db.collection('chat_messages').createIndex({ projectId: 1, _id: -1 }),
    // Changes (edits, reactions, deletes) since a time, for syncing open chats.
    db.collection('chat_messages').createIndex({ projectId: 1, updatedAt: 1 }, { partialFilterExpression: { updatedAt: { $exists: true } } }),
    // A message re-sent after a lost response is saved once.
    db.collection('chat_messages').createIndex({ userId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $exists: true } } }),
    // Chat messages older than 30 days are removed automatically.
    db.collection('chat_messages').createIndex({ createdAt: 1 }, { expireAfterSeconds: CHAT_RETENTION_DAYS * SECONDS_PER_DAY }),
    db.collection('chat_reads').createIndex({ projectId: 1, userId: 1 }, { unique: true }),

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
    // "Everything from this device / session / network" lookups and the search box (SDK 0.12.0+ events only).
    // $exists, not $type: a partial index is only used when the query implies its filter, and an equality does
    // imply $exists (ingest leaves the field out when unknown) but not $type. tests/api.test.ts checks the plan.
    db.collection('events').createIndex({ projectId: 1, deviceId: 1, receivedAt: -1 }, { partialFilterExpression: { deviceId: { $exists: true } } }),
    db.collection('events').createIndex({ projectId: 1, sessionId: 1, receivedAt: -1 }, { partialFilterExpression: { sessionId: { $exists: true } } }),
    db.collection('events').createIndex({ projectId: 1, networkId: 1, receivedAt: -1 }, { partialFilterExpression: { networkId: { $exists: true } } }),
    // "Issues from SDK 0.12.0" (AI `get_sdk_version_issues`). issueId + receivedAt in the key make those queries
    // covered (no event documents read). tests/api.test.ts checks the plan.
    db.collection('events').createIndex({ projectId: 1, 'payload.sdk.version': 1, receivedAt: -1, issueId: 1 }, { name: EVENTS_SDK_VERSION_INDEX }),
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
