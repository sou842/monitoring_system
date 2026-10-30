import { ObjectId, type Db } from 'mongodb';
import type { UserView } from '../lib/types.ts';
import { MAX_EMAIL_LENGTH, MAX_USER_NAME_LENGTH, MONGO_DUPLICATE_KEY } from './constants.ts';
import { collections } from './db.ts';
import type { UserDoc } from './models.ts';
import { hashPassword } from './passwords.ts';

/**
 * Dashboard accounts. Anyone can sign up; each user only ever sees the
 * projects they own. `sessionVersion` is part of every session cookie:
 * bumping it (password change, "log out other devices", disabling the
 * account) invalidates every cookie issued before.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lower-cased, trimmed email, or null when it isn't a plausible address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}

/** Display name with whitespace collapsed, or null when empty or too long. */
export function cleanUserName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length > 0 && name.length <= MAX_USER_NAME_LENGTH ? name : null;
}

/** Creates an account. Returns the user, or null when the email is already registered. */
export async function createUser(db: Db, { email, name, password }: { email: string; name: string; password: string }, now = new Date()): Promise<UserDoc | null> {
  const doc: UserDoc = {
    _id: new ObjectId(),
    email,
    name,
    passwordHash: await hashPassword(password),
    role: 'user',
    status: 'active',
    sessionVersion: 1,
    createdAt: now,
    lastLoginAt: now,
  };
  try {
    await collections(db).users.insertOne(doc);
    return doc;
  } catch (error) {
    if (isDuplicateKey(error)) return null;
    throw error;
  }
}

/** True for MongoDB's unique-index violation. */
export function isDuplicateKey(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === MONGO_DUPLICATE_KEY;
}

/** Public shape of a user (never includes the password hash or session version). */
export function userView(user: UserDoc): UserView {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}
