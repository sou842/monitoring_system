/**
 * Issue insights: reads one stored event the way a developer would and turns
 * it into the plain-language summary at the top of the issue page: what
 * happened, where to look in the stack, the last moments before the error,
 * and a hint. Rules only, no AI; nothing leaves the browser.
 *
 * Pure functions (no DOM), so app.js and the backend's unit tests share them.
 */

/** How far back the "Last moments" timeline reaches before the error. */
export const LAST_MOMENTS_WINDOW_MS = 15000;
/** The timeline shows at least this many breadcrumbs, even when they are older. */
export const LAST_MOMENTS_MIN_ITEMS = 5;
/** …and at most this many; the full list stays on the page. */
export const LAST_MOMENTS_MAX_ITEMS = 15;
/** This many lifecycle breadcrumbs in a row are folded into one timeline row. */
export const LIFECYCLE_FOLD_MIN = 3;
/** A request that ended this close before the error is named as its likely trigger. */
export const TRIGGER_REQUEST_MS = 5000;
/** A tab hidden this close before the error is called out as a timing clue. */
export const RECENTLY_HIDDEN_MS = 2000;

/**
 * Third-party code recognised in every project; projects add their own paths.
 * Matched against the frame's file URL without its query string.
 */
/**
 * A library's own file name: the name, then only a version (`-3.7.1`) and/or
 * dot-separated parts (`.min`, `.production.min`, `.v7`), then `.js`. So
 * `jquery-3.7.1.min.js` and `react-dom.production.min.js` match, while app
 * files like `react-widgets.js` or `zone-picker.js` don't.
 */
