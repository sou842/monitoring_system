import { REQUEST_ID_BYTES } from '../constants';

const HEX_RADIX = 16;
const BYTE_VALUES = 256;

/**
 * A random lowercase hex id, `REQUEST_ID_BYTES * 2` characters long, for one
 * API call. Uses `crypto.getRandomValues` where available and falls back to
 * `Math.random` (old browsers, some test environments).
 */
export function randomRequestId(): string {
  const bytes = randomBytes(REQUEST_ID_BYTES);
  let id = '';
  for (let i = 0; i < bytes.length; i++) {
    const hex = bytes[i].toString(HEX_RADIX);
    id += hex.length === 1 ? '0' + hex : hex;
  }
  return id;
}

function randomBytes(count: number): number[] {
  const out: number[] = [];
  try {
    const cryptoObj = typeof crypto !== 'undefined' ? crypto : null;
    if (cryptoObj !== null && typeof cryptoObj.getRandomValues === 'function') {
      const buffer = new Uint8Array(count);
      cryptoObj.getRandomValues(buffer);
      for (let i = 0; i < count; i++) out.push(buffer[i]);
      return out;
    }
  } catch (_e) {
    // Fall through to Math.random.
  }
  for (let i = 0; i < count; i++) out.push(Math.floor(Math.random() * BYTE_VALUES));
  return out;
}
