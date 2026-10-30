import { cookies } from 'next/headers';
import { userForSessionToken } from './auth.ts';
import { SESSION_COOKIE } from './constants.ts';
import { getDb } from './db.ts';
import type { UserDoc } from './models.ts';

/**
 * The logged-in user for the page being rendered (server components), or
 * null. Same check as the API routes: signed cookie, active account, current
 * session version.
 */
export async function currentUser(): Promise<UserDoc | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return userForSessionToken(await getDb(), token);
}
