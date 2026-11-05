import { ObjectId, type Db } from 'mongodb';
import type { UserProfile, UserView } from '../lib/types.ts';
import { MAX_EMAIL_LENGTH, MAX_PROFILE_FIELD_LENGTH, MAX_USER_NAME_LENGTH, MONGO_DUPLICATE_KEY } from './constants.ts';
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

export const PROFILE_FIELDS = ['jobTitle', 'company', 'phone', 'location', 'timezone', 'bio', 'linkedin', 'github', 'website'] as const;
/** Link fields and the host each must belong to (`null` = any site). */
const LINK_HOSTS: Record<string, string | null> = { linkedin: 'linkedin.com', github: 'github.com', website: null };

/** Normalised http(s) URL (https:// is added when missing), or null when it isn't a web link on the expected host. */
function cleanLink(value: string, host: string | null): string | null {
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (host !== null && url.hostname !== host && !url.hostname.endsWith(`.${host}`)) return null;
    if (host === null && !url.hostname.includes('.')) return null;
    return url.href;
  } catch {
    return null;
  }
}
const PHONE_PATTERN = /^[+\d][\d\s().-]*$/;

/**
 * Validates the optional profile fields in a request body. Fields that are absent are left out of the result
 * (so a PATCH only changes what it sends); empty strings clear a field. Returns an error message when a value is invalid.
 */
export function cleanProfile(input: Record<string, unknown>): { profile: Partial<UserProfile> } | { error: string } {
  const profile: Partial<UserProfile> = {};
  for (const field of PROFILE_FIELDS) {
    if (!(field in input)) continue;
    const raw = input[field];
    if (typeof raw !== 'string') return { error: `${field} must be text` };
    // Bio keeps line breaks; everything else is one line.
    let value = field === 'bio' ? raw.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : raw.trim().replace(/\s+/g, ' ');
    if (field in LINK_HOSTS && value !== '') {
      const link = cleanLink(value, LINK_HOSTS[field]);
      if (link === null) return { error: `Enter a valid ${field === 'website' ? 'website' : field === 'github' ? 'GitHub' : 'LinkedIn'} link` };
      value = link;
    }
    if (value.length > MAX_PROFILE_FIELD_LENGTH[field]) return { error: `${field} is too long (max ${MAX_PROFILE_FIELD_LENGTH[field]} characters)` };
    if (field === 'phone' && value !== '' && !PHONE_PATTERN.test(value)) return { error: 'Enter a valid phone number' };
    if (field === 'timezone' && value !== '' && !isTimezone(value)) return { error: 'Choose a valid time zone' };
    profile[field] = value;
  }
  return { profile };
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
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

/** What admins see of another account: no profile details (phone, links…), those belong to the user. */
export function adminUserView(user: UserDoc): Omit<UserView, 'profile'> {
  const { profile: _profile, ...rest } = userView(user);
  return rest;
}

/** The user's own shape (never includes the password hash or session version). */
export function userView(user: UserDoc): UserView {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    profile: { jobTitle: '', company: '', phone: '', location: '', timezone: '', bio: '', linkedin: '', github: '', website: '', ...user.profile },
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}
