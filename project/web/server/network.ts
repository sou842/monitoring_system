import { createHmac } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import { NETWORK_ID_LENGTH } from './constants.ts';
import { ipBucket } from './rateLimit.ts';

/**
 * A short, one-way id for the network an event batch came from, so the
 * dashboard can say "these 40 events came from the same place" (one office,
 * one home connection) without ever storing an IP address.
 *
 * HMAC-SHA256 keyed with `SESSION_SECRET` over the project id and the IP
 * bucket (IPv4 as is, IPv6 cut to its /64 like the rate limiter), cut to
 * `NETWORK_ID_LENGTH` hex characters:
 * - without the secret the value can't be reversed by hashing all IPv4 addresses;
 * - the same network gets a different id in every project, so ids can't be
 *   matched across projects or accounts;
 * - rotating `SESSION_SECRET` changes every id from then on.
 *
 * Null when the IP or the secret is unknown. Behind NAT a whole office shares
 * one id, and mobile networks change it often: a hint, not an identity.
 */
export function networkIdOf(projectId: ObjectId | string, ip: string | null | undefined): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !ip || ip === 'unknown') return null;
  const bucket = ipBucket(ip);
  if (!bucket || bucket === 'unknown') return null;
  return createHmac('sha256', secret).update(`network:${String(projectId)}:${bucket}`).digest('hex').slice(0, NETWORK_ID_LENGTH);
}
