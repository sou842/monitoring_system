import { ownedProject } from '../lib/access.js';
import { requireUser } from '../lib/auth.js';
import { MAX_PROJECTS_PER_USER } from '../lib/constants.js';
import { deleteProject } from '../lib/deletion.js';
import { errorResponse, handle, json, parseObjectId, readJson } from '../lib/http.js';
import { cleanProjectName, createProject, projectView, rotateApiKey } from '../lib/projects.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2048;

/** GET /api/projects — your projects with open-issue and last-24h event counts, plus your project limit. */
export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;

  const projects = await db.collection('projects').find({ ownerId: user._id }).sort({ createdAt: -1 }).toArray();
  const ids = projects.map((p) => p._id);
  const since = new Date(Date.now() - DAY_MS);
  const [openIssues, recentEvents] = await Promise.all([
    db.collection('issues').aggregate([{ $match: { projectId: { $in: ids }, status: 'open' } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }]).toArray(),
    db.collection('events').aggregate([{ $match: { projectId: { $in: ids }, receivedAt: { $gte: since } } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }]).toArray(),
  ]);
  const countFor = (rows, id) => (rows.find((r) => String(r._id) === String(id)) || { n: 0 }).n;

  return json({
    projects: projects.map((p) => ({ ...projectView(p), openIssues: countFor(openIssues, p._id), events24h: countFor(recentEvents, p._id) })),
    limit: MAX_PROJECTS_PER_USER,
  });
});

/**
 * POST /api/projects            `{ name }` → creates a project
 * POST /api/projects?id=…&action=rotate-key → replaces its API key
 * Both return the plain API key once; it cannot be retrieved again.
 */
export const POST = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const params = new URL(request.url).searchParams;

  if (params.get('action') === 'rotate-key') {
    const id = parseObjectId(params.get('id'));
    if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid project id');
    if ((await ownedProject(db, user, id)) === null) return errorResponse(404, 'not_found', 'Project not found');
    const apiKey = await rotateApiKey(db, id);
    const project = await db.collection('projects').findOne({ _id: id });
    return json({ project: projectView(project), apiKey });
  }

  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const name = cleanProjectName(body.value && body.value.name);
  if (name === null) return errorResponse(400, 'invalid_name', 'Project name is required (max 80 characters)');
  if ((await db.collection('projects').countDocuments({ ownerId: user._id })) >= MAX_PROJECTS_PER_USER) {
    return errorResponse(403, 'project_limit', `You can have at most ${MAX_PROJECTS_PER_USER} projects. Delete one to create another.`);
  }
  const { project, apiKey } = await createProject(db, name, user._id);
  return json({ project: projectView(project), apiKey }, 201);
});

/** DELETE /api/projects?id=… — removes the project, its issues and events, and its API key. */
export const DELETE = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid project id');
  if ((await ownedProject(auth.db, auth.user, id)) === null) return errorResponse(404, 'not_found', 'Project not found');
  return json({ deleted: await deleteProject(auth.db, id) });
});
