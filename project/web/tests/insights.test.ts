import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_INSIGHT_ENTRIES } from '../server/constants.ts';
import { cleanInsightSettings, insightSettingsView } from '../server/insights.ts';
import { analyzeEvent, classifyFrames, frameLabel, hintsFor, lastMoments, relativeTime, stackText, withoutOrigin, type Insight, type InsightSettingsInput } from '../lib/insights.ts';
import { validOk } from './helpers.ts';
import { fusionChartsError, serverCallFailed } from './insights.fixtures.ts';

const fact = (insight: Insight, label: string) => insight.facts.find((f) => f.label === label);
const APPZILLON = { hiddenFrames: ['serverError', 'wrapped'] };

describe('stack trace as text', () => {
  it("rebuilds the browser console's text from a real Appzillon event (2026-10-28), with full URLs", () => {
    const fc = 'http://localhost:8080/AppzillonAdmin/appzillon/scripts/fusioncharts/fusioncharts.js?v=1.0.0.0';
    const frame = (fn: string, lineno: number | null, colno: number | null, filename: string | null = fc) => ({ filename, lineno, colno, function: fn });
    const error = { message: "Cannot read properties of undefined (reading 'node')", type: 'TypeError', handled: true };
    const stacktrace = [
      frame('r._crCreate', 23, 52678),
      frame('r._drawMain', 23, 51267),
      frame('e.<computed>.<computed> [as trierFirst]', 14, 269448),
      frame('e.<computed>._mapperSeed', 14, 267399),
      frame('t.<computed> [as _mapperParent]', 14, 265798),
      frame('<anonymous>', 14, 265572),
      frame('Array.forEach', null, null, null),
      frame('t.storeObj', 14, 265525),
      frame('Object.license', 14, 125644),
      frame('Object.getFusionChartLicenseKeyCB', 1, 6398, 'http://localhost:8080/AppzillonAdmin/appzillon/scripts/appzillon/charts.js?v=1.0.0.0'),
    ];
    // What the console showed, line for line (DevTools only shortens the file names on screen).
    assert.equal(stackText(error, stacktrace), [
      "TypeError: Cannot read properties of undefined (reading 'node')",
      `    at r._crCreate (${fc}:23:52678)`,
      `    at r._drawMain (${fc}:23:51267)`,
      `    at e.<computed>.<computed> [as trierFirst] (${fc}:14:269448)`,
      `    at e.<computed>._mapperSeed (${fc}:14:267399)`,
      `    at t.<computed> [as _mapperParent] (${fc}:14:265798)`,
      `    at ${fc}:14:265572`,
      '    at Array.forEach (<anonymous>)',
      `    at t.storeObj (${fc}:14:265525)`,
      `    at Object.license (${fc}:14:125644)`,
      '    at Object.getFusionChartLicenseKeyCB (http://localhost:8080/AppzillonAdmin/appzillon/scripts/appzillon/charts.js?v=1.0.0.0:1:6398)',
    ].join('\n'));
  });

  it('never throws on odd input', () => {
    assert.equal(stackText(null, null), 'Error');
    assert.equal(stackText({ type: 'Error', message: '' }, [null, 'x', { function: { toString: () => 'evil' }, filename: 7, lineno: 'a' }]),
      'Error\n    at <anonymous>\n    at <anonymous>\n    at <anonymous>');
    assert.equal(stackText({ type: 'Error', message: 'x' }, [{ function: 'f', filename: 'a.js', lineno: 'a', colno: 3 }]), 'Error: x\n    at f (a.js:3)');
  });
});

