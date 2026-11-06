import type { Db, ObjectId } from 'mongodb';
import { forbidden, projectAccess } from '../access.ts';
import { requireUser } from '../auth.ts';
import {
  changedMessages, cleanClientId, cleanIssueRefs, cleanMentions, cleanMessageText, cleanReplyTo, deleteMessage, editMessage, getMessage,
  listMessages, markRead, mentionsInText, messageViews, postMessage, toggleReaction,
} from '../chat.ts';
import { CHAT_ACTIONS_PER_MINUTE, CHAT_CHANGES_LIMIT, CHAT_MESSAGES_PER_MINUTE, CHAT_RATE_WINDOW_MS, CHAT_SYNC_OVERLAP_MS, MAX_CHAT_MESSAGE_LENGTH } from '../constants.ts';
import { collections } from '../db.ts';
import { bodyObject, errorResponse, handle, json, parseObjectId, readJson } from '../http.ts';
import { projectUserIds } from '../members.ts';
import { publish, pusherConfigured } from '../pusher.ts';
import { consume } from '../rateLimit.ts';

const MAX_BODY_BYTES = MAX_CHAT_MESSAGE_LENGTH * 4 + 2048;

/** Reactions, edits and deletes share one budget per user; a 429 response otherwise. */
async function actionBudget(db: Db, userId: ObjectId): Promise<Response | null> {
  const budget = await consume(db, `chat-action:${userId}`, 1, CHAT_ACTIONS_PER_MINUTE, CHAT_RATE_WINDOW_MS);
  return budget.allowed ? null : errorResponse(429, 'rate_limited', 'Too many changes, slow down a little', { 'Retry-After': String(budget.retryAfterSeconds) });
}

/** A sync cursor from the query string (ISO time or epoch ms), or null. */
function parseSince(value: string | null): Date | null {
  if (!value) return null;
  const date = /^\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * GET /api/chat?projectId=…            the newest page of messages (oldest first) and marks the chat read
 *     &before=<messageId>              the page of older messages ending before it
 *     &after=<messageId>               newer messages (polling, catching up after a reconnect); ask again while `hasMore`
 *     &since=<syncedAt>                (with `after`) also `changed`: loaded messages edited, reacted to or deleted since then
 *     &message=<messageId>             just that message (after a reaction or other change)
 * Returns `{ messages, changed, hasMore, realtime, lastReadAt, syncedAt }`; `realtime` says whether Pusher is set up
 * (otherwise the browser polls); `lastReadAt` (newest page only) is when you read the chat before this visit, to place
 * the "unread messages" divider (null = never read); `syncedAt` is the cursor to send as `since` next time.
 */
export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const params = new URL(request.url).searchParams;
  const projectId = parseObjectId(params.get('projectId'));
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  if ((await projectAccess(db, user, projectId)) === null) return errorResponse(404, 'not_found', 'Project not found');
  // Taken before reading, and moved back a little, so nothing saved during this request (or by a server whose clock lags) is skipped next time.
  const syncedAt = new Date(Date.now() - CHAT_SYNC_OVERLAP_MS);

  if (params.get('message')) {
    const id = parseObjectId(params.get('message'));
    if (id === null) return errorResponse(400, 'invalid_id', 'Invalid message id');
    const message = await getMessage(db, projectId, id);
    return json({ messages: message ? await messageViews(db, [message], user._id) : [], changed: [], hasMore: false, realtime: pusherConfigured(), lastReadAt: null, syncedAt });
  }

  const before = params.get('before') ? parseObjectId(params.get('before')) : null;
  const after = params.get('after') ? parseObjectId(params.get('after')) : null;
  const since = parseSince(params.get('since'));
  if ((params.get('before') && before === null) || (params.get('after') && after === null)) return errorResponse(400, 'invalid_id', 'Invalid message id');
  if (params.get('since') && since === null) return errorResponse(400, 'invalid_since', 'Invalid since');

  const [{ messages, hasMore }, changed] = await Promise.all([
    listMessages(db, projectId, { before, after }),
    since && before === null ? changedMessages(db, projectId, since, after) : Promise.resolve([]),
  ]);
  // Reading the newest page (not older history) means the chat is read; an empty poll changes nothing, so it writes nothing.
  let lastReadAt: Date | null = null;
  if (before === null && (after === null || messages.length > 0)) lastReadAt = await markRead(db, projectId, user._id);
  const [views, changedViews] = await Promise.all([messageViews(db, messages, user._id), messageViews(db, changed, user._id)]);
  // A full page of changes means there may be more: continue from the last one returned (not from now), and say so.
  const changesFull = changed.length === CHAT_CHANGES_LIMIT;
  const cursor = changesFull ? new Date((changed[changed.length - 1].updatedAt as Date).getTime() - 1) : syncedAt;
  return json({ messages: views, changed: changedViews, hasMore: hasMore || changesFull, realtime: pusherConfigured(), lastReadAt: after === null && before === null ? lastReadAt : null, syncedAt: cursor });
});

/**
 * POST /api/chat `{ projectId, text, mentions?, issues?, replyTo?, clientId? }` — writes a message (`chat.post`) and
 * tells everyone in the project's channel to fetch it. `issues`: ids of issues of this project to attach (`text` may
 * be empty then); `replyTo`: id of a message of this project being answered; `clientId`: the browser's id for this
 * send, so a retry after a lost answer returns the message saved the first time instead of saving it twice.
 *
 * POST /api/chat?action=react `{ id, emoji }` — adds your reaction to a message, or takes it away (`chat.post`).
 */
