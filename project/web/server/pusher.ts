import Pusher from 'pusher';

/**
 * Pusher Channels for the project chat (docs/MEMBERS_AND_CHAT.md). Each project
 * has one private channel; the server triggers events after saving, browsers
 * subscribe after `/api/pusher/auth` checks membership. Without the env vars the
 * chat still works: the browser polls instead. Pusher failures never fail a
 * request (the message is already saved; a poll or reconnect picks it up).
 */

let client: Pusher | null | undefined;

function pusher(): Pusher | null {
  if (client !== undefined) return client;
  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
  client = appId && key && secret && cluster ? new Pusher({ appId, key, secret, cluster, useTLS: true }) : null;
  return client;
}

/** Whether realtime delivery is set up on this server. */
export function pusherConfigured(): boolean {
  return pusher() !== null;
}

/** The private channel of a project's chat. */
export function chatChannel(projectId: string): string {
  return `private-project-${projectId}`;
}

/** The project id inside a chat channel name (the private message channel or the presence channel), or null for any other channel. */
export function projectIdOfChannel(channel: string): string | null {
  const match = /^(?:private|presence)-project-([0-9a-f]{24})$/.exec(channel);
  return match ? match[1] : null;
}

/** Sends `event` with `data` to everyone subscribed to the project's chat. Never throws. */
export async function publish(projectId: string, event: string, data: unknown): Promise<void> {
  const p = pusher();
  if (p === null) return;
  try {
    await p.trigger(chatChannel(projectId), event, data);
  } catch (error) {
    console.error('[pusher] trigger failed', error instanceof Error ? error.message : 'unknown error');
  }
}

/**
 * Signs a channel subscription for one socket, or null when Pusher isn't configured. On the presence channel
 * (who is online, "is typing") the person's user id is part of the signature, so nobody can claim another id.
 */
export function authorizeChannel(socketId: string, channel: string, userId: string): Pusher.ChannelAuthResponse | null {
  const p = pusher();
  if (p === null) return null;
  return channel.startsWith('presence-') ? p.authorizeChannel(socketId, channel, { user_id: userId }) : p.authorizeChannel(socketId, channel);
}
