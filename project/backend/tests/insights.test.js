import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_INSIGHT_ENTRIES } from '../lib/constants.js';
import { cleanInsightSettings, insightSettingsView } from '../lib/insights.js';
import { analyzeEvent, classifyFrames, frameLabel, hintsFor, lastMoments, relativeTime, stackText, withoutOrigin } from '../public/insights.js';
import { fusionChartsError, serverCallFailed } from './insights.fixtures.js';

const fact = (insight, label) => insight.facts.find((f) => f.label === label);
const APPZILLON = { hiddenFrames: ['serverError', 'wrapped'] };

describe('stack trace as text', () => {
  it("rebuilds the browser console's text from a real Appzillon event (2026-10-28), with full URLs", () => {
    const fc = 'http://localhost:8080/AppzillonAdmin/appzillon/scripts/fusioncharts/fusioncharts.js?v=1.0.0.0';
    const frame = (fn, lineno, colno, filename = fc) => ({ filename, lineno, colno, function: fn });
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
    assert.equal(fact(insight, 'Where').text,
      'inside FusionCharts (library code), in r._crCreate. Your code called it from Object.getFusionChartLicenseKeyCB (charts.js:1:6398).');
    assert.equal(frameLabel(insight.whereToLook.frame), 'Object.getFusionChartLicenseKeyCB (charts.js:1:6398)');
  });

  it('labels library, browser and app frames', () => {
    assert.deepEqual(insight.frames.map((c) => c.library || c.kind), ['FusionCharts', 'FusionCharts', 'native', 'FusionCharts', 'app']);
  });

  it('names the server call, the screen, the click and the hidden tab', () => {
    assert.equal(fact(insight, 'During').text, 'server call "appzillonFetchLicenseKey", in its callback getFusionChartLicenseKeyCB');
    assert.equal(fact(insight, 'Screen').text, 'launchSubScreen: Dashboard · 6.4 s before the error');
    assert.equal(fact(insight, 'User did').text, 'Clicked Dashboard · 6.4 s before the error');
    assert.equal(fact(insight, 'Tab').tone, 'warn');
    assert.match(fact(insight, 'Tab').text, /hidden 16 ms before the error/);
    assert.match(fact(insight, 'Caught').text, /^yes/);
  });

  it('prefers the screen the app named with setScreen, with when it opened', () => {
    const crumbs = [...fusionChartsError.breadcrumbs, { timestamp: '2026-10-27T12:47:50.000Z', type: 'navigation', message: 'Screen: Dashboard', data: {} }];
    const named = analyzeEvent({ ...fusionChartsError, screen: 'Dashboard', breadcrumbs: crumbs }, {});
    assert.match(fact(named, 'Screen').text, /^Dashboard · .* before the error$/);
    const noCrumb = analyzeEvent({ ...fusionChartsError, screen: 'Settings' }, {});
    assert.equal(fact(noCrumb, 'Screen').text, 'Settings');
  });

  it('explains the message, naming the property', () => {
    assert.equal(insight.hints.length, 1);
    assert.match(insight.hints[0].text, /^"node" was read from a value that was undefined or null/);
  });

  it('shows the last moments oldest first, ending with the hidden tab', () => {
    const last = insight.moments[insight.moments.length - 1];
    assert.deepEqual(last, { when: '-16 ms', at: '2026-10-27T12:47:54.430Z', type: 'lifecycle', message: 'Page hidden', tone: 'warn' });
    assert.ok(insight.moments.some((m) => m.message === 'Clicked Dashboard' && m.tone === 'user'));
    assert.ok(!insight.moments.some((m) => m.message.includes('SecurityParamsDBDetail')), 'older than the window');
  });
});

describe('issue insights: a failed Appzillon server call', () => {
  it('skips the tracking snippet frames when told to', () => {
    const plain = analyzeEvent(serverCallFailed, {});
    assert.equal(plain.whereToLook.frame.function, 'serverError');
    const insight = analyzeEvent(serverCallFailed, APPZILLON);
    assert.equal(insight.whereToLook.frame.function, 'Apz.Server.receiveResHandler');
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
    assert.equal(fact(insight, 'Failed request').text, 'POST /AppzillonAdmin/AppzillonWeb → 502 · 5 ms before the error');
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
});

describe('issue insights: rules', () => {
  it('recognises built-in libraries and project paths, not app files with similar names', () => {
    const kinds = (files, settings = {}) => classifyFrames(files.map((filename) => ({ filename, function: 'f', lineno: 1, colno: 1 })), settings).map((c) => c.library || c.kind);
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
    const kind = (path, settings = {}) => classifyFrames([{ filename: `https://x.test${path}`, function: 'f' }], settings)[0].kind;
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
    assert.equal(fact(insight, 'Request').tone, '');
  });

  it('colours a request context red only when the request failed', () => {
    const slow = { event_type: 'performance', timestamp: '2026-01-01T00:00:00Z', error: { type: 'SlowApiCall', message: 'Slow', handled: true },
      stacktrace: [], breadcrumbs: [], context: { url: '/api/x', method: 'GET', status: 200, duration_ms: 3200 } };
    assert.deepEqual(fact(analyzeEvent(slow, {}), 'Request'), { label: 'Request', text: 'GET /api/x answered 200 after 3.2 s', tone: '' });
    assert.equal(fact(analyzeEvent({ ...slow, context: { ...slow.context, status: 503 } }, {}), 'Request').tone, 'bad');
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
    const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
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
    const hint = (type, context) => hintsFor({ error: { type, message: '' }, context }, {})[0].text;
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
    assert.equal(fact(insight, 'Times').tone, 'warn');
    assert.equal(fact(insight, 'Last request'), undefined, 'no "just before the error" claims');
    assert.ok(!fact(insight, 'Screen').text.includes('before the error'));
    // A normal event: its timestamp differs from the receive time.
    assert.equal(fact(analyzeEvent(fusionChartsError, {}, '2026-10-27T12:47:55.100Z'), 'Times'), undefined);
  });

  it('uses only text and numbers from the free-form context', () => {
    const odd = { ...serverCallFailed, context: { iface: { nested: true }, url: ['x'], method: 'GET' } };
    assert.equal(fact(analyzeEvent(odd, {}), 'During'), undefined);
    assert.equal(fact(analyzeEvent(odd, {}), 'Request'), undefined);
    const crash = { ...serverCallFailed, event_type: 'crash', error: { ...serverCallFailed.error, handled: false } };
    assert.equal(fact(analyzeEvent(crash, {}), 'Caught').tone, 'bad');
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
    assert.deepEqual(cleanInsightSettings({}).settings, { libraryPaths: [], hiddenFrames: [], hints: [] });
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
    assert.deepEqual(cleanInsightSettings({ libraryPaths: Array(40000).fill('/same/') }).settings.libraryPaths, ['/same/']);
  });

  it('keeps a hint on one line, so it round-trips through the dashboard', () => {
    assert.equal(cleanInsightSettings({ hints: [{ match: 'X', text: 'line one\n  line two' }] }).settings.hints[0].text, 'line one line two');
  });
});
