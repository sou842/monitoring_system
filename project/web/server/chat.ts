import { ObjectId, type Db, type Filter } from 'mongodb';
import { isChatReaction, REPLY_SNIPPET_LENGTH } from '../lib/chat.ts';
import { CHAT_CATCH_UP_LIMIT, CHAT_CHANGES_LIMIT, CHAT_PAGE_SIZE, MAX_CHAT_CLIENT_ID_LENGTH, MAX_CHAT_ISSUES, MAX_CHAT_MENTIONS, MAX_CHAT_MESSAGE_LENGTH, MAX_UNREAD_COUNT } from './constants.ts';
import { collections } from './db.ts';
import { escapeRegex } from './http.ts';
import type { ChatMessageDoc } from './models.ts';

/** Project chat (docs/MEMBERS_AND_CHAT.md): one channel per project, plain-text messages. */

/** An issue attached to a message, as it is now (its status and count change). */
export interface ChatIssueView {
  id: string;
  eventType: string;
  errorType: string;
  message: string;
  status: string;
  count: number;
}

/** The message a reply quotes. */
export interface ChatReplyView {
  id: string;
  /** Who wrote the quoted message (the quote is drawn in their colour). */
  userId: string;
  userName: string | null;
  /** First characters of the quoted text (empty when deleted or issue-only). */
  text: string;
  deleted: boolean;
  /** The quoted message carries issues (shown as "Issue" when it has no text). */
  hasIssues: boolean;
}

/** One emoji on a message: how many people, whether you are one of them, and who (first names). */
export interface ChatReactionView {
  emoji: string;
  count: number;
  mine: boolean;
  names: string[];
}

export interface ChatMessageView {
  id: string;
  projectId: string;
  userId: string;
  /** Null when the author's account was deleted. */
  userName: string | null;
  /** Empty for a deleted message. */
  text: string;
  mentions: string[];
  /** Attached issues that still exist (deleted ones are left out). */
  issues: ChatIssueView[];
  /** The message this one answers (null when it is not a reply, or the original is gone). */
  replyTo: ChatReplyView | null;
  reactions: ChatReactionView[];
  createdAt: Date;
  /** When the author last edited the text (null = never). */
  editedAt: Date | null;
  deleted: boolean;
}

/** Names listed in a reaction's tooltip. */
const REACTION_NAMES_SHOWN = 10;

/** The text of a new message: trimmed, control characters (except new lines and tabs) removed, or null when it isn't text, is too long, or is empty (unless `allowEmpty`: a message that is only attached issues). */
export function cleanMessageText(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return (text.length === 0 && !allowEmpty) || text.length > MAX_CHAT_MESSAGE_LENGTH ? null : text;
}

/** Mentioned user ids that really are people of the project (unknown or repeated ids dropped). */
export function cleanMentions(value: unknown, people: ObjectId[]): ObjectId[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(people.map(String));
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && known.has(v)))].slice(0, MAX_CHAT_MENTIONS).map((id) => new ObjectId(id));
}

/** Attached issue ids that really are issues of this project (junk, repeats and other projects' issues dropped). */
export async function cleanIssueRefs(db: Db, value: unknown, projectId: ObjectId): Promise<ObjectId[]> {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.filter((v): v is string => typeof v === 'string' && ObjectId.isValid(v) && v.length === 24))].slice(0, MAX_CHAT_ISSUES).map((id) => new ObjectId(id));
  if (ids.length === 0) return [];
  const found = await collections(db).issues.find({ _id: { $in: ids }, projectId }, { projection: { _id: 1 } }).toArray();
  return ids.filter((id) => found.some((f) => f._id.equals(id)));
}

/** The id of the message being answered, when it is a message of this project (otherwise null). */
export async function cleanReplyTo(db: Db, value: unknown, projectId: ObjectId): Promise<ObjectId | null> {
  if (typeof value !== 'string' || !ObjectId.isValid(value) || value.length !== 24) return null;
  const found = await collections(db).chatMessages.findOne({ _id: new ObjectId(value), projectId }, { projection: { _id: 1 } });
  return found ? found._id : null;
}

