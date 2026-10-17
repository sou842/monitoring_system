import { getDb } from '../lib/db.js';
import { json } from '../lib/http.js';

/** GET /api/health — 200 when the database is reachable, 503 otherwise. For uptime checks. */
export async function GET() {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return json({ ok: true, database: 'up', time: new Date().toISOString() });
  } catch (error) {
    console.error('[backend] health check failed', error.message);
    return json({ ok: false, database: 'down', time: new Date().toISOString() }, 503);
  }
}
