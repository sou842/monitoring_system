import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import { createSessionToken, crossSiteResponse, readCookie, verifySessionToken } from '../lib/auth.js';
import { hashPassword, passwordProblem, verifyPassword } from '../lib/passwords.js';
import { cleanUserName, normalizeEmail } from '../lib/users.js';
import { optimizedUrl, parseImageDataUrl, uploadScreenshot } from '../lib/cloudinary.js';
import { MAX_SCREENSHOT_BYTES, SESSION_TTL_MS } from '../lib/constants.js';
import { culprit, fingerprint, normalizeFilename, normalizeMessage } from '../lib/grouping.js';
import { validateEvent } from '../lib/validate.js';
import { sampleEvent } from './helpers.js';

process.env.SESSION_SECRET = 'test-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'demo';
process.env.CLOUDINARY_UPLOAD_PRESET = 'preset';

const validated = (overrides) => validateEvent(sampleEvent(overrides)).event;

describe('grouping', () => {
  it('normalizes the parts of a message that vary between occurrences', () => {
    assert.equal(normalizeMessage('Order 98231 failed'), 'Order {n} failed');
    assert.equal(normalizeMessage('GET https://api.test/users/42/orders?token=abc → 500'), 'GET https://api.test/users/{n}/orders → 500');
    assert.equal(normalizeMessage('Slow API call: GET /api/x took 2505ms'), 'Slow API call: GET /api/x took {n}ms');
    assert.equal(normalizeMessage('id 3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6 missing'), 'id {uuid} missing');
    assert.equal(normalizeMessage('Storm error #17'), 'Storm error #{n}');
    assert.equal(normalizeMessage('Main thread blocked for 1500ms'), 'Main thread blocked for {n}ms');
  });

  it('keeps short numbers that matter, like HTTP status codes', () => {
    assert.notEqual(fingerprint(validated({ error: { message: 'GET /api → 404', type: 'HttpError', handled: true } })),
      fingerprint(validated({ error: { message: 'GET /api → 500', type: 'HttpError', handled: true } })));
  });

  it('strips origin, query and build hashes from file names', () => {
    assert.equal(normalizeFilename('https://shop.test/_next/static/chunks/page-69f062d9aa306ff0.js?v=1'), '/_next/static/chunks/page.js');
    assert.equal(normalizeFilename('http://localhost:3000/static/app.3f9a1b2c4d.js'), '/static/app.js');
    assert.equal(normalizeFilename(null), '');
    assert.equal(normalizeFilename('C:\\app\\.next\\server\\app\\api\\crash\\route.js'), 'C:/app/.next/server/app/api/crash/route.js');
    assert.equal(culprit([{ filename: 'C:\\app\\server\\route.js', lineno: 1, colno: 2, function: 'GET' }]), 'GET (route.js:1)');
  });

  it('groups the same bug across ids, deploys and environments, but not different bugs', () => {
    const a = validated({ error: { message: 'Order 1001 failed', type: 'Error', handled: false } });
    const b = validated({
      error: { message: 'Order 2002 failed', type: 'Error', handled: false },
      stacktrace: [{ filename: 'http://localhost:3000/static/cart-99aa88bb77.js', lineno: 150, colno: 3, function: 'handlePayment' }],
    });
    const other = validated({ error: { message: 'Order 1001 failed', type: 'RangeError', handled: false } });
    assert.equal(fingerprint(a), fingerprint(b));
    assert.notEqual(fingerprint(a), fingerprint(other));
  });

  it('builds a short culprit label', () => {
    assert.equal(culprit(validated().stacktrace), 'handlePayment (cart.js:142)');
    assert.equal(culprit([]), null);
  });
});

describe('validateEvent', () => {
  it('accepts a shared-schema event and keeps all fields', () => {
    const result = validateEvent(sampleEvent());
    assert.equal(result.ok, true);
    assert.equal(result.event.error.type, 'TypeError');
    assert.equal(result.event.device.platform, 'js');
    assert.ok(result.event.timestamp instanceof Date);
  });

  it('rejects what cannot be stored meaningfully', () => {
    assert.equal(validateEvent(null).ok, false);
    assert.equal(validateEvent(sampleEvent({ event_type: 'oops' })).ok, false);
    assert.equal(validateEvent(sampleEvent({ sdk: {} })).ok, false);
  });

  it('coerces bad field types to null instead of rejecting the event', () => {
    const { event } = validateEvent(sampleEvent({ app_version: 42, user: 'x', memory: { used_mb: 'lots' }, stacktrace: 'nope' }));
    assert.equal(event.app_version, null);
    assert.deepEqual(event.user, { id: null, email: null, name: null });
    assert.equal(event.memory.used_mb, null);
    assert.deepEqual(event.stacktrace, []);
  });

  it('caps sizes and makes free-form keys safe for MongoDB', () => {
    const { event } = validateEvent(sampleEvent({
      error: { message: 'x'.repeat(10000), type: 'Error', handled: false },
      stacktrace: Array.from({ length: 500 }, () => ({ filename: 'a.js', lineno: 1, colno: 1, function: 'f' })),
      context: { '$where': 1, 'a.b': { '$gt': 2 } },
    }));
    assert.ok(event.error.message.length < 4100);
    assert.equal(event.stacktrace.length, 100);
    assert.deepEqual(event.context, { _where: 1, a_b: { _gt: 2 } });
  });

  it('replaces timestamps that are invalid or far from server time', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    assert.equal(validateEvent(sampleEvent({ timestamp: '1999-01-01T00:00:00Z' }), now).event.timestamp.getTime(), now.getTime());
    assert.equal(validateEvent(sampleEvent({ timestamp: 'garbage' }), now).event.timestamp.getTime(), now.getTime());
  });
});