describe('issue insights: a real FusionCharts error', () => {
  const insight = analyzeEvent(fusionChartsError, {});

  it('says the error is inside a library and which app frame called it', () => {
    assert.equal(fact(insight, 'Where')?.text,
      'inside FusionCharts (library code), in r._crCreate. Your code called it from Object.getFusionChartLicenseKeyCB (charts.js:1:6398).');
    assert.equal(frameLabel(insight.whereToLook?.frame ?? {}), 'Object.getFusionChartLicenseKeyCB (charts.js:1:6398)');
  });

  it('labels library, browser and app frames', () => {
    assert.deepEqual(insight.frames.map((c) => c.library || c.kind), ['FusionCharts', 'FusionCharts', 'native', 'FusionCharts', 'app']);
  });

  it('names the server call, the screen, the click and the hidden tab', () => {
    assert.equal(fact(insight, 'During')?.text, 'server call "appzillonFetchLicenseKey", in its callback getFusionChartLicenseKeyCB');
    assert.equal(fact(insight, 'Screen')?.text, 'launchSubScreen: Dashboard · 6.4 s before the error');
    assert.equal(fact(insight, 'User did')?.text, 'Clicked Dashboard · 6.4 s before the error');
    assert.equal(fact(insight, 'Tab')?.tone, 'warn');
    assert.match(fact(insight, 'Tab')?.text ?? '', /hidden 16 ms before the error/);
    assert.match(fact(insight, 'Caught')?.text ?? '', /^yes/);
  });

  it('prefers the screen the app named with setScreen, with when it opened', () => {
    const crumbs = [...fusionChartsError.breadcrumbs, { timestamp: '2026-10-27T12:47:50.000Z', type: 'navigation', message: 'Screen: Dashboard', data: {} }];
    const named = analyzeEvent({ ...fusionChartsError, screen: 'Dashboard', breadcrumbs: crumbs }, {});
    assert.match(fact(named, 'Screen')?.text ?? '', /^Dashboard · .* before the error$/);
    const noCrumb = analyzeEvent({ ...fusionChartsError, screen: 'Settings' }, {});
    assert.equal(fact(noCrumb, 'Screen')?.text, 'Settings');
  });

  it('explains the message, naming the property', () => {
    assert.equal(insight.hints.length, 1);
    assert.match(insight.hints[0].text, /^"node" was read from a value that was undefined or null/);
  });

  it('shows the last moments oldest first, ending with the hidden tab', () => {
    const last = insight.moments[insight.moments.length - 1];
    assert.deepEqual(last, { when: '-16 ms', at: '2026-10-27T12:47:54.430Z', type: 'lifecycle', message: 'Page hidden', tone: 'warn', index: 16 });
    // Each row knows its breadcrumb, so the dashboard can jump to it in the raw JSON.
    for (const m of insight.moments) assert.equal(fusionChartsError.breadcrumbs[m.index].message, m.message);
    assert.ok(insight.moments.some((m) => m.message === 'Clicked Dashboard' && m.tone === 'user'));
    assert.ok(!insight.moments.some((m) => m.message.includes('SecurityParamsDBDetail')), 'older than the window');
  });
});

describe('issue insights: a failed Appzillon server call', () => {
  it('skips the tracking snippet frames when told to', () => {
    const plain = analyzeEvent(serverCallFailed, {});
    assert.equal(plain.whereToLook?.frame.function, 'serverError');
    const insight = analyzeEvent(serverCallFailed, APPZILLON);
    assert.equal(insight.whereToLook?.frame.function, 'Apz.Server.receiveResHandler');
    assert.deepEqual(insight.frames.map((c) => c.kind), ['hidden', 'hidden', 'app', 'app', 'library']);
  });

  it('names the failed request that came just before', () => {
    const insight = analyzeEvent(serverCallFailed, APPZILLON);
    assert.deepEqual(fact(insight, 'Failed request'), {
      label: 'Failed request',
      text: 'POST http://localhost:8080/AppzillonAdmin/AppzillonWeb → 502 · 5 ms before the error',
      tone: 'bad',
    });
  });

  it("drops the page's own origin from requests in the summary and timeline", () => {
    const event = { ...serverCallFailed, device: { url: 'http://localhost:8080/AppzillonAdmin/' } };
    const insight = analyzeEvent(event, APPZILLON);
    assert.equal(fact(insight, 'Failed request')?.text, 'POST /AppzillonAdmin/AppzillonWeb → 502 · 5 ms before the error');
    assert.equal(insight.moments[insight.moments.length - 1].message, 'POST /AppzillonAdmin/AppzillonWeb → 502');
    assert.equal(withoutOrigin('GET https://api.other.test/x → 200', 'http://localhost:8080/'), 'GET https://api.other.test/x → 200');
    assert.equal(withoutOrigin('text', 'not a url'), 'text');
  });

  it('shows team hints matched on type, message or context values', () => {
    const settings = { hints: [
      { match: 'appzillonservererror', text: 'Type hint' },
      { match: 'appzillonDashBoard', text: 'Iface hint' },
      { match: 'APZ-1', text: 'Unrelated' },
    ] };
    assert.deepEqual(hintsFor(serverCallFailed, settings).map((h) => h.text), ['Type hint', 'Iface hint']);
  });

  it("never matches a team hint on a request's random _id", () => {
    const notFound = { error: { type: 'HttpError', message: 'GET /a → 404' }, context: { _id: '9f500c2a7b41d0e8', url: '/a', method: 'GET', status: 404 } };
    assert.deepEqual(hintsFor(notFound, { hints: [{ match: '500', text: 'Server down' }] }).filter((h) => h.source === 'project'), []);
  });
});

