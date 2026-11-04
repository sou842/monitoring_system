/** Chat constants shared by the server (checks) and the browser (what to offer). */

/** The emoji a message can be reacted to with (a fixed set: they are used as database keys). */
export const CHAT_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const;
export type ChatReaction = (typeof CHAT_REACTIONS)[number];

/** Whether `value` is one of the allowed reaction emoji. */
export function isChatReaction(value: unknown): value is ChatReaction {
  return typeof value === 'string' && (CHAT_REACTIONS as readonly string[]).includes(value);
}

/** Characters of the quoted message shown inside a reply. */
export const REPLY_SNIPPET_LENGTH = 140;
