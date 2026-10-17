import { CLOUDINARY_FOLDER, CLOUDINARY_TIMEOUT_MS, MAX_SCREENSHOT_BYTES, SCREENSHOT_MIME_TYPES } from './constants.js';
import { requireEnv } from './env.js';

/**
 * Screenshot uploads to Cloudinary (unsigned upload preset, plain HTTPS; no SDK).
 *
 * Compression: the error-tracking SDK already downsizes and re-encodes
 * screenshots in the browser. As a server-side guarantee, anything still
 * larger than MAX_SCREENSHOT_BYTES is refused here, so a raw full-size image
 * is never uploaded. When displayed, images are served with Cloudinary's
 * low-quality automatic format (see `optimizedUrl`).
 */

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i;

/** Parses a base64 image data URL; returns null if it isn't one we accept. */
export function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = DATA_URL.exec(dataUrl);
  if (match === null) return null;
  const mime = match[1].toLowerCase();
  if (!SCREENSHOT_MIME_TYPES.includes(mime)) return null;
  const base64 = match[2];
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return { mime, bytes: Math.floor((base64.length * 3) / 4) - padding };
}

/**
 * Uploads one screenshot. Never throws: returns `{ url }` on success or
 * `{ url: null, reason }` so a failed upload never loses the error event.
 */
export async function uploadScreenshot(dataUrl, projectId, fetchFn = fetch) {
  const image = parseImageDataUrl(dataUrl);
  if (image === null) return { url: null, reason: 'not_an_image' };
  if (image.bytes > MAX_SCREENSHOT_BYTES) return { url: null, reason: 'too_large' };

  const form = new FormData();
  form.append('file', dataUrl);
  form.append('upload_preset', requireEnv('CLOUDINARY_UPLOAD_PRESET'));
  form.append('folder', `${CLOUDINARY_FOLDER}/${projectId}`);

  try {
    const response = await fetchFn(`https://api.cloudinary.com/v1_1/${requireEnv('CLOUDINARY_CLOUD_NAME')}/image/upload`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(CLOUDINARY_TIMEOUT_MS),
    });
    const body = await response.json();
    if (!response.ok || typeof body.secure_url !== 'string') {
      console.warn('[backend] screenshot upload rejected', response.status, body && body.error);
      return { url: null, reason: 'upload_rejected' };
    }
    return { url: body.secure_url, bytes: body.bytes, width: body.width, height: body.height };
  } catch (error) {
    console.warn('[backend] screenshot upload failed', error.name, error.message);
    return { url: null, reason: 'upload_failed' };
  }
}

/** Delivery URL with automatic format, low quality and a size cap (smaller downloads in the dashboard). */
export function optimizedUrl(url) {
  return typeof url === 'string' ? url.replace('/image/upload/', '/image/upload/f_auto,q_auto:low,w_1280,c_limit/') : null;
}