// The version part stops at the first dot, so a name splits into parts only one way:
// matching stays linear even on hostile 2000-character file names.
const fileNamed = (names) => new RegExp(`/(?:${names})(?:-\\d[\\w-]*)?(?:\\.[\\w-]+)*\\.m?js$`, 'i');
export const BUILT_IN_LIBRARIES = [
  { name: 'npm package', test: /\/node_modules\//i },
  { name: 'public CDN', test: /^https?:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|ajax\.googleapis\.com|code\.jquery\.com|stackpath\.bootstrapcdn\.com)\//i },
  { name: 'browser extension', test: /^(chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i },
  { name: 'jQuery', test: fileNamed('jquery|jquery-ui|jquery\\.\\w+') },
  { name: 'FusionCharts', test: /\/fusioncharts\/|\/fusioncharts(?:\.[\w-]+)*\.js$/i },
  { name: 'React', test: fileNamed('react|react-dom|scheduler\\.(?:production|development)') },
  { name: 'Next.js', test: /\/_next\/static\/chunks\/(framework|main|main-app|webpack|polyfills)[-.]/i },
  { name: 'Vue', test: fileNamed('vue|vue\\.runtime') },
  { name: 'Angular', test: /\/@angular\// },
  { name: 'zone.js', test: fileNamed('zone') },
  { name: 'Lodash', test: fileNamed('lodash|underscore') },
  { name: 'Moment', test: fileNamed('moment|moment-with-locales|moment-timezone(?:-with-data)?') },
  { name: 'Bootstrap', test: /\/bootstrap\/(dist\/)?js\/|\/bootstrap\.bundle(?:\.[\w-]+)*\.js$/i },
  { name: 'Chart library', test: fileNamed('highcharts|echarts|apexcharts|d3|amcharts|chart\\.umd') },
  { name: 'axios', test: fileNamed('axios') },
  { name: 'polyfill', test: /\/core-js\/|\/polyfills?(?:\.[\w-]+)*\.js$/i },
];

/** In "Library paths", a line starting with this marks matching files as your code instead. */
export const APP_PATH_PREFIX = '!';

/** Names shown in the project settings ("Built in: …"). */
export const BUILT_IN_LIBRARY_NAMES = BUILT_IN_LIBRARIES.map((l) => l.name);

/** Project settings with every list present. */
export function insightSettings(raw) {
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    libraryPaths: list(raw && raw.libraryPaths),
    hiddenFrames: list(raw && raw.hiddenFrames),
    hints: list(raw && raw.hints),
  };
}

/**
 * Event data is untrusted and partly free-form (breadcrumb `data`, `context`):
 * only plain strings and numbers are read. Anything else, such as an object
 * with a `toString` key, would throw when turned into text.
 */
const asText = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** `table[key]` for the table's own keys only (no `constructor`, `__proto__`, …). */
const lookup = (table, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);
/** ISO time in ms, NaN for anything that isn't a parseable string. */
const parseTime = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);
const lower = (v) => asText(v).toLowerCase();
const stripQuery = (url) => asText(url).replace(/[?#].*$/, '');

/**
 * Drops the page's own origin from URLs in a text, so requests read at a
 * glance: `GET http://app.test/api/x → 500` → `GET /api/x → 500`.
 */
export function withoutOrigin(text, pageUrl) {
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return text;
  }
  return origin === 'null' ? text : String(text).split(`${origin}/`).join('/');
}

/** Last path segment of a URL, without query: `…/scripts/charts.js?v=1` → `charts.js`. */
export function shortFile(filename) {
  if (!asText(filename)) return '?';
  const path = stripQuery(filename);
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/** `fn (file:line:col)` for one frame. */
export function frameLabel(frame) {
  const where = [shortFile(frame.filename), asText(frame.lineno), asText(frame.colno)].filter(Boolean).join(':');
  return `${asText(frame.function) || '<anonymous>'} (${where})`;
}

/**
 * A "frame to hide" entry matches a function name (`wrapped` also hides
 * `Object.wrapped` and `x [as wrapped]`), or, when it contains a `/`, any
 * frame whose file path contains it.
 */
function isHiddenFrame(frame, hiddenFrames) {
  const fn = asText(frame.function);
  const file = lower(stripQuery(frame.filename));
  return hiddenFrames.some((entry) => {
    const name = asText(entry).trim();
    if (!name) return false;
    if (name.includes('/')) return file.includes(name.toLowerCase());
    return fn === name || fn.endsWith(`.${name}`) || fn.includes(`[as ${name}]`);
  });
}

/**
 * Which library a file belongs to, or null for app code. Project entries win
 * over the built-in list: `!path` = your code, `path` = a library.
 */
function libraryOf(filename, libraryPaths) {
  const path = stripQuery(filename);
  const lowerPath = path.toLowerCase();
  const entries = libraryPaths.map((p) => asText(p).trim()).filter(Boolean);
  const contains = (entry) => {
    const needle = entry.toLowerCase();
    return needle !== '' && lowerPath.includes(needle);
  };
  if (entries.some((e) => e.startsWith(APP_PATH_PREFIX) && contains(e.slice(APP_PATH_PREFIX.length).trim()))) return null;
  const own = entries.find((e) => !e.startsWith(APP_PATH_PREFIX) && contains(e));
  if (own) return own;
  const builtIn = BUILT_IN_LIBRARIES.find((l) => l.test.test(path));
  return builtIn ? builtIn.name : null;
}

/**
 * Labels every frame: `app` (your code), `library`, `native` (browser
 * internals such as `Array.forEach`, no file) or `hidden` (tracking wrappers).
 *
 * @returns {Array<{ frame: object, kind: 'app' | 'library' | 'native' | 'hidden', library: string | null }>}
 */
export function classifyFrames(frames, settings) {
  const { libraryPaths, hiddenFrames } = insightSettings(settings);
  return (Array.isArray(frames) ? frames : []).filter((f) => f && typeof f === 'object').map((frame) => {
    if (isHiddenFrame(frame, hiddenFrames)) return { frame, kind: 'hidden', library: null };
    if (!asText(frame.filename)) return { frame, kind: 'native', library: null };
    const library = libraryOf(frame.filename, libraryPaths);
    return { frame, kind: library ? 'library' : 'app', library };
  });
}

/** "850 ms", "6.4 s", "3 min". */
export function duration(ms) {
  const abs = Math.abs(ms);
  return abs < 1000 ? `${Math.round(abs)} ms` : abs < 60000 ? `${(abs / 1000).toFixed(1)} s` : `${Math.round(abs / 60000)} min`;
}

/** "-850 ms", "-6.4 s": how long before the error something happened ("+" for after it). */
export function relativeTime(ms) {
  return `${ms < 0 ? '+' : '-'}${duration(ms)}`;
}

const timeOf = (b) => {
  const t = parseTime(b && b.timestamp);
  return Number.isFinite(t) ? t : null;
};

const requestFailed = (b) => b.type === 'api' && Boolean(b.data) && typeof b.data === 'object'
  && (asText(b.data.failure) !== '' || (asNumber(b.data.status) ?? 0) >= 400);

/** One timeline row's tone: `bad` (failed request, error log), `warn`, `user` (click) or ''. */
function crumbTone(b, beforeMs) {
  if (requestFailed(b)) return 'bad';
  if (b.type === 'console' || b.type === 'log') return /error/i.test(b.message) ? 'bad' : 'warn';
  if (b.type === 'lifecycle' && /hidden/i.test(b.message) && beforeMs !== null && beforeMs <= RECENTLY_HIDDEN_MS) return 'warn';
  if (b.type === 'click') return 'user';
  return '';
}

/**
 * The error's time in ms, or null when it can't be compared with the
 * breadcrumbs. The server replaces a missing or far-off client timestamp with
 * its receive time (lib/validate.js), while breadcrumbs keep the device clock;
 * a timestamp equal to `receivedAt` is that case (a device clock more than a
 * day off, or an event sent from the offline queue days later).
 */
export function errorTime(event, receivedAt) {
  const at = parseTime(event && event.timestamp);
  if (!Number.isFinite(at)) return null;
  return parseTime(receivedAt) === at ? null : at;
}

/**
 * The breadcrumbs just before the error, oldest first, with their time
 * relative to it (`when`) and the breadcrumb's own time (`at`, ISO). Runs of
 * tab hidden/visible noise are folded into one row. With no usable error time
 * (`errorAt` null) it shows the newest breadcrumbs, without relative times.
 *
 * @returns {Array<{ when: string | null, at: string | null, type: string, message: string, tone: string }>}
 */
export function lastMoments(breadcrumbs, errorAt) {
  const crumbs = (breadcrumbs || []).filter((b) => b && typeof b.message === 'string');
  const known = typeof errorAt === 'number' && Number.isFinite(errorAt);
  let picked = known
    ? crumbs.filter((b) => timeOf(b) === null || errorAt - timeOf(b) <= LAST_MOMENTS_WINDOW_MS)
    : crumbs;
  if (picked.length < LAST_MOMENTS_MIN_ITEMS) picked = crumbs.slice(-LAST_MOMENTS_MIN_ITEMS);
  picked = picked.slice(-LAST_MOMENTS_MAX_ITEMS);

  const before = (b) => (known && timeOf(b) !== null ? errorAt - timeOf(b) : null);
  const at = (b) => (timeOf(b) === null ? null : new Date(timeOf(b)).toISOString());
  const rows = [];
  for (let i = 0; i < picked.length; i++) {
    let j = i;
    while (j < picked.length && picked[j].type === 'lifecycle') j++;
    // Fold a long run of lifecycle crumbs, but keep its last one: it says the tab's state at the error.
    if (j - i >= LIFECYCLE_FOLD_MIN) {
      const first = before(picked[i]);
      rows.push({ when: first === null ? null : relativeTime(first), at: at(picked[i]), type: 'lifecycle', message: `Tab hidden/shown ${j - i - 1} times`, tone: '' });
      i = j - 2;
      continue;
    }
    const b = picked[i];
    const ms = before(b);
    rows.push({ when: ms === null ? null : relativeTime(ms), at: at(b), type: asText(b.type), message: b.message, tone: crumbTone(b, ms) });
  }
  return rows;
}

/** The newest breadcrumb before the error that passes `test`, with how long before it was. */
function lastCrumb(breadcrumbs, errorAt, test) {
  const list = breadcrumbs || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (!b || !test(b)) continue;
    const t = timeOf(b);
    return { crumb: b, beforeMs: t !== null && Number.isFinite(errorAt) ? errorAt - t : null };
  }
  return null;
}

const ago = (beforeMs) => (beforeMs === null ? '' : ` · ${duration(beforeMs)} before the error`);

const STATUS_HINTS = [
  [(s) => s >= 500, 'The server failed while handling this request (a bug or outage on the server side). Check the server logs for this endpoint at this time.'],
  [(s) => s === 404, 'The endpoint was not found: a wrong URL, a removed route, or a missing id in the path.'],
  [(s) => s === 400, 'The server rejected the request as invalid: check what the app sent (missing or wrongly formatted fields).'],
  [(s) => s === 405, 'The endpoint does not accept this HTTP method (e.g. GET where POST is expected).'],
  [(s) => s === 413, 'The request body was too large for the server (often a file upload).'],
];

const FAILURE_HINTS = {
  offline: 'The device was offline. Usually not a bug; it matters only if it happens a lot.',
  timeout: 'The request took longer than its timeout: a slow server or network.',
  aborted: 'The app cancelled the request itself.',
  network: 'No response at all: connection refused, DNS or SSL failure, or the browser blocked it (CORS). Check whether the server was reachable and sends CORS headers for this site.',
};

/** Hints for the event types the SDK builds itself. */
const TYPE_HINTS = {
  InvalidJsonResponse: 'The server answered with something that is not JSON (often an HTML error page or an empty body) where the app expected JSON.',
  ResourceError: 'A file (script, stylesheet, image or font) failed to load: wrong path, deleted after a deploy, blocked, or the server/CDN was down.',
  CspViolation: "The page's Content Security Policy blocked something. Either the policy is missing an allowed source, or something unexpected (an extension, injected script) tried to load.",
  WorkerError: 'An error inside a Web Worker; the stack points at the worker script.',
  ConsoleError: 'App code logged this with console.error; the message is what it logged. Look for that text in the code.',
  CrossOriginScriptError: 'A script from another origin threw, and the browser hides the details ("Script error."). Add crossorigin="anonymous" to its <script> tag and an Access-Control-Allow-Origin header on the file to see the real error.',
  PageNotFound: 'A user reached a page that does not exist: a broken link (check the referrer) or a mistyped URL.',
  EventsDropped: 'Errors arrived faster than the rate limit, so some were dropped. Look for the error storm around this time.',
  SlowPageLoad: 'The page took long to load. Check TTFB (server), then large scripts and images.',
  SlowApiCall: 'An API call took longer than the threshold. Check the endpoint on the server side.',
  MemoryLeakSuspected: 'Memory kept rising after garbage collection. Look for listeners, timers or caches that keep growing on the screens in the breadcrumbs.',
  MainThreadBlocked: 'JavaScript kept the page frozen for this long. Look for heavy loops, large JSON parsing or big DOM updates around this moment.',
  LowFrameRate: 'Scrolling or animation was janky. Look for heavy work during scroll or animation.',
};

/** Hints matched on the error message, for errors thrown by code. */
const MESSAGE_HINTS = [
  [/cannot read propert(?:y|ies) of (?:undefined|null)(?: \(reading '([^']+)'\))?|(?:undefined|null) is not an object|can't access property "?([^",]+)"?/i,
    (m) => `${m[1] || m[2] ? `"${m[1] || m[2]}" was read from` : 'Code used'} a value that was undefined or null. Usually data or an element that was not there yet (a timing problem), or a response without the expected field. Find out why the object before ".${m[1] || m[2] || '…'}" was empty at that moment.`],
  [/is not a function/i, 'Something was called as a function but is not one: a typo, a library or script not loaded yet, a method this browser lacks, or the wrong `this`.'],
  [/is not defined/i, 'A variable or global does not exist: a script failed to load (check failed requests above), scripts loaded in the wrong order, or a typo.'],
  [/before initiali[sz]ation/i, 'A let/const/class was used before its declaration ran: usually circular imports or load order.'],
  [/maximum call stack|too much recursion/i, 'Endless recursion: a function keeps calling itself, often two handlers or setters triggering each other.'],
  [/unexpected token|unexpected end of json|is not valid json|json\.parse/i, 'Text that is not valid JSON was parsed, often an HTML error page or empty body from the server.'],
  [/loading chunk|chunkloaderror|dynamically imported module|importing a module script failed/i, 'A code-split file failed to load, usually right after a deploy (the open page asks for files that no longer exist) or a network drop. Reloading fixes it for the user.'],
  [/resizeobserver loop/i, 'A harmless browser warning about layout; usually safe to ignore.'],
  [/quotaexceeded|exceeded the quota/i, 'Browser storage (localStorage/IndexedDB) is full.'],
  [/hydrat/i, 'The server HTML and the first browser render differ: dates, random values or browser-only APIs used during render.'],
  [/failed to fetch|networkerror when attempting|load failed/i, FAILURE_HINTS.network],
  [/permission|notallowederror/i, 'The browser blocked an action that needs permission or a user gesture (clipboard, fullscreen, autoplay, notifications).'],
];