/** Messages as `viewerId` sees them: author names, attached issues as they are now, the quoted message and reactions. */
export async function messageViews(db: Db, messages: ChatMessageDoc[], viewerId: ObjectId): Promise<ChatMessageView[]> {
  const c = collections(db);
  const issueIds = [...new Set(messages.flatMap((m) => (m.deletedAt ? [] : (m.issueIds ?? []).map(String))))].map((id) => new ObjectId(id));
  const replyIds = [...new Set(messages.flatMap((m) => (m.replyToId ? [String(m.replyToId)] : [])))].map((id) => new ObjectId(id));
  const quoted = replyIds.length === 0 ? [] : await c.chatMessages.find({ _id: { $in: replyIds } }).toArray();
  // Everyone whose name is needed: authors, quoted authors and the people who reacted.
  const userIds = new Map<string, ObjectId>();
  for (const m of [...messages, ...quoted]) {
    userIds.set(String(m.userId), m.userId);
    if (!m.deletedAt) for (const list of Object.values(m.reactions ?? {})) for (const id of list) userIds.set(String(id), id);
  }
  const [users, issues] = await Promise.all([
    c.users.find({ _id: { $in: [...userIds.values()] } }, { projection: { name: 1 } }).toArray(),
    issueIds.length === 0 ? [] : c.issues.find({ _id: { $in: issueIds } }, { projection: { eventType: 1, errorType: 1, message: 1, status: 1, count: 1 } }).toArray(),
  ]);
  const nameOf = (id: ObjectId) => users.find((u) => u._id.equals(id))?.name ?? null;

  return messages.map((m) => {
    const original = m.replyToId ? quoted.find((q) => q._id.equals(m.replyToId as ObjectId)) : undefined;
    return {
      id: String(m._id),
      projectId: String(m.projectId),
      userId: String(m.userId),
      userName: nameOf(m.userId),
      text: m.deletedAt ? '' : m.text,
      mentions: m.deletedAt ? [] : m.mentions.map(String),
      issues: m.deletedAt ? [] : (m.issueIds ?? []).flatMap((id) => {
        const i = issues.find((x) => x._id.equals(id));
        return i ? [{ id: String(i._id), eventType: i.eventType, errorType: i.errorType, message: i.message, status: i.status, count: i.count }] : [];
      }),
      replyTo: m.deletedAt || !original ? null : {
        id: String(original._id),
        userId: String(original.userId),
        userName: nameOf(original.userId),
        text: original.deletedAt ? '' : original.text.slice(0, REPLY_SNIPPET_LENGTH),
        deleted: Boolean(original.deletedAt),
        hasIssues: !original.deletedAt && (original.issueIds ?? []).length > 0,
      },
      reactions: m.deletedAt ? [] : Object.entries(m.reactions ?? {}).filter(([, list]) => list.length > 0).map(([emoji, list]) => ({
        emoji,
        count: list.length,
        mine: list.some((id) => id.equals(viewerId)),
        names: list.slice(0, REACTION_NAMES_SHOWN).map((id) => nameOf(id) ?? 'Deleted user'),
      })),
      createdAt: m.createdAt,
      editedAt: m.deletedAt ? null : m.editedAt ?? null,
      deleted: Boolean(m.deletedAt),
    };
  });
}

/**
 * A page of a project's messages, oldest first. `before`: older history (the page
 * ending just before that id); `after`: everything newer than that id (polling and
 * catching up after a reconnect). Neither: the newest page.
 */
