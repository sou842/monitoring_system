import { getDb } from '../db.ts';
import { json } from '../http.ts';

/** GET /api/health — 200 when the database is reachable, 503 otherwise. For uptime checks. */
export async function GET(): Promise<Response> {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return json({ ok: true, database: 'up', time: new Date().toISOString() });
  } catch (error) {
    console.error('[api] health check failed', error instanceof Error ? error.message : error);
    return json({ ok: false, database: 'down', time: new Date().toISOString() }, 503);
  }
}
