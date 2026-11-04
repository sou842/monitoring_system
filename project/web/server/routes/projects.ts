import { PERMISSIONS } from '../../lib/permissions.ts';
import { forbidden, projectAccess } from '../access.ts';
import { requireUser } from '../auth.ts';
import { unreadCounts } from '../chat.ts';
import { MAX_PROJECTS_PER_USER } from '../constants.ts';
import { collections } from '../db.ts';
import { deleteProject } from '../deletion.ts';
import { bodyObject, errorResponse, handle, json, parseObjectId, readJson } from '../http.ts';
import { cleanInsightSettings } from '../insights.ts';
import { cleanOriginList } from '../origins.ts';
import { cleanProjectName, createProject, projectView, rotateApiKey, setAllowedOrigins, setInsightSettings } from '../projects.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2048;
/** Room for full insight settings (3 lists of MAX_INSIGHT_ENTRIES, up to 3 UTF-8 bytes per character) or the origin list. */
const MAX_SETTINGS_BODY_BYTES = 256 * 1024;

/**
 * GET /api/projects — the projects you own and the ones you are a member of (owned first, newest first),
 * each with your role and permissions, the owner's name, open-issue and last-24h event counts and unread
 * chat messages; plus your project limit (null = none).
 */
export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const c = collections(db);

  const memberships = await c.members.find({ userId: user._id }).toArray();
  const [owned, shared] = await Promise.all([
    c.projects.find({ ownerId: user._id }).sort({ createdAt: -1 }).toArray(),
    c.projects.find({ _id: { $in: memberships.map((m) => m.projectId) } }).sort({ createdAt: -1 }).toArray(),
  ]);
  const projects = [...owned, ...shared];
  const ownerIds = shared.flatMap((p) => (p.ownerId ? [p.ownerId] : []));
  const ids = projects.map((p) => p._id);
  const since = new Date(Date.now() - DAY_MS);
  const [owners, openIssues, recentEvents, unread] = await Promise.all([
    c.users.find({ _id: { $in: ownerIds } }, { projection: { name: 1 } }).toArray(),
    c.issues.aggregate<{ _id: unknown; n: number }>([{ $match: { projectId: { $in: ids }, status: 'open' } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }]).toArray(),
    c.events.aggregate<{ _id: unknown; n: number }>([{ $match: { projectId: { $in: ids }, receivedAt: { $gte: since } } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }]).toArray(),
    unreadCounts(db, user._id, ids),
  ]);
  const countFor = (rows: Array<{ _id: unknown; n: number }>, id: unknown) => (rows.find((r) => String(r._id) === String(id)) || { n: 0 }).n;

  return json({
    projects: projects.map((p) => {
      const isOwner = Boolean(p.ownerId && p.ownerId.equals(user._id));
      const member = memberships.find((m) => m.projectId.equals(p._id));
      const owner = isOwner ? user : owners.find((u) => p.ownerId !== undefined && u._id.equals(p.ownerId));
      return {
        ...projectView(p),
        role: isOwner ? 'owner' : 'member',
        permissions: isOwner ? [...PERMISSIONS] : member ? member.permissions : [],
        ownerName: owner ? owner.name : null,
        openIssues: countFor(openIssues, p._id),
        events24h: countFor(recentEvents, p._id),
        unreadMessages: unread.get(String(p._id)) ?? 0,
      };
    }),
    limit: MAX_PROJECTS_PER_USER,
  });
});

/**
 * POST /api/projects            `{ name }` → creates a project (you are its owner)
 * POST /api/projects?id=…&action=rotate-key → replaces its API key (`key.manage`)
 * Both return the plain API key once; it cannot be retrieved again.
 */
export const POST = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const c = collections(db);
  const params = new URL(request.url).searchParams;

  if (params.get('action') === 'rotate-key') {
    const id = parseObjectId(params.get('id'));
    if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid project id');
    const access = await projectAccess(db, user, id);
    if (access === null) return errorResponse(404, 'not_found', 'Project not found');
    if (!access.can('key.manage')) return forbidden('key.manage');
    const apiKey = await rotateApiKey(db, id);
    const project = await c.projects.findOne({ _id: id });
    if (project === null) return errorResponse(404, 'not_found', 'Project not found');
    return json({ project: projectView(project), apiKey });
  }

  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const name = cleanProjectName(bodyObject(body.value).name);
  if (name === null) return errorResponse(400, 'invalid_name', 'Project name is required (max 80 characters)');
  if (MAX_PROJECTS_PER_USER !== null && (await c.projects.countDocuments({ ownerId: user._id })) >= MAX_PROJECTS_PER_USER) {
    return errorResponse(403, 'project_limit', `You can have at most ${MAX_PROJECTS_PER_USER} projects. Delete one to create another.`);
  }
  const { project, apiKey } = await createProject(db, name, user._id);
  return json({ project: projectView(project), apiKey }, 201);
});

/**
 * PATCH /api/projects?id=…  (`settings.manage`) with either or both of:
 * - `{ allowedOrigins: ["https://myapp.com", "http://localhost:3000"] }`: replaces
 *   the websites allowed to send events with this project's key (empty list =
 *   any website). 400 `invalid_origins` lists each bad entry.
 * - `{ insights: { libraryPaths, hiddenFrames, hints } }`: replaces the issue
 *   page's insight settings (server/insights.ts). 400 `invalid_insights`.
 */
export const PATCH = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid project id');
  const access = await projectAccess(db, user, id);
  if (access === null) return errorResponse(404, 'not_found', 'Project not found');
  if (!access.can('settings.manage')) return forbidden('settings.manage');

  const body = await readJson(request, MAX_SETTINGS_BODY_BYTES);
  if (!body.ok) return body.response;
  const value = bodyObject(body.value);
  if (!('allowedOrigins' in value) && !('insights' in value)) {
    return errorResponse(400, 'nothing_to_update', 'Send allowedOrigins and/or insights');
  }
  // Validate everything before saving anything.
  const origins = 'allowedOrigins' in value ? cleanOriginList(value.allowedOrigins) : null;
  if (origins && !origins.ok) return json({ error: { code: 'invalid_origins', message: origins.message, details: origins.errors } }, 400);
  const insights = 'insights' in value ? cleanInsightSettings(value.insights) : null;
  if (insights && !insights.ok) return errorResponse(400, 'invalid_insights', insights.message);
  if (origins && origins.ok) await setAllowedOrigins(db, id, origins.origins);
  if (insights && insights.ok) await setInsightSettings(db, id, insights.settings);
  const project = await collections(db).projects.findOne({ _id: id });
  if (project === null) return errorResponse(404, 'not_found', 'Project not found');
  return json({ project: projectView(project) });
});

/** DELETE /api/projects?id=… — removes the project, its issues, events, members and chat, and its API key (owner only). */
export const DELETE = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid project id');
  const access = await projectAccess(auth.db, auth.user, id);
  if (access === null) return errorResponse(404, 'not_found', 'Project not found');
  if (!access.isOwner) return forbidden('owner');
  return json({ deleted: await deleteProject(auth.db, id) });
});
