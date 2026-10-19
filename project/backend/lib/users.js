import { MAX_EMAIL_LENGTH, MAX_USER_NAME_LENGTH, MONGO_DUPLICATE_KEY } from './constants.js';
import { hashPassword } from './passwords.js';

/**
 * Dashboard accounts. Anyone can sign up; each user only ever sees the
 * projects they own. `sessionVersion` is part of every session cookie:
 * bumping it (password change, "log out other devices", disabling the
 * account) invalidates every cookie issued before.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lower-cased, trimmed email, or null when it isn't a plausible address. */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}

/** Display name with whitespace collapsed, or null when empty or too long. */
export function cleanUserName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length > 0 && name.length <= MAX_USER_NAME_LENGTH ? name : null;
}

/** Creates an account. Returns the user, or null when the email is already registered. */
export async function createUser(db, { email, name, password }, now = new Date()) {
  const doc = {
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
    const { insertedId } = await db.collection('users').insertOne(doc);
    return { _id: insertedId, ...doc };
  } catch (error) {
    if (error.code === MONGO_DUPLICATE_KEY) return null;
    throw error;
  }
}

/** Public shape of a user (never includes the password hash or session version). */
export function userView(user) {
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