/** The text a project hint is matched against: error type, message and context values. */
function hintHaystack(event) {
  const parts = [event.error && event.error.type, event.error && event.error.message];
  if (event.context && typeof event.context === 'object') {
    for (const value of Object.values(event.context)) if (typeof value === 'string' || typeof value === 'number') parts.push(value);
  }
  return parts.filter((v) => v !== null && v !== undefined).map(lower);
}

/**
 * Project hints first (their `match` appears in the error type, message or a
 * context value, case-insensitive), then the best built-in one.
 *
 * @returns {Array<{ source: 'project' | 'built-in', text: string }>}
 */
export function hintsFor(event, settings) {
  const out = [];
  const haystack = hintHaystack(event);
  for (const hint of insightSettings(settings).hints) {
    const match = lower(hint && hint.match).trim();
    if (match && asText(hint.text) && haystack.some((h) => h.includes(match))) out.push({ source: 'project', text: asText(hint.text) });
  }
  const error = event.error && typeof event.error === 'object' ? event.error : {};
  const ctx = event.context && typeof event.context === 'object' ? event.context : {};
  let builtIn = null;
  if (error.type === 'HttpError') {
    const status = asNumber(ctx.status);
    const found = status === null ? undefined : STATUS_HINTS.find(([test]) => test(status));
    builtIn = found ? found[1] : null;
  } else if (error.type === 'NetworkError') {
    builtIn = lookup(FAILURE_HINTS, ctx.failure) || FAILURE_HINTS.network;
  } else if (lookup(TYPE_HINTS, error.type)) {
    builtIn = lookup(TYPE_HINTS, error.type);
  } else {
    for (const [pattern, text] of MESSAGE_HINTS) {
      const m = pattern.exec(asText(error.message));
      if (m) { builtIn = typeof text === 'function' ? text(m) : text; break; }
    }
  }
  if (builtIn) out.push({ source: 'built-in', text: builtIn });
  return out;
}

