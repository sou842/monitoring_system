import { ObjectId, type Db, type Filter } from 'mongodb';
import { CHAT_PAGE_SIZE, MAX_CHAT_ISSUES, MAX_CHAT_MENTIONS, MAX_CHAT_MESSAGE_LENGTH, MAX_UNREAD_COUNT } from './constants.ts';
import { collections } from './db.ts';
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
  createdAt: Date;
  deleted: boolean;
}

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

/** Messages as the browser sees them, with author names and the attached issues as they are now. */
export async function messageViews(db: Db, messages: ChatMessageDoc[]): Promise<ChatMessageView[]> {
  const ids = [...new Set(messages.map((m) => String(m.userId)))].map((id) => new ObjectId(id));
  const issueIds = [...new Set(messages.flatMap((m) => (m.deletedAt ? [] : (m.issueIds ?? []).map(String))))].map((id) => new ObjectId(id));
  const [users, issues] = await Promise.all([
    collections(db).users.find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray(),
    issueIds.length === 0 ? [] : collections(db).issues.find({ _id: { $in: issueIds } }, { projection: { eventType: 1, errorType: 1, message: 1, status: 1, count: 1 } }).toArray(),
  ]);
  return messages.map((m) => ({
    id: String(m._id),
    projectId: String(m.projectId),
    userId: String(m.userId),
    userName: users.find((u) => u._id.equals(m.userId))?.name ?? null,
    text: m.deletedAt ? '' : m.text,
    mentions: m.deletedAt ? [] : m.mentions.map(String),
    issues: m.deletedAt ? [] : (m.issueIds ?? []).flatMap((id) => {
      const i = issues.find((x) => x._id.equals(id));
      return i ? [{ id: String(i._id), eventType: i.eventType, errorType: i.errorType, message: i.message, status: i.status, count: i.count }] : [];
    }),
    createdAt: m.createdAt,
    deleted: Boolean(m.deletedAt),
  }));
}

/**
 * A page of a project's messages, oldest first. `before`: older history (the page
 * ending just before that id); `after`: everything newer than that id (polling and
 * catching up after a reconnect). Neither: the newest page.
 */
export async function listMessages(db: Db, projectId: ObjectId, options: { before?: ObjectId | null; after?: ObjectId | null } = {}): Promise<{ messages: ChatMessageDoc[]; hasMore: boolean }> {
  const c = collections(db);
  if (options.after) {
    const messages = await c.chatMessages.find({ projectId, _id: { $gt: options.after } }).sort({ _id: 1 }).limit(CHAT_PAGE_SIZE * 4).toArray();
    return { messages, hasMore: false };
  }
  const filter: Filter<ChatMessageDoc> = options.before ? { projectId, _id: { $lt: options.before } } : { projectId };
  const newest = await c.chatMessages.find(filter).sort({ _id: -1 }).limit(CHAT_PAGE_SIZE + 1).toArray();
  return { messages: newest.slice(0, CHAT_PAGE_SIZE).reverse(), hasMore: newest.length > CHAT_PAGE_SIZE };
}

/** Saves a new message. */
export async function postMessage(db: Db, projectId: ObjectId, userId: ObjectId, text: string, mentions: ObjectId[], issueIds: ObjectId[] = [], now = new Date()): Promise<ChatMessageDoc> {
  const message: ChatMessageDoc = { _id: new ObjectId(), projectId, userId, text, mentions, issueIds, createdAt: now };
  await collections(db).chatMessages.insertOne(message);
  return message;
}

/** Records that the user has read the project's chat up to now. */
export async function markRead(db: Db, projectId: ObjectId, userId: ObjectId, now = new Date()): Promise<void> {
  await collections(db).chatReads.updateOne({ projectId, userId }, { $set: { lastReadAt: now }, $setOnInsert: { _id: new ObjectId() } }, { upsert: true });
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
    if (read) filter.createdAt = { $gt: read.lastReadAt };
    const n = await c.chatMessages.countDocuments(filter, { limit: MAX_UNREAD_COUNT + 1 });
    if (n > 0) counts.set(String(projectId), n);
  }));
  return counts;
}
