import { projectAccess, forbidden } from '../access.ts';
import { requireUser } from '../auth.ts';
import { cleanMentions, cleanMessageText, listMessages, markRead, messageViews, postMessage } from '../chat.ts';
import { CHAT_MESSAGES_PER_MINUTE, CHAT_RATE_WINDOW_MS, MAX_CHAT_MESSAGE_LENGTH } from '../constants.ts';
import { collections } from '../db.ts';
import { bodyObject, errorResponse, handle, json, parseObjectId, readJson } from '../http.ts';
import { projectUserIds } from '../members.ts';
import { publish, pusherConfigured } from '../pusher.ts';
import { consume } from '../rateLimit.ts';

const MAX_BODY_BYTES = MAX_CHAT_MESSAGE_LENGTH * 4 + 2048;

/**
 * GET /api/chat?projectId=…            the newest page of messages (oldest first) and marks the chat read
 *     &before=<messageId>              the page of older messages ending before it
 *     &after=<messageId>               everything newer (polling, catching up after a reconnect)
 * Returns `{ messages, hasMore, realtime }`; `realtime` says whether Pusher is set up (otherwise the browser polls).
 */
export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const params = new URL(request.url).searchParams;
  const projectId = parseObjectId(params.get('projectId'));
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  if ((await projectAccess(db, user, projectId)) === null) return errorResponse(404, 'not_found', 'Project not found');
  const before = params.get('before') ? parseObjectId(params.get('before')) : null;
  const after = params.get('after') ? parseObjectId(params.get('after')) : null;
  if ((params.get('before') && before === null) || (params.get('after') && after === null)) return errorResponse(400, 'invalid_id', 'Invalid message id');

  const { messages, hasMore } = await listMessages(db, projectId, { before, after });
  // Reading the newest page (not older history) means the chat is read; an empty poll changes nothing, so it writes nothing.
  if (before === null && (after === null || messages.length > 0)) await markRead(db, projectId, user._id);
  return json({ messages: await messageViews(db, messages), hasMore, realtime: pusherConfigured() });
});

/** POST /api/chat `{ projectId, text, mentions? }` — writes a message (`chat.post`) and tells everyone in the project's channel to fetch it. */
export const POST = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = bodyObject(body.value);
  const projectId = parseObjectId(input.projectId);
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  const access = await projectAccess(db, user, projectId);
  if (access === null) return errorResponse(404, 'not_found', 'Project not found');
  if (!access.can('chat.post')) return forbidden('chat.post');
  const text = cleanMessageText(input.text);
  if (text === null) return errorResponse(400, 'invalid_text', `A message is 1 to ${MAX_CHAT_MESSAGE_LENGTH} characters`);

  const budget = await consume(db, `chat:${user._id}`, 1, CHAT_MESSAGES_PER_MINUTE, CHAT_RATE_WINDOW_MS);
  if (!budget.allowed) return errorResponse(429, 'rate_limited', 'You are sending messages too fast', { 'Retry-After': String(budget.retryAfterSeconds) });

  const mentions = cleanMentions(input.mentions, await projectUserIds(db, access.project));
  const message = await postMessage(db, projectId, user._id, text, mentions);
  const [view] = await messageViews(db, [message]);
  await markRead(db, projectId, user._id);
  // Only the id goes over Pusher: browsers then fetch the text through the API, which checks access, so a removed member whose page is still open learns nothing.
  await publish(String(projectId), 'message', { id: view.id, projectId: view.projectId });
  return json({ message: view }, 201);
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

  await collections(db).chatMessages.updateOne({ _id: id }, { $set: { deletedAt: new Date(), text: '', mentions: [] } });
  await publish(String(message.projectId), 'message-deleted', { id: String(id), projectId: String(message.projectId) });
  return json({ deleted: true });
});