describe('dashboard sessions', () => {
  const user = { _id: new ObjectId(), sessionVersion: 3 };

  it('issues signed tokens with the user and session version, that expire', () => {
    const now = Date.now();
    const token = createSessionToken(user, now);
    assert.deepEqual(verifySessionToken(token, now), { userId: user._id, version: 3 });
    assert.equal(verifySessionToken(token, now + SESSION_TTL_MS + 1), null);
    assert.equal(verifySessionToken('garbage', now), null);
    assert.equal(verifySessionToken(undefined, now), null);
  });

  it('rejects tokens whose payload was changed', () => {
    const now = Date.now();
    const [, signature] = createSessionToken(user, now).split('.');
    const forged = Buffer.from(JSON.stringify({ u: String(new ObjectId()), v: 3, e: now + SESSION_TTL_MS })).toString('base64url');
    assert.equal(verifySessionToken(`${forged}.${signature}`, now), null);
  });

  it('refuses cross-site writes but allows same-site ones and reads', () => {
    const req = (method, origin) => new Request('http://dash.test/api/projects', { method, headers: { host: 'dash.test', ...(origin ? { origin } : {}) } });
    assert.equal(crossSiteResponse(req('POST', 'https://evil.test')).status, 403);
    assert.equal(crossSiteResponse(req('POST', 'http://dash.test')), null);
    assert.equal(crossSiteResponse(req('POST')), null, 'no Origin (non-browser client)');
    assert.equal(crossSiteResponse(req('GET', 'https://evil.test')), null);
  });

  it('ignores a malformed cookie value instead of throwing', () => {
    assert.equal(readCookie(new Request('http://x', { headers: { cookie: 'et_session=%E0%A4%A' } }), 'et_session'), null);
  });

  it('reads cookies from the header', () => {
    const req = new Request('http://x', { headers: { cookie: 'a=1; et_session=abc%3D; b=2' } });
    assert.equal(readCookie(req, 'et_session'), 'abc=');
    assert.equal(readCookie(req, 'missing'), null);
  });
});

describe('screenshots', () => {
  const smallJpeg = 'data:image/jpeg;base64,' + 'A'.repeat(1000);

  it('accepts only base64 image data URLs of allowed types', () => {
    assert.deepEqual(parseImageDataUrl(smallJpeg), { mime: 'image/jpeg', bytes: 750 });
    assert.equal(parseImageDataUrl('data:image/svg+xml;base64,AAAA'), null);
    assert.equal(parseImageDataUrl('https://evil.test/x.jpg'), null);
  });

  it('never uploads an image over the size cap (no raw images reach Cloudinary)', async () => {
    let called = false;
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(Math.ceil(((MAX_SCREENSHOT_BYTES + 1) * 4) / 3) + 4);
    const result = await uploadScreenshot(big, 'p1', async () => { called = true; });
    assert.deepEqual(result, { url: null, reason: 'too_large' });
    assert.equal(called, false);
  });

  it('uploads to the project folder with the preset, and survives Cloudinary failures', async () => {
    let sent = null;
    const ok = await uploadScreenshot(smallJpeg, 'p1', async (url, init) => {
      sent = { url, folder: init.body.get('folder'), preset: init.body.get('upload_preset') };
      return new Response(JSON.stringify({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/x.jpg', bytes: 750 }), { status: 200 });
    });
    assert.equal(ok.url, 'https://res.cloudinary.com/demo/image/upload/v1/x.jpg');
    assert.deepEqual(sent, { url: 'https://api.cloudinary.com/v1_1/demo/image/upload', folder: 'error-tracker/p1', preset: 'preset' });

    const rejected = await uploadScreenshot(smallJpeg, 'p1', async () => new Response('{"error":{"message":"bad"}}', { status: 400 }));
    assert.deepEqual(rejected, { url: null, reason: 'upload_rejected' });
    const thrown = await uploadScreenshot(smallJpeg, 'p1', async () => { throw new Error('network'); });
    assert.deepEqual(thrown, { url: null, reason: 'upload_failed' });
  });

  it('serves screenshots compressed', () => {
    assert.equal(optimizedUrl('https://res.cloudinary.com/demo/image/upload/v1/x.jpg'),
      'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto:low,w_1280,c_limit/v1/x.jpg');
  });
});

describe('accounts', () => {
  it('hashes passwords with a random salt and verifies them', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.match(hash, /^scrypt\$16384\$8\$1\$/);
    assert.notEqual(hash, await hashPassword('correct horse battery'), 'salted');
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('wrong horse battery', hash), false);
    assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
    assert.equal(await verifyPassword(undefined, hash), false);
  });

  it('enforces password rules', () => {
    assert.equal(passwordProblem('long enough pw', 'a@b.co'), null);
    assert.match(passwordProblem('short'), /at least 8/);
    assert.match(passwordProblem('x'.repeat(129)), /at most 128/);
    assert.match(passwordProblem('         '), /spaces/);
    assert.match(passwordProblem('Me@Example.com', 'me@example.com'), /email/);
    assert.match(passwordProblem(undefined), /at least 8/);
  });

  it('normalizes emails and names', () => {
    assert.equal(normalizeEmail('  Jane.Doe@Example.COM '), 'jane.doe@example.com');
    assert.equal(normalizeEmail('no-at-sign'), null);
    assert.equal(normalizeEmail('a@b'), null);
    assert.equal(normalizeEmail(42), null);
    assert.equal(normalizeEmail(`${'x'.repeat(250)}@example.com`), null);
    assert.equal(cleanUserName('  Jane   Doe '), 'Jane Doe');
    assert.equal(cleanUserName('   '), null);
    assert.equal(cleanUserName('x'.repeat(81)), null);
  });
});
