import { createHash, randomBytes } from 'node:crypto';
import { API_KEY_BYTES, API_KEY_PREFIX, MAX_PROJECT_NAME_LENGTH, PROJECT_CACHE_TTL_MS } from './constants.js';
import { emptyInsightSettings, insightSettingsView } from './insights.js';

/**
 * Projects own API keys. Only a SHA-256 hash of each key is stored, so a
 * database leak doesn't leak working keys; the full key is shown once, at
 * creation or rotation.
 */

export function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey() {
  return API_KEY_PREFIX + randomBytes(API_KEY_BYTES).toString('base64url');
}

/** Short, non-secret label for showing which key a project uses ("et_Ab3dE…"). */
function keyHint(key) {
  return key.slice(0, API_KEY_PREFIX.length + 5) + '…';
}

export function cleanProjectName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 && trimmed.length <= MAX_PROJECT_NAME_LENGTH ? trimmed : null;
}

/** Creates a project owned by `ownerId`; returns it together with the one-time plain API key. */
export async function createProject(db, name, ownerId, now = new Date()) {
  const apiKey = generateApiKey();
  const doc = { name, ownerId, apiKeyHash: hashApiKey(apiKey), apiKeyHint: keyHint(apiKey), allowedOrigins: [], insights: emptyInsightSettings(), createdAt: now };
  const { insertedId } = await db.collection('projects').insertOne(doc);
  return { project: { _id: insertedId, ...doc }, apiKey };
}

/** Replaces a project's key (the old one stops working at once). Returns the new plain key. */
export async function rotateApiKey(db, projectId) {
  const apiKey = generateApiKey();
  const result = await db
    .collection('projects')
    .updateOne({ _id: projectId }, { $set: { apiKeyHash: hashApiKey(apiKey), apiKeyHint: keyHint(apiKey) } });
  clearProjectCache();
  return result.matchedCount === 1 ? apiKey : null;
}

/** Replaces a project's allowed origins (already validated by `cleanOriginList`). */
export async function setAllowedOrigins(db, projectId, origins) {
  await db.collection('projects').updateOne({ _id: projectId }, { $set: { allowedOrigins: origins } });
  clearProjectCache();
}

/** Replaces a project's issue-insight settings (already validated by `cleanInsightSettings`). */
export async function setInsightSettings(db, projectId, settings) {
  await db.collection('projects').updateOne({ _id: projectId }, { $set: { insights: settings } });
}

// Ingestion looks the key up on every request; a short cache saves a query each time.
// Other serverless instances keep their copy for up to PROJECT_CACHE_TTL_MS.
const projectCache = new Map();

/** Forgets cached key lookups in this instance (after rotating a key or disabling an owner). */
export function clearProjectCache() {
  projectCache.clear();
}

export async function findProjectByApiKey(db, apiKey, now = Date.now()) {
  if (typeof apiKey !== 'string' || !apiKey.startsWith(API_KEY_PREFIX)) return null;
  const hash = hashApiKey(apiKey);
  const cached = projectCache.get(hash);
  if (cached && cached.expires > now) return cached.project;
  const project = await db.collection('projects').findOne({ apiKeyHash: hash });
  projectCache.set(hash, { project, expires: now + PROJECT_CACHE_TTL_MS });
  return project;
}

/** Public shape of a project (never includes the key hash). */
export function projectView(project) {
  return {
    id: String(project._id),
    name: project.name,
    apiKeyHint: project.apiKeyHint,
    allowedOrigins: Array.isArray(project.allowedOrigins) ? project.allowedOrigins : [],
    insights: insightSettingsView(project.insights),
    createdAt: project.createdAt,
  };
}
