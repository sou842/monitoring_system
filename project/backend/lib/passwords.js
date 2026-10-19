import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_KEY_BYTES,
  SCRYPT_MAX_MEMORY,
  SCRYPT_PARALLELISM,
  SCRYPT_SALT_BYTES,
} from './constants.js';

/**
 * Password hashing with Node's built-in scrypt (memory-hard, so GPUs gain
 * little). Stored as `scrypt$N$r$p$<salt>$<key>`; the cost settings travel
 * with each hash, so they can be raised later without breaking old ones.
 */

function derive(password, salt, keyLength, N, r, p) {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, { N, r, p, maxmem: SCRYPT_MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await derive(password, salt, SCRYPT_KEY_BYTES, SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELISM);
  return ['scrypt', SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELISM, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** True when `password` matches the stored hash. Never throws on a malformed hash. */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (![N, r, p].every(Number.isInteger) || expected.length === 0) return false;
  const actual = await derive(password, salt, expected.length, N, r, p);
  return timingSafeEqual(actual, expected);
}

let dummyHash = null;

/**
 * Spends the same time as a real check, for logins with an unknown email,
 * so response times don't reveal which emails have accounts.
 */
export async function burnPasswordCheck(password) {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(typeof password === 'string' ? password : '', await dummyHash);
}

/** Why a new password is not acceptable, or null when it is fine. */
export function passwordProblem(password, email = '') {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (password.trim().length === 0) return 'Password cannot be only spaces';
  if (email && password.toLowerCase() === email.toLowerCase()) return 'Password cannot be your email address';
  return null;
}