describe('issue insights: rules', () => {
  it('recognises built-in libraries and project paths, not app files with similar names', () => {
    const kinds = (files: string[], settings: InsightSettingsInput = {}) => classifyFrames(files.map((filename) => ({ filename, function: 'f', lineno: 1, colno: 1 })), settings).map((c) => c.library || c.kind);
    assert.deepEqual(kinds([
      'https://shop.test/js/jquery-3.7.1.min.js',
      'https://shop.test/_next/static/chunks/framework-2c79e2a64abdb08b.js',
      'https://cdn.jsdelivr.net/npm/x@1/dist/index.mjs',
      'chrome-extension://abc/content.js',
      'https://shop.test/static/charts.js',
      'https://shop.test/static/bootstrap.js',
      'https://shop.test/static/cart.js',
    ]), ['jQuery', 'Next.js', 'public CDN', 'browser extension', 'app', 'app', 'app']);
    assert.deepEqual(kinds(['https://shop.test/vendor/Grid.js?v=2'], { libraryPaths: ['/VENDOR/'] }), ['/VENDOR/']);
  });

  it('matches libraries by their real file names only, and lets a project mark files as its own code', () => {
    const kind = (path: string, settings: InsightSettingsInput = {}) => classifyFrames([{ filename: `https://x.test${path}`, function: 'f' }], settings)[0].kind;
    for (const lib of ['/js/jquery-3.7.1.min.js', '/js/jquery-ui.min.js', '/js/jquery.dataTables.min.js', '/js/react-dom.production.min.js',
      '/js/scheduler.production.min.js', '/vue.runtime.global.prod.js', '/zone.min.js', '/underscore-1.13.6.js', '/d3.v7.min.js',
      '/moment-timezone-with-data.js', '/fusioncharts.charts.js', '/a/fusioncharts/x.js', '/bootstrap.bundle.min.js', '/polyfills.js']) {
      assert.equal(kind(lib), 'library', lib);
    }
    for (const app of ['/js/scheduler.js', '/js/react-widgets.js', '/app/fusionchartsHelper.js', '/js/zone-picker.js', '/js/vue-helpers.js',
      '/js/moment-utils.js', '/js/jqueryHelpers.js', '/js/axiosClient.js', '/js/angular-app.js', '/js/polyfill-loader-app.js']) {
      assert.equal(kind(app), 'app', app);
    }
    assert.equal(kind('/js/jquery.min.js', { libraryPaths: ['!/js/'] }), 'app', '"!" overrides the built-in list');
    assert.equal(kind('/js/vendor/grid.js', { libraryPaths: ['!/js/', '/vendor/'] }), 'app', 'your-code entries win');
  });

  it('stays linear on hostile file names', () => {
    const started = Date.now();
    const evil = ['jquery-1' + '.a'.repeat(4000) + '.x', 'jquery-1' + '-a.'.repeat(3000) + 'x', 'bootstrap.bundle' + '.a'.repeat(4000), 'jquery'.repeat(1500)];
    classifyFrames(evil.map((f) => ({ filename: `https://x.test/${f}`, function: 'f' })), {});
    assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
  });

  it('never throws on free-form data that is not plain text, and ignores inherited keys', () => {
    const trap = { toString: 1 };
    const event = {
      ...serverCallFailed,
      error: { type: 'constructor', message: 'x', handled: true },
      breadcrumbs: [{ timestamp: serverCallFailed.timestamp, type: 'api', message: 'GET /x', data: { status: trap, failure: trap } }],
      context: { status: trap, failure: trap, iface: trap, url: '/x', method: 'GET' },
    };
    const insight = analyzeEvent(event, {});
    assert.deepEqual(insight.hints, [], 'no built-in hint from Object.prototype');
    assert.equal(hintsFor({ error: { type: 'NetworkError', message: '' }, context: { failure: '__proto__' } }, {})[0].text.startsWith('No response'), true);
    assert.equal(fact(insight, 'Request')?.tone, '');
  });

  it('colours a request context red only when the request failed', () => {
    const slow = { event_type: 'performance', timestamp: '2026-01-01T00:00:00Z', error: { type: 'SlowApiCall', message: 'Slow', handled: true },
      stacktrace: [], breadcrumbs: [], context: { url: '/api/x', method: 'GET', status: 200, duration_ms: 3200 } };
    assert.deepEqual(fact(analyzeEvent(slow, {}), 'Request'), { label: 'Request', text: 'GET /api/x answered 200 after 3.2 s', tone: '' });
    assert.equal(fact(analyzeEvent({ ...slow, context: { ...slow.context, status: 503 } }, {}), 'Request')?.tone, 'bad');
  });

  it('hides frames by function name or by path', () => {
    const frames = [
      { filename: 'https://a.test/track.js', function: 'Object.wrapped', lineno: 1, colno: 1 },
      { filename: 'https://a.test/x.js', function: 'h [as wrapped]', lineno: 1, colno: 1 },
      { filename: 'https://a.test/x.js', function: 'unwrapped', lineno: 1, colno: 1 },
      { filename: 'https://a.test/track.js', function: 'send', lineno: 1, colno: 1 },
    ];
    assert.deepEqual(classifyFrames(frames, { hiddenFrames: ['wrapped'] }).map((c) => c.kind), ['hidden', 'hidden', 'app', 'app']);
    assert.deepEqual(classifyFrames(frames, { hiddenFrames: ['/track.js'] }).map((c) => c.kind), ['hidden', 'app', 'app', 'hidden']);
  });

  it('folds runs of tab hidden/visible breadcrumbs but keeps the last one', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    const crumbs = [
      { timestamp: at(1), type: 'click', message: 'Clicked Save' },
      ...[2, 3, 4, 5].map((s, i) => ({ timestamp: at(s), type: 'lifecycle', message: i % 2 ? 'Page visible' : 'Page hidden' })),
      { timestamp: at(6), type: 'api', message: 'GET /x → 500', data: { status: 500, failure: null } },
    ];
    assert.deepEqual(lastMoments(crumbs, Date.parse(at(7))).map((m) => [m.when, m.message, m.tone]), [
      ['-6.0 s', 'Clicked Save', 'user'],
      ['-5.0 s', 'Tab hidden/shown 3 times', ''],
      ['-2.0 s', 'Page visible', ''],
      ['-1.0 s', 'GET /x → 500', 'bad'],
    ]);
  });

  it('gives HTTP and network errors a hint from their status or failure', () => {
    const hint = (type: string, context: Record<string, unknown>) => hintsFor({ error: { type, message: '' }, context }, {})[0].text;
    assert.match(hint('HttpError', { status: 503 }), /server failed/);
    assert.match(hint('HttpError', { status: 404 }), /not found/);
    assert.match(hint('NetworkError', { failure: 'timeout' }), /timeout/);
    assert.equal(hintsFor({ error: { type: 'HttpError', message: '' }, context: { status: 418 } }, {}).length, 0);
  });

  it('formats times relative to the error', () => {
    assert.equal(relativeTime(850), '-850 ms');
    assert.equal(relativeTime(6400), '-6.4 s');
    assert.equal(relativeTime(180000), '-3 min');
    assert.equal(relativeTime(-200), '+200 ms');
  });

  it('drops relative times when the server replaced the timestamp (device clock off by more than a day)', () => {
    // lib/validate.js stores the receive time as `timestamp` then; breadcrumbs keep the device clock.
    const receivedAt = '2026-10-30T09:00:00.000Z';
    const insight = analyzeEvent({ ...fusionChartsError, timestamp: receivedAt }, {}, receivedAt);
    assert.ok(insight.moments.length > 0);
    assert.ok(insight.moments.every((m) => m.when === null && m.at !== null));
    assert.equal(fact(insight, 'Times')?.tone, 'warn');
    assert.equal(fact(insight, 'Last request'), undefined, 'no "just before the error" claims');
    assert.ok(!fact(insight, 'Screen')?.text.includes('before the error'));
    // A normal event: its timestamp differs from the receive time.
    assert.equal(fact(analyzeEvent(fusionChartsError, {}, '2026-10-27T12:47:55.100Z'), 'Times'), undefined);
  });

  it('uses only text and numbers from the free-form context', () => {
    const odd = { ...serverCallFailed, context: { iface: { nested: true }, url: ['x'], method: 'GET' } };
    assert.equal(fact(analyzeEvent(odd, {}), 'During'), undefined);
    assert.equal(fact(analyzeEvent(odd, {}), 'Request'), undefined);
    const crash = { ...serverCallFailed, event_type: 'crash', error: { ...serverCallFailed.error, handled: false } };
    assert.equal(fact(analyzeEvent(crash, {}), 'Caught')?.tone, 'bad');
  });

  it('copes with events that have no stack, breadcrumbs or context', () => {
    const insight = analyzeEvent({ event_type: 'message', timestamp: 'not a date', error: null, stacktrace: [], breadcrumbs: [], context: null }, undefined);
    assert.deepEqual(insight, { facts: [], frames: [], whereToLook: null, moments: [], hints: [] });
  });
});

