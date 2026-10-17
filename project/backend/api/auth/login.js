import { checkPassword, createSessionToken, sessionCookie } from '../../lib/auth.js';
import { LOGIN_FAILURE_DELAY_MS } from '../../lib/constants.js';
import { errorResponse, handle, json, readJson } from '../../lib/http.js';

const MAX_LOGIN_BODY_BYTES = 1024;

/** POST /api/auth/login — `{ password }` → sets the session cookie. */
export const POST = handle(async (request) => {
  const body = await readJson(request, MAX_LOGIN_BODY_BYTES);
  if (!body.ok) return body.response;
  if (!checkPassword(body.value && body.value.password)) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_FAILURE_DELAY_MS));
    return errorResponse(401, 'wrong_password', 'Wrong password');
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(createSessionToken()) });
});
