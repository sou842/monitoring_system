import { ObjectId } from 'mongodb';
import { projectAccess } from '../access.ts';
import { requireUser } from '../auth.ts';
import { errorResponse, handle, json } from '../http.ts';
import { authorizeChannel, projectIdOfChannel } from '../pusher.ts';

const MAX_BODY_BYTES = 2048;

/**
 * POST /api/pusher/auth — Pusher private-channel authorisation (form body `socket_id`, `channel_name`).
 * Only a logged-in owner or member of the project may subscribe to its chat channel.
 */
export const POST = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return errorResponse(413, 'payload_too_large', 'Body too large');
  const form = new URLSearchParams(text);
  const socketId = form.get('socket_id') ?? '';
  const channel = form.get('channel_name') ?? '';
  if (!/^\d+\.\d+$/.test(socketId)) return errorResponse(400, 'invalid_socket', 'Invalid socket_id');
  const projectId = projectIdOfChannel(channel);
  if (projectId === null) return errorResponse(403, 'forbidden', 'Unknown channel');
  if ((await projectAccess(auth.db, auth.user, new ObjectId(projectId))) === null) return errorResponse(403, 'forbidden', 'No access to this project');
  const signed = authorizeChannel(socketId, channel, String(auth.user._id));
  if (signed === null) return errorResponse(503, 'realtime_not_configured', 'Realtime is not set up');
  return json(signed);
});