export const POST = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = bodyObject(body.value);

  if (new URL(request.url).searchParams.get('action') === 'react') {
    const id = parseObjectId(input.id);
    if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid message id');
    const message = await collections(db).chatMessages.findOne({ _id: id });
    const access = message ? await projectAccess(db, user, message.projectId) : null;
    if (message === null || access === null) return errorResponse(404, 'not_found', 'Message not found');
    if (!access.can('chat.post')) return forbidden('chat.post');
    const limited = await actionBudget(db, user._id);
    if (limited) return limited;
    if (!(await toggleReaction(db, message, user._id, input.emoji))) return errorResponse(400, 'invalid_reaction', 'Not an emoji, too many different reactions on this message, or the message was deleted');
    const updated = await getMessage(db, message.projectId, id);
    const [view] = updated ? await messageViews(db, [updated], user._id) : [];
    await publish(String(message.projectId), 'message-updated', { id: String(id), projectId: String(message.projectId) });
    return json({ message: view ?? null });
  }

  const projectId = parseObjectId(input.projectId);
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  const access = await projectAccess(db, user, projectId);
  if (access === null) return errorResponse(404, 'not_found', 'Project not found');
  if (!access.can('chat.post')) return forbidden('chat.post');
  const issueIds = await cleanIssueRefs(db, input.issues, projectId);
  const text = cleanMessageText(input.text, issueIds.length > 0);
  if (text === null) return errorResponse(400, 'invalid_text', `A message is 1 to ${MAX_CHAT_MESSAGE_LENGTH} characters`);

  const budget = await consume(db, `chat:${user._id}`, 1, CHAT_MESSAGES_PER_MINUTE, CHAT_RATE_WINDOW_MS);
  if (!budget.allowed) return errorResponse(429, 'rate_limited', 'You are sending messages too fast', { 'Retry-After': String(budget.retryAfterSeconds) });

  const mentions = cleanMentions(input.mentions, await projectUserIds(db, access.project));
  const replyToId = await cleanReplyTo(db, input.replyTo, projectId);
  const { message, duplicate } = await postMessage(db, projectId, user._id, text, { mentions, issueIds, replyToId, clientId: cleanClientId(input.clientId) });
  const [view] = await messageViews(db, [message], user._id);
  if (duplicate) return json({ message: view });
  await markRead(db, projectId, user._id);
  // Only the id goes over Pusher: browsers then fetch the text through the API, which checks access, so a removed member whose page is still open learns nothing.
  await publish(String(projectId), 'message', { id: view.id, projectId: view.projectId });
  return json({ message: view }, 201);
});

/**
 * PATCH /api/chat `{ id, text, issues? }` — edits your own message (`chat.post`). Who is mentioned is worked out again from the
 * new text ("@Name" of people in the project). `issues`, when sent, replaces the attached issues (omitted = unchanged).
 * A message with attached issues may have empty text. Shown as "edited".
 */
export const PATCH = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = bodyObject(body.value);
  const id = parseObjectId(input.id);
  if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid message id');
  const message = await collections(db).chatMessages.findOne({ _id: id });
  const access = message ? await projectAccess(db, user, message.projectId) : null;
  if (message === null || access === null) return errorResponse(404, 'not_found', 'Message not found');
  if (!message.userId.equals(user._id)) return errorResponse(403, 'forbidden', 'You can only edit your own messages');
  if (!access.can('chat.post')) return forbidden('chat.post');
  if (message.deletedAt) return errorResponse(409, 'deleted', 'This message was deleted');
  const oldIssueIds = message.issueIds ?? [];
  const issueIds = Array.isArray(input.issues) ? await cleanIssueRefs(db, input.issues, message.projectId) : oldIssueIds;
  const text = cleanMessageText(input.text, issueIds.length > 0);
  if (text === null) return errorResponse(400, 'invalid_text', `A message is 1 to ${MAX_CHAT_MESSAGE_LENGTH} characters`);

  const sameIssues = issueIds.length === oldIssueIds.length && issueIds.every((id, i) => id.equals(oldIssueIds[i]));
  if (text !== message.text || !sameIssues) {
    const limited = await actionBudget(db, user._id);
    if (limited) return limited;
    const peopleIds = await projectUserIds(db, access.project);
    const people = await collections(db).users.find({ _id: { $in: peopleIds } }, { projection: { name: 1 } }).toArray();
    if (!(await editMessage(db, message, text, mentionsInText(text, people), issueIds))) return errorResponse(409, 'deleted', 'This message was deleted');
    await publish(String(message.projectId), 'message-updated', { id: String(id), projectId: String(message.projectId) });
  }
  const updated = await getMessage(db, message.projectId, id);
  const [view] = updated ? await messageViews(db, [updated], user._id) : [];
  return json({ message: view ?? null });
});

/** DELETE /api/chat?id=… — deletes your own message (the project owner may delete anyone's). The text is removed, a "deleted" marker stays. */
export const DELETE = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid message id');
  const message = await collections(db).chatMessages.findOne({ _id: id });
  if (message === null) return errorResponse(404, 'not_found', 'Message not found');
  const access = await projectAccess(db, user, message.projectId);
  if (access === null) return errorResponse(404, 'not_found', 'Message not found');
  if (!message.userId.equals(user._id) && !access.isOwner) return forbidden('owner');
  if (message.deletedAt) return json({ deleted: true });
  const limited = await actionBudget(db, user._id);
  if (limited) return limited;

  await deleteMessage(db, id);
  await publish(String(message.projectId), 'message-deleted', { id: String(id), projectId: String(message.projectId) });
  return json({ deleted: true });
});
