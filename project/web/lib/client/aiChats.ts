import type { UIMessage } from 'ai';

/**
 * Saved "Ask AI" chats, in this browser's IndexedDB: one chat per user and
 * issue, only the most recent AI_CHATS_PER_USER per user, each removed after
 * AI_CHAT_MAX_AGE_MS without being opened or getting a new message. Chats are not cleared on logout;
 * they are keyed by user id, so another account on the same browser can't load them.
 * Every function fails quietly (private windows, blocked storage, old browsers):
 * the chat then just isn't saved.
 */

const DB_NAME = 'et_ai_chats';
const DB_VERSION = 1;
/** Chat messages, by key. */
const STORE = 'chats';
/** Small records { key, userId, updatedAt } so pruning never reads the messages. */
const META = 'meta';
/** Chats kept per user (newest message first); older ones are deleted. */
export const AI_CHATS_PER_USER = 30;
/** A chat not opened and with no new message for this many days is deleted. */
export const AI_CHAT_MAX_AGE_DAYS = 45;
export const AI_CHAT_MAX_AGE_MS = AI_CHAT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
/** Messages kept per chat (same as the server's history limit, AI_MAX_HISTORY_MESSAGES). */
export const AI_CHAT_MAX_MESSAGES = 40;

export interface ChatMeta {
  /** `${userId}:${issueId}` */
  key: string;
  userId: string;
  /** When the newest message was saved (ms since epoch). */
  updatedAt: number;
  /** When the chat was last opened (ms since epoch); missing on chats saved before this field existed. */
  openedAt?: number;
  /** Assistant-page chats: the first question, for the history list. */
  title?: string;
}

export interface SavedChat {
  /** `${userId}:${issueId}` */
  key: string;
  userId: string;
  issueId: string;
  messages: UIMessage[];
  /** When the newest message was saved (ms since epoch). */
  updatedAt: number;
}

/** The last time a chat was opened or written to: its age for expiry. */
export function lastUsedAt(chat: Pick<ChatMeta, 'updatedAt' | 'openedAt'>): number {
  return Math.max(chat.updatedAt, typeof chat.openedAt === 'number' ? chat.openedAt : 0);
}

/**
 * Identifies a chat's content: messages only ever get appended, and a finished
 * message never changes, so count + last id says whether it differs from what
 * is stored. Lets the panel skip saving a chat it just restored (which would
 * renew its age and recency just because the issue was opened).
 */
export function chatSignature(messages: ReadonlyArray<Pick<UIMessage, 'id'>>): string {
  return `${messages.length}:${messages.length > 0 ? messages[messages.length - 1].id : ''}`;
}

/** Keys of the chats to delete: expired ones, and per user everything after the newest `perUser`. */
export function chatsToPrune(
  chats: readonly ChatMeta[],
  now: number,
  perUser = AI_CHATS_PER_USER,
  maxAge = AI_CHAT_MAX_AGE_MS,
): string[] {
  const drop: string[] = [];
  const kept = new Map<string, ChatMeta[]>();
  for (const chat of chats) {
    if (!(now - lastUsedAt(chat) < maxAge)) { drop.push(chat.key); continue; }
    const list = kept.get(chat.userId) ?? [];
    list.push(chat);
    kept.set(chat.userId, list);
  }
  for (const list of kept.values()) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const chat of list.slice(perUser)) drop.push(chat.key);
  }
  return drop;
}

function chatKey(userId: string, issueId: string): string {
  return `${userId}:${issueId}`;
}

const ASSISTANT_PREFIX = 'assistant:';

/** Assistant-page chats are stored like issue chats, under `assistant:<chatId>` instead of an issue id. */
export function assistantChatKey(chatId: string): string {
  return `${ASSISTANT_PREFIX}${chatId}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the database: let it, and open again next time.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * The saved chat of this user on this issue, or null (none, expired, or storage
 * unavailable). Opening it renews its age (`openedAt`), not its recency (`updatedAt`).
 */
export async function loadChat(userId: string, issueId: string): Promise<UIMessage[] | null> {
  try {
    const db = await openDb();
    const tx = db.transaction([STORE, META], 'readonly');
    const key = chatKey(userId, issueId);
    const [chat, info] = await Promise.all([
      done(tx.objectStore(STORE).get(key)) as Promise<SavedChat | undefined>,
      done(tx.objectStore(META).get(key)) as Promise<ChatMeta | undefined>,
    ]);
    // The meta record carries `openedAt`; the chat record alone only knows its last message.
    if (!chat || !Array.isArray(chat.messages) || !(Date.now() - lastUsedAt(info ?? chat) < AI_CHAT_MAX_AGE_MS)) return null;
    if (info) void touchChat(db, info);
    return chat.messages;
  } catch {
    return null;
  }
}

/** Records that a chat was opened, on its small meta record only. Best effort: a failure never hides the chat. */
async function touchChat(db: IDBDatabase, info: ChatMeta): Promise<void> {
  try {
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put({ ...info, openedAt: Date.now() } satisfies ChatMeta);
    await finished(tx);
  } catch {
    // Not renewed; it still expires AI_CHAT_MAX_AGE_DAYS after its last message.
  }
}

/** Saves the chat (its last AI_CHAT_MAX_MESSAGES messages), then prunes old chats. An empty chat deletes it. */
export async function saveChat(userId: string, issueId: string, messages: readonly UIMessage[], title?: string): Promise<void> {
  if (messages.length === 0) return deleteChat(userId, issueId);
  try {
    const db = await openDb();
    const tx = db.transaction([STORE, META], 'readwrite');
    const store = tx.objectStore(STORE);
    const meta = tx.objectStore(META);
    const now = Date.now();
    const key = chatKey(userId, issueId);
    const chat: SavedChat = { key, userId, issueId, messages: messages.slice(-AI_CHAT_MAX_MESSAGES), updatedAt: now };
    store.put(chat);
    meta.put({ key, userId, updatedAt: now, ...(title ? { title } : {}) } satisfies ChatMeta);
    const all = await done(meta.getAll()) as ChatMeta[];
    for (const old of chatsToPrune(all, now)) { store.delete(old); meta.delete(old); }
    await finished(tx);
  } catch {
    // Not saved; the chat still works for this page.
  }
}

/** One saved assistant-page chat, for the history list. */
export interface AssistantChatInfo {
  chatId: string;
  title: string;
  updatedAt: number;
}

/** This user's saved assistant-page chats, newest first (reads only the small meta records). */
export async function listAssistantChats(userId: string): Promise<AssistantChatInfo[]> {
  try {
    const db = await openDb();
    const prefix = chatKey(userId, ASSISTANT_PREFIX);
    const all = await done(db.transaction(META, 'readonly').objectStore(META).getAll()) as ChatMeta[];
    const now = Date.now();
    return all
      .filter((m) => m.userId === userId && m.key.startsWith(prefix) && now - lastUsedAt(m) < AI_CHAT_MAX_AGE_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => ({ chatId: m.key.slice(prefix.length), title: m.title || 'Untitled chat', updatedAt: m.updatedAt }));
  } catch {
    return [];
  }
}

/** Deletes the saved chat of this user on this issue ("New chat"). */
export async function deleteChat(userId: string, issueId: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([STORE, META], 'readwrite');
    const key = chatKey(userId, issueId);
    tx.objectStore(STORE).delete(key);
    tx.objectStore(META).delete(key);
    await finished(tx);
  } catch {
    // Nothing to do.
  }
}