/** Sentence about where in the stack the error was thrown. */
function stackFact(classified) {
  const visible = classified.filter((c) => c.kind !== 'hidden');
  if (visible.length === 0) return null;
  const top = visible[0];
  const app = visible.find((c) => c.kind === 'app');
  if (top.kind === 'app') return { label: 'Where', text: `your code: ${frameLabel(top.frame)}` };
  const fn = asText(top.frame.function);
  const inside = top.kind === 'native' ? `browser code (${fn || 'native'})` : `${top.library} (library code), in ${fn || '<anonymous>'}`;
  const from = app ? ` Your code called it from ${frameLabel(app.frame)}.` : ' No frame from your code: it was started by the browser (an event, timer or callback).';
  return { label: 'Where', text: `inside ${inside}.${from}` };
}

/** Sentence about the context the app or SDK attached (server call, request). */
function contextFact(event) {
  const ctx = event.context && typeof event.context === 'object' ? event.context : null;
  if (!ctx) return null;
  const text = asText;
  if (text(ctx.iface)) {
    const callback = text(ctx.callback) ? `, in its callback ${text(ctx.callback)}` : '';
    const code = text(ctx.errorCode) ? ` · error code ${text(ctx.errorCode)}${text(ctx.errorMessage) ? ` (${text(ctx.errorMessage)})` : ''}` : '';
    return { label: 'During', text: `server call "${text(ctx.iface)}"${callback}${code}` };
  }
  if (typeof ctx.url === 'string' && typeof ctx.method === 'string') {
    const result = text(ctx.status) ? `answered ${text(ctx.status)}` : text(ctx.failure) ? `got no response (${text(ctx.failure)})` : '';
    const took = asNumber(ctx.duration_ms) !== null ? ` after ${duration(ctx.duration_ms)}` : '';
    // Red only when the request failed: a SlowApiCall's context describes a 200.
    const failed = text(ctx.failure) !== '' || (asNumber(ctx.status) ?? 0) >= 400;
    return { label: 'Request', text: `${ctx.method} ${ctx.url} ${result}${took}`.trim(), tone: failed ? 'bad' : '' };
  }
  return null;
}

