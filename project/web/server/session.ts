import { cookies } from 'next/headers';
import { DEV_USER, userForSessionToken } from './auth.ts';
import { SESSION_COOKIE } from './constants.ts';
import { getDb } from './db.ts';
import type { UserDoc } from './models.ts';

/**
 * The logged-in user for the page being rendered (server components), or
 * null. Same check as the API routes: signed cookie, active account, current
 * session version.
 */
export async function currentUser(): Promise<UserDoc | null> {
  const jar = await cookies();

  // Dev-only bypass: the LoginForm sets et_dev=1 without touching the API or DB.
  if (process.env.NODE_ENV !== 'production' && jar.get('et_dev')?.value === '1') return DEV_USER;

  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return userForSessionToken(await getDb(), token);
}