describe('issue insight settings (server validation)', () => {
  it('trims, drops blank lines and de-duplicates', () => {
    const cleaned = cleanInsightSettings({ libraryPaths: [' /vendor/ ', '', '/vendor/'], hiddenFrames: ['wrapped'], hints: [{ match: ' X ', text: ' Y ' }] });
    assert.deepEqual(cleaned, { ok: true, settings: { libraryPaths: ['/vendor/'], hiddenFrames: ['wrapped'], hints: [{ match: 'X', text: 'Y' }] } });
  });

  it('treats missing lists as empty', () => {
    assert.deepEqual(validOk(cleanInsightSettings({})).settings, { libraryPaths: [], hiddenFrames: [], hints: [] });
    assert.deepEqual(insightSettingsView(undefined), { libraryPaths: [], hiddenFrames: [], hints: [] });
  });

  it('rejects wrong shapes and oversized input', () => {
    for (const bad of [null, [], 'x', { libraryPaths: 'x' }, { hiddenFrames: [1] }, { hints: [{ match: 'x' }] }, { hints: [{ match: ' ', text: 'y' }] },
      { libraryPaths: ['x'.repeat(201)] }, { hints: [{ match: 'x', text: 'y'.repeat(1001) }] },
      { libraryPaths: Array.from({ length: MAX_INSIGHT_ENTRIES + 1 }, (_, i) => `/p${i}/`) },
      { hints: [{ match: 'a => b', text: 'c' }] }, { libraryPaths: ['/a/\n/b/'] }]) {
      assert.equal(cleanInsightSettings(bad).ok, false, JSON.stringify(bad).slice(0, 60));
    }
  });

  it('rejects a huge list quickly instead of de-duplicating all of it', () => {
    const started = Date.now();
    const result = cleanInsightSettings({ libraryPaths: Array.from({ length: 40000 }, (_, i) => `/${i}`) });
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 50, `took ${Date.now() - started} ms`);
    assert.deepEqual(validOk(cleanInsightSettings({ libraryPaths: Array(40000).fill('/same/') })).settings.libraryPaths, ['/same/']);
  });

  it('keeps a hint on one line, so it round-trips through the dashboard', () => {
    assert.equal(validOk(cleanInsightSettings({ hints: [{ match: 'X', text: 'line one\n  line two' }] })).settings.hints[0].text, 'line one line two');
  });
});

