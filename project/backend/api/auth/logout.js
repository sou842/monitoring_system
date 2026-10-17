import { clearSessionCookie } from '../../lib/auth.js';
import { json } from '../../lib/http.js';

/** POST /api/auth/logout — clears the session cookie. */
export function POST() {
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}