export async function listMessages(db: Db, projectId: ObjectId, options: { before?: ObjectId | null; after?: ObjectId | null } = {}): Promise<{ messages: ChatMessageDoc[]; hasMore: boolean }> {
  const c = collections(db);
  if (options.after) {
    const newer = await c.chatMessages.find({ projectId, _id: { $gt: options.after } }).sort({ _id: 1 }).limit(CHAT_CATCH_UP_LIMIT + 1).toArray();
    return { messages: newer.slice(0, CHAT_CATCH_UP_LIMIT), hasMore: newer.length > CHAT_CATCH_UP_LIMIT };
  }
  const filter: Filter<ChatMessageDoc> = options.before ? { projectId, _id: { $lt: options.before } } : { projectId };
  const newest = await c.chatMessages.find(filter).sort({ _id: -1 }).limit(CHAT_PAGE_SIZE + 1).toArray();
  return { messages: newest.slice(0, CHAT_PAGE_SIZE).reverse(), hasMore: newest.length > CHAT_PAGE_SIZE };
}

/**
 * Messages of the project changed (edited, reacted to, deleted) after `since`, up to `upTo` (the ones the
 * browser already has, at most CHAT_CHANGES_LIMIT, oldest change first). Messages newer than `upTo` come
 * through `after=` instead.
 */
export function changedMessages(db: Db, projectId: ObjectId, since: Date, upTo: ObjectId | null): Promise<ChatMessageDoc[]> {
  const filter: Filter<ChatMessageDoc> = { projectId, updatedAt: { $exists: true, $gt: since } };
  if (upTo) filter._id = { $lte: upTo };
  return collections(db).chatMessages.find(filter).sort({ updatedAt: 1 }).limit(CHAT_CHANGES_LIMIT).toArray();
}

/** A client id for de-duplicating sends: a short string of safe characters, else null. */
export function cleanClientId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CHAT_CLIENT_ID_LENGTH && /^[\w-]+$/.test(value) ? value : null;
}

/**
 * The people of the project whose "@Name" appears in `text`, matched the way the message renderer does
 * (lib/chatText.ts: longest names first, so "@Ann Lee" wins over "@Ann"; not followed by a word character).
 * Used when a message is edited: the text is then the source of truth for who is mentioned.
 */
export function mentionsInText(text: string, people: Array<{ _id: ObjectId; name: string }>): ObjectId[] {
  const named = people.filter((p) => p.name).sort((a, b) => b.name.length - a.name.length);
  if (named.length === 0) return [];
  const pattern = new RegExp(`@(${named.map((p) => escapeRegex(p.name)).join('|')})(?![\\w])`, 'g');
  const found = new Map<string, ObjectId>();
  for (const match of text.matchAll(pattern)) {
    const person = named.find((p) => p.name === match[1]);
    if (person) found.set(String(person._id), person._id);
  }
  return [...found.values()].slice(0, MAX_CHAT_MENTIONS);
}

/** One message of the project, or null. */
export function getMessage(db: Db, projectId: ObjectId, id: ObjectId): Promise<ChatMessageDoc | null> {
  return collections(db).chatMessages.findOne({ _id: id, projectId });
}

/** Saves a new message. */
export async function postMessage(
  db: Db, projectId: ObjectId, userId: ObjectId, text: string,
  extras: { mentions?: ObjectId[]; issueIds?: ObjectId[]; replyToId?: ObjectId | null; clientId?: string | null } = {}, now = new Date(),
): Promise<{ message: ChatMessageDoc; duplicate: boolean }> {
  const message: ChatMessageDoc = { _id: new ObjectId(), projectId, userId, text, mentions: extras.mentions ?? [], issueIds: extras.issueIds ?? [], createdAt: now };
  if (extras.replyToId) message.replyToId = extras.replyToId;
  if (extras.clientId) message.clientId = extras.clientId;
  const c = collections(db);
  try {
    await c.chatMessages.insertOne(message);
  } catch (error) {
    // The same send arrived before (the browser retried after losing the answer): return the saved message.
    if (extras.clientId && (error as { code?: unknown }).code === 11000) {
      const saved = await c.chatMessages.findOne({ userId, clientId: extras.clientId });
      if (saved && saved.projectId.equals(projectId)) return { message: saved, duplicate: true };
    }
    throw error;
  }
  return { message, duplicate: false };
}

