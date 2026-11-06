/** Chat constants shared by the server (checks) and the browser (what to offer). */

/** The reactions offered first in the message menu: like, dislike, heart, laugh, fire, clap. A "+" opens the full palette. */
export const CHAT_REACTIONS = ['👍', '👎', '❤️', '😂', '🔥', '👏'] as const;

/** Most different reactions one message can carry (they are database keys, so the number is bounded). */
export const MAX_REACTION_KINDS = 20;

/** Longest accepted reaction (an emoji with skin tone and joiners is a few code points). */
const MAX_REACTION_LENGTH = 16;
const REACTION = /^\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?(?:\u200D\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?)*$/u;

/** A country flag (two regional indicators) and a region flag such as England (a black flag, tag letters, a cancel tag). */
const COUNTRY_FLAG = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const REGION_FLAG = /^\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}$/u;

/** Whether `value` is one emoji (any, not only the quick ones): what a person can react with. */
export function isReactionEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REACTION_LENGTH) return false;
  return REACTION.test(value) || COUNTRY_FLAG.test(value) || REGION_FLAG.test(value);
}

/** Emoji offered by the reaction bar's "+" and the message box, with names for screen readers. */
export const EMOJI_PALETTE: Array<[string, string]> = [
  ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['👏', 'clap'], ['🙏', 'thanks'], ['🙌', 'raised hands'], ['💪', 'strong'], ['👀', 'eyes'], ['🤝', 'handshake'],
  ['😀', 'grin'], ['😂', 'laughing'], ['🙂', 'smile'], ['😉', 'wink'], ['🤔', 'thinking'], ['😅', 'sweat smile'], ['😬', 'grimace'], ['😢', 'sad'],
  ['✅', 'done'], ['❌', 'no'], ['⚠️', 'warning'], ['❗', 'important'], ['❓', 'question'], ['🔥', 'fire'], ['🚀', 'ship it'], ['🎉', 'party'],
  ['🐛', 'bug'], ['🛠️', 'fixing'], ['🔍', 'investigating'], ['📌', 'pin'], ['📈', 'up'], ['📉', 'down'], ['⏳', 'waiting'], ['💡', 'idea'],
];

/** Characters of the quoted message shown inside a reply. */
export const REPLY_SNIPPET_LENGTH = 140;