describe('issue insights: diagnostic context (SDK 0.11.0+)', () => {
  // The Spotify favicon event found on 2026-11-02, as SDK 0.11.0 sends it.
  const spotify = {
    event_type: 'error',
    error: { message: 'Failed to load <img> https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png', type: 'ResourceError', handled: false },
    stacktrace: [],
    breadcrumbs: [],
    device: { url: 'https://assistant-nine-ecru.vercel.app/ai/integrations' },
    context: {
      resource: 'img', cause: 'hidden_cross_origin', status: null,
      url: 'https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png', host: 'open.spotifycdn.com', cross_origin: true,
      content_type: null, duration_ms: 481, size_bytes: null, selector: 'div.w-full.flex > a > img', alt: 'Spotify',
      current_src: null, loading: 'lazy', crossorigin: null, same_host_failures: 2,
      situation: { online: true, connection: '4g', visibility: 'visible', ms_since_page_load: 152000, ms_since_navigation: 545, during_page_load: false },
    },
  };

  it('explains a failed third-party image: file, element, same host, hashed name', () => {
    const insight = analyzeEvent(spotify, null);
    assert.equal(fact(insight, 'File')?.text, '<img> https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png · the browser hides the reason (the file is on another origin) · after 481 ms');
    assert.equal(fact(insight, 'File')?.tone, 'bad');
    assert.equal(fact(insight, 'Element')?.text, 'div.w-full.flex > a > img · alt "Spotify" · loading=lazy');
    assert.match(fact(insight, 'Same host')?.text ?? '', /^2 other files from open\.spotifycdn\.com failed earlier/);
    assert.equal(fact(insight, 'Request'), undefined);
    const hint = insight.hints.find((h) => h.source === 'built-in')?.text ?? '';
    assert.match(hint, /DevTools → Network/);
    assert.match(hint, /version hash/);
    // Nothing to say about a normal network and a loaded page.
    assert.equal(fact(insight, 'Network'), undefined);
    assert.equal(fact(insight, 'Page'), undefined);
  });

  it('still reads the same event from SDK 0.8.0 (no diagnostic context) as before', () => {
    const insight = analyzeEvent({ ...spotify, context: null }, null);
    assert.equal(fact(insight, 'File'), undefined);
    assert.match(insight.hints.find((h) => h.source === 'built-in')?.text ?? '', /^A file \(script, stylesheet, image or font\) failed to load/);
  });

  it('uses the status for own files, and the content type for unusable ones', () => {
    const own = analyzeEvent({ ...spotify, context: { ...spotify.context, cause: 'http_error', status: 404, url: 'https://assistant-nine-ecru.vercel.app/logo.png', cross_origin: false } }, null);
    assert.match(fact(own, 'File')?.text ?? '', /^<img> \/logo\.png · status 404/);
    assert.match(own.hints[0].text, /not on the server/);
    const bad = analyzeEvent({ ...spotify, context: { ...spotify.context, cause: 'bad_content', status: 200, content_type: 'text/html' } }, null);
    assert.match(fact(bad, 'File')?.text ?? '', /status 200 \(served as text\/html\)/);
    assert.match(bad.hints[0].text, /HTML error or login page/);
  });

  it('names server log ids and how the server had been doing', () => {
    const event = {
      error: { message: 'GET https://api.test/cart → 503', type: 'HttpError', handled: true },
      context: {
        _id: 'abc', url: 'https://api.test/cart', method: 'GET', status: 503, duration_ms: 40, cause: 'server_error',
        content_type: 'text/html', response_headers: { 'x-request-id': 'req-1', 'cf-ray': '8a1-BOM' },
        host: 'api.test', cross_origin: true, same_host_failures: 3, ms_since_host_ok: null,
      },
    };
    const insight = analyzeEvent(event, null);
    assert.equal(fact(insight, 'Request')?.text, 'GET https://api.test/cart answered 503 (text/html) after 40 ms');
    assert.equal(fact(insight, 'Server log id')?.text, 'x-request-id: req-1 · cf-ray: 8a1-BOM. Search the server, CDN or proxy logs for it.');
    assert.equal(fact(insight, 'Server')?.text, '3 other requests to api.test failed in the minute before; it had not answered without an error on this page before.');
    assert.equal(fact(insight, 'Server')?.tone, 'bad');
    assert.match(insight.hints[0].text, /server log id above/);
  });

  it('tells a dead server from a one-off network failure', () => {
    const base = { error: { message: 'GET https://api.test/x failed', type: 'NetworkError', handled: true } };
    const down = analyzeEvent({ ...base, context: { url: 'https://api.test/x', method: 'GET', failure: 'network', host: 'api.test', same_host_failures: 2, ms_since_host_ok: null } }, null);
    assert.match(down.hints[0].text, /server was down or unreachable/);
    const blip = analyzeEvent({ ...base, context: { url: 'https://api.test/x', method: 'GET', failure: 'network', host: 'api.test', same_host_failures: 0, ms_since_host_ok: 1500 } }, null);
    assert.equal(fact(blip, 'Server')?.text, 'api.test answered fine 1.5 s before this request.');
    assert.match(blip.hints[0].text, /answered moments earlier/);
  });

  it('says what came back instead of JSON', () => {
    const insight = analyzeEvent({
      error: { message: 'Invalid JSON from https://api.test/me (status 200): Unexpected token', type: 'InvalidJsonResponse', handled: true },
      context: { url: 'https://api.test/me', status: 200, cause: 'html_page', content_type: 'text/html', content_length: null, response_headers: null },
    }, null);
    assert.equal(fact(insight, 'Response')?.text, 'https://api.test/me answered 200 with an HTML page (Content-Type text/html)');
    assert.match(insight.hints[0].text, /login page/);
  });

  it('shows the cause chain, error fields and non-Error throws', () => {
    const insight = analyzeEvent({
      error: { message: 'Checkout failed', type: 'Error', handled: true },
      context: {
        error_causes: [
          { type: 'TypeError', message: 'price is undefined', stacktrace: [{ filename: 'https://app.test/cart.js', lineno: 4, colno: 2, function: 'total' }] },
          { type: null, message: '{"code":1}', stacktrace: [] },
        ],
        error_fields: { code: 'E_PAY', status: 500, retryable: false },
      },
    }, null);
    assert.equal(fact(insight, 'Caused by')?.text, 'TypeError: price is undefined (at total (cart.js:4:2)) ← value: {"code":1}');
    assert.equal(fact(insight, 'Error fields')?.text, 'code: E_PAY · status: 500 · retryable: false');
    const thrown = analyzeEvent({ error: { message: 'timeout', type: 'UnhandledRejection', handled: false }, context: { thrown_kind: 'string' } }, null);
    assert.match(fact(thrown, 'Thrown value')?.text ?? '', /^a string, not an Error object/);
  });

  it('calls out offline, slow networks, loading pages and background tabs', () => {
    const at = (situation: Record<string, unknown>) => analyzeEvent({ error: { message: 'x', type: 'Error', handled: false }, context: { situation } }, null);
    assert.equal(fact(at({ online: false, connection: '4g' }), 'Network')?.tone, 'bad');
    assert.match(fact(at({ online: true, connection: '2g' }), 'Network')?.text ?? '', /slow connection \(2g\)/);
    assert.equal(fact(at({ online: true, connection: '3g' }), 'Network'), undefined);
    assert.equal(fact(at({ during_page_load: true, ms_since_page_load: 1200 }), 'Page')?.text, 'still loading (1.2 s after it started), before everything on it was ready.');
    assert.match(fact(at({ visibility: 'hidden' }), 'Tab')?.text ?? '', /background/);
  });

  it('lists the scripts behind a "Script error."', () => {
    const insight = analyzeEvent({
      error: { message: 'Script error.', type: 'CrossOriginScriptError', handled: false },
      context: { cause: 'hidden_cross_origin', hint: 'x', scripts_without_crossorigin: ['cdn.a.test', 'widgets.b.test'] },
    }, null);
    assert.match(insight.hints[0].text, /without crossorigin: cdn\.a\.test, widgets\.b\.test\.$/);
  });

  it('does not call a dated file name a version hash', () => {
    const dated = analyzeEvent({ ...spotify, context: { ...spotify.context, url: 'https://cdn.test/photos/photo-20231105.jpg' } }, null);
    assert.doesNotMatch(dated.hints[0].text, /version hash/);
  });

  it('blames the server, not the network, for JSON that stops early', () => {
    const insight = analyzeEvent({
      error: { message: 'Invalid JSON from https://api.test/me', type: 'InvalidJsonResponse', handled: true },
      context: { url: 'https://api.test/me', cause: 'incomplete_json', content_type: 'application/json', content_length: 40 },
    }, null);
    assert.equal(fact(insight, 'Response')?.text, 'https://api.test/me answered with JSON that stops early (or only whitespace) (Content-Type application/json) · 40 bytes');
    assert.match(insight.hints[0].text, /server built an incomplete answer/);
  });

  it('ignores diagnostic fields of the wrong type', () => {
    const insight = analyzeEvent({
      error: { message: 'x', type: 'ResourceError', handled: false },
      context: {
        url: { toString: 'x' }, cause: ['http_error'], status: '404', same_host_failures: '9', response_headers: ['a'],
        error_causes: 'not a list', error_fields: { nested: { a: 1 } }, thrown_kind: 42, situation: 'online',
      },
    }, null);
    assert.equal(fact(insight, 'File'), undefined);
    assert.equal(fact(insight, 'Server log id'), undefined);
    assert.equal(fact(insight, 'Caused by'), undefined);
    assert.equal(fact(insight, 'Error fields'), undefined);
    assert.equal(fact(insight, 'Same host'), undefined);
  });
});