/**
 * Everything the issue page shows above the raw data.
 *
 * @param {object} event the stored payload (shared schema)
 * @param {object} settings the project's insight settings (library paths, frames to hide, hints)
 * @param {string} [receivedAt] when the server received it; detects a replaced timestamp (see errorTime)
 */
export function analyzeEvent(event, settings, receivedAt) {
  const frames = classifyFrames(Array.isArray(event.stacktrace) ? event.stacktrace : [], settings);
  const errorAt = errorTime(event, receivedAt);
  const crumbs = (Array.isArray(event.breadcrumbs) ? event.breadcrumbs : []).filter((b) => b && typeof b === 'object');
  const facts = [];

  const stack = stackFact(frames);
  if (stack) facts.push(stack);
  const context = contextFact(event);
  if (context) facts.push(context);

  const request = lastCrumb(crumbs, errorAt, (b) => b.type === 'api');
  if (request && request.beforeMs !== null && request.beforeMs <= TRIGGER_REQUEST_MS && !(context && context.label === 'Request')) {
    const failed = requestFailed(request.crumb);
    facts.push({ label: failed ? 'Failed request' : 'Last request', text: `${request.crumb.message}${ago(request.beforeMs)}`, tone: failed ? 'bad' : '' });
  }
  // The screen the app named (setScreen) beats the last URL change: on one-URL apps the URL says nothing.
  const named = typeof event.screen === 'string' && event.screen.length > 0 ? event.screen : null;
  const screen = lastCrumb(crumbs, errorAt, (b) => b.type === 'navigation');
  if (named) {
    const opened = screen && screen.crumb.message === `Screen: ${named}` ? ago(screen.beforeMs) : '';
    facts.push({ label: 'Screen', text: `${named}${opened}` });
  } else if (screen) {
    facts.push({ label: 'Screen', text: `${screen.crumb.message}${ago(screen.beforeMs)}` });
  }
  const click = lastCrumb(crumbs, errorAt, (b) => b.type === 'click');
  if (click) facts.push({ label: 'User did', text: `${click.crumb.message}${ago(click.beforeMs)}` });

  const lifecycle = lastCrumb(crumbs, errorAt, (b) => b.type === 'lifecycle');
  if (lifecycle && /hidden/i.test(lifecycle.crumb.message)) {
    const recent = lifecycle.beforeMs !== null && lifecycle.beforeMs <= RECENTLY_HIDDEN_MS;
    facts.push({
      label: 'Tab',
      text: `in the background${lifecycle.beforeMs === null ? '' : ` (hidden ${duration(lifecycle.beforeMs)} before the error)`}. Browsers pause timers and drawing in background tabs, so timing bugs often show up here.`,
      tone: recent ? 'warn' : '',
    });
  }
  if ((event.event_type === 'error' || event.event_type === 'crash') && event.error) {
    facts.push(event.error.handled
      ? { label: 'Caught', text: 'yes: the app caught or reported it, and the page kept running.' }
      : { label: 'Caught', text: 'no: nothing in the app caught it; the user may have seen the page break.', tone: 'bad' });
  }

  if (errorAt === null && crumbs.length > 0) {
    facts.push({ label: 'Times', text: "the device's clock didn't match the server's (or the event was sent long after it happened), so breadcrumbs show the device's clock time instead of time before the error.", tone: 'warn' });
  }

  const pageUrl = event.device && event.device.url;
  return {
    facts: facts.map((f) => ({ ...f, text: withoutOrigin(f.text, pageUrl) })),
    frames,
    whereToLook: (frames.find((c) => c.kind === 'app') || null),
    moments: lastMoments(crumbs, errorAt).map((m) => ({ ...m, message: withoutOrigin(m.message, pageUrl) })),
    hints: hintsFor(event, settings),
  };
}
