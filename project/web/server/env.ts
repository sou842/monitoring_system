/**
 * Reads required configuration from environment variables.
 * Locally they come from .env.local (loaded by Next.js, and by tests/scripts
 * through tests/helpers.ts); on Vercel from Project → Settings → Environment Variables.
 */

/** Returns a required environment variable, or throws with a clear message. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing environment variable ${name} (see .env.example)`);
  }
  return value;
}

/** True on a production build or a production Vercel deployment. */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}
