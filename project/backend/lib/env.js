/**
 * Reads required configuration from environment variables.
 * Locally they come from .env.local (loaded by dev-server.js); on Vercel from
 * Project → Settings → Environment Variables.
 */

/** Returns a required environment variable, or throws with a clear message. */
export function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing environment variable ${name} (see .env.example)`);
  }
  return value;
}

export function isProduction() {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}
