import { isAuthenticated } from '../../lib/auth.js';
import { json } from '../../lib/http.js';

/** GET /api/auth/session — `{ authenticated }`, used by the dashboard on load. */
export function GET(request) {
  return json({ authenticated: isAuthenticated(request) });
}
