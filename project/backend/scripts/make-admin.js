/**
 * Makes an existing account an admin, and gives it every project that has no
 * owner yet (projects created before accounts existed).
 *
 *   npm run make-admin -- you@example.com
 *
 * Uses MONGODB_URI / MONGODB_DB from .env.local (or the environment), so it
 * changes whichever database those point at. Sign up in the dashboard first.
 */
import { existsSync, readFileSync } from 'node:fs';

const envFile = new URL('../.env.local', import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

const { closeDb, getDb } = await import('../lib/db.js');
const { normalizeEmail } = await import('../lib/users.js');

const email = normalizeEmail(process.argv[2]);
if (email === null) {
  console.error('Usage: npm run make-admin -- you@example.com');
  process.exit(1);
}

try {
  const db = await getDb();
  const user = await db.collection('users').findOne({ email });
  if (user === null) {
    console.error(`No account for ${email}. Sign up in the dashboard first, then run this again.`);
    process.exitCode = 1;
  } else {
    await db.collection('users').updateOne({ _id: user._id }, { $set: { role: 'admin', status: 'active' }, $unset: { disabledAt: '' } });
    const claimed = await db.collection('projects').updateMany({ ownerId: { $exists: false } }, { $set: { ownerId: user._id } });
    console.log(`${email} is now an admin (database "${db.databaseName}").`);
    console.log(`Projects without an owner given to this account: ${claimed.modifiedCount}.`);
  }
} finally {
  await closeDb();
}