/** Saves the author's new text (and who it mentions). Returns false when the message was deleted meanwhile. */
export async function editMessage(db: Db, message: ChatMessageDoc, text: string, mentions: ObjectId[], now = new Date()): Promise<boolean> {
  const result = await collections(db).chatMessages.updateOne(
    { _id: message._id, deletedAt: { $exists: false } },
    { $set: { text, mentions, editedAt: now, updatedAt: now } },
  );
  return result.matchedCount === 1;
}

/** Removes a message's content for everyone; a "deleted" marker stays. */
export async function deleteMessage(db: Db, id: ObjectId, now = new Date()): Promise<void> {
  await collections(db).chatMessages.updateOne({ _id: id }, { $set: { deletedAt: now, updatedAt: now, text: '', mentions: [] }, $unset: { reactions: '', issueIds: '', editedAt: '' } });
}

/** Adds `userId`'s `emoji` to a message, or takes it away when it is already there. Returns false for an unknown emoji or a deleted message. */
export async function toggleReaction(db: Db, message: ChatMessageDoc, userId: ObjectId, emoji: unknown, now = new Date()): Promise<boolean> {
  if (!isChatReaction(emoji) || message.deletedAt) return false;
  const c = collections(db);
  const key = `reactions.${emoji}`;
  const removed = await c.chatMessages.updateOne({ _id: message._id, [key]: userId }, { $pull: { [key]: userId }, $set: { updatedAt: now } });
  if (removed.modifiedCount === 0) await c.chatMessages.updateOne({ _id: message._id, deletedAt: { $exists: false } }, { $addToSet: { [key]: userId }, $set: { updatedAt: now } });
  return true;
}

/** Records that the user has read the project's chat up to now; returns the previous read time (null = never read). */
export async function markRead(db: Db, projectId: ObjectId, userId: ObjectId, now = new Date()): Promise<Date | null> {
  const previous = await collections(db).chatReads.findOneAndUpdate({ projectId, userId }, { $set: { lastReadAt: now }, $setOnInsert: { _id: new ObjectId() } }, { upsert: true, returnDocument: 'before' });
  return previous ? previous.lastReadAt : null;
}

/** When the user last read the chat (null = never), without changing it. */
export async function lastRead(db: Db, projectId: ObjectId, userId: ObjectId): Promise<Date | null> {
  const row = await collections(db).chatReads.findOne({ projectId, userId });
  return row ? row.lastReadAt : null;
}

/**
 * Unread messages per project (by project id string): messages by others, not
 * deleted, newer than the user's last read. Capped at MAX_UNREAD_COUNT + 1, so
 * the badge can say "99+".
 */
export async function unreadCounts(db: Db, userId: ObjectId, projectIds: ObjectId[]): Promise<Map<string, number>> {
  const c = collections(db);
  const reads = await c.chatReads.find({ userId, projectId: { $in: projectIds } }).toArray();
  const counts = new Map<string, number>();
  await Promise.all(projectIds.map(async (projectId) => {
    const read = reads.find((r) => r.projectId.equals(projectId));
    const filter: Filter<ChatMessageDoc> = { projectId, userId: { $ne: userId }, deletedAt: { $exists: false } };
    // The _id bound lets the { projectId, _id } index skip everything read (ids start with their creation second).
    if (read) { filter._id = { $gte: ObjectId.createFromTime(Math.floor(read.lastReadAt.getTime() / 1000)) }; filter.createdAt = { $gt: read.lastReadAt }; }
    const n = await c.chatMessages.countDocuments(filter, { limit: MAX_UNREAD_COUNT + 1 });
    if (n > 0) counts.set(String(projectId), n);
  }));
  return counts;
}
