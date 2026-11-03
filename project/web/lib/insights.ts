/**
 * Issue insights: reads one stored event the way a developer would and turns
 * it into the plain-language summary at the top of the issue page: what
 * happened, where to look in the stack, the last moments before the error,
 * and a hint. Rules only, no AI; nothing leaves the browser.
 *
 * Pure functions (no DOM), so the dashboard and the unit tests share them.
 * Event data is untrusted: every field is checked before it is read.
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
/** A server that answered fine this recently makes a network failure look like a one-off, not an outage. */
export const RECENT_HOST_OK_MS = 60000;
/** A tab hidden this close before the error is called out as a timing clue. */
export const RECENTLY_HIDDEN_MS = 2000;
/** The dashboard writes team hints as `match => text` lines, so a match can't contain this. */
export const HINT_SEPARATOR = '=>';

/** A stack frame as stored; any field may be missing or of the wrong type. */
export interface InsightFrame {
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
  function?: unknown;
}

/** The parts of a stored event the insights read. */
export interface InsightEvent<F extends InsightFrame = InsightFrame> {
  event_type?: unknown;
  timestamp?: unknown;
  screen?: unknown;
  error?: { type?: unknown; message?: unknown; handled?: unknown } | null;
  stacktrace?: readonly F[] | null;
  breadcrumbs?: readonly unknown[] | null;
  context?: unknown;
  device?: { url?: unknown } | null;
}

/** A project's insight settings; lists may be missing in old or hand-made data. */
export interface InsightSettingsInput {
  libraryPaths?: unknown;
  hiddenFrames?: unknown;
  hints?: unknown;
}

export interface Settings {
  libraryPaths: unknown[];
  hiddenFrames: unknown[];
  hints: unknown[];
}

/**
 * A library's own file name: the name, then only a version (`-3.7.1`) and/or
 * dot-separated parts (`.min`, `.production.min`, `.v7`), then `.js`. So
 * `jquery-3.7.1.min.js` and `react-dom.production.min.js` match, while app
 * files like `react-widgets.js` or `zone-picker.js` don't.
 */
// The version part stops at the first dot, so a name splits into parts only one way:
// matching stays linear even on hostile 2000-character file names.
const fileNamed = (names: string) => new RegExp(`/(?:${names})(?:-\\d[\\w-]*)?(?:\\.[\\w-]+)*\\.m?js$`, 'i');

/**
 * Third-party code recognised in every project; projects add their own paths.
 * Matched against the frame's file URL without its query string.
 */
export const BUILT_IN_LIBRARIES: ReadonlyArray<{ name: string; test: RegExp }> = [
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
export function insightSettings(raw: InsightSettingsInput | null | undefined): Settings {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
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
const asText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
/** `table[key]` for the table's own keys only (no `constructor`, `__proto__`, …). */
const lookup = <T>(table: Record<string, T>, key: unknown): T | undefined =>
  (typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);
/** ISO time in ms, NaN for anything that isn't a parseable string. */
const parseTime = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);
const lower = (v: unknown): string => asText(v).toLowerCase();
const stripQuery = (url: unknown): string => asText(url).replace(/[?#].*$/, '');

/**
 * Drops the page's own origin from URLs in a text, so requests read at a
 * glance: `GET http://app.test/api/x → 500` → `GET /api/x → 500`.
 */
export function withoutOrigin(text: string, pageUrl: unknown): string {
  let origin: string;
  try {
    origin = new URL(asText(pageUrl)).origin;
  } catch {
    return text;
  }
  return origin === 'null' ? text : String(text).split(`${origin}/`).join('/');
}

/** Last path segment of a URL, without query: `…/scripts/charts.js?v=1` → `charts.js`. */
export function shortFile(filename: unknown): string {
  if (!asText(filename)) return '?';
  const path = stripQuery(filename);
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/** `fn (file:line:col)` for one frame. */
export function frameLabel(frame: InsightFrame): string {
  const where = [shortFile(frame.filename), asText(frame.lineno), asText(frame.colno)].filter(Boolean).join(':');
  return `${asText(frame.function) || '<anonymous>'} (${where})`;
}

/**
 * The error as the browser console prints it (Chrome's format), rebuilt from
 * the stored type, message and frames, with full file URLs:
 *   TypeError: Cannot read properties of undefined (reading 'node')
 *       at r._crCreate (https://…/fusioncharts.js:23:52678)
 *       at https://…/fusioncharts.js:14:265572        ← anonymous function
 *       at Array.forEach (<anonymous>)              ← browser code, no file
 */
export function stackText(error: InsightEvent['error'] | undefined, stacktrace: unknown): string {
  const type = error ? asText(error.type) : '';
  const message = error ? asText(error.message) : '';
  const head = type && message ? `${type}: ${message}` : type || message || 'Error';
  const lines = (Array.isArray(stacktrace) ? stacktrace : []).map((frame: unknown) => {
    const f: InsightFrame = isRecord(frame) ? frame : {};
    const fn = typeof f.function === 'string' ? f.function : '';
    const file = typeof f.filename === 'string' ? f.filename : '';
    const position = [asNumber(f.lineno), asNumber(f.colno)].filter((n): n is number => n !== null);
    const where = file ? [file, ...position].join(':') : '<anonymous>';
    return !fn || fn === '<anonymous>' ? `    at ${where}` : `    at ${fn} (${where})`;
  });
  return [head, ...lines].join('\n');
}

/**
 * A "frame to hide" entry matches a function name (`wrapped` also hides
 * `Object.wrapped` and `x [as wrapped]`), or, when it contains a `/`, any
 * frame whose file path contains it.
 */
function isHiddenFrame(frame: InsightFrame, hiddenFrames: unknown[]): boolean {
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
function libraryOf(filename: unknown, libraryPaths: unknown[]): string | null {
  const path = stripQuery(filename);
  const lowerPath = path.toLowerCase();
  const entries = libraryPaths.map((p) => asText(p).trim()).filter(Boolean);
  const contains = (entry: string) => {
    const needle = entry.toLowerCase();
    return needle !== '' && lowerPath.includes(needle);
  };
  if (entries.some((e) => e.startsWith(APP_PATH_PREFIX) && contains(e.slice(APP_PATH_PREFIX.length).trim()))) return null;
  const own = entries.find((e) => !e.startsWith(APP_PATH_PREFIX) && contains(e));
  if (own) return own;
  const builtIn = BUILT_IN_LIBRARIES.find((l) => l.test.test(path));
  return builtIn ? builtIn.name : null;
}

export type FrameKind = 'app' | 'library' | 'native' | 'hidden';

export interface ClassifiedFrame<F extends InsightFrame = InsightFrame> {
  frame: F;
  kind: FrameKind;
  library: string | null;
}

/**
 * Labels every frame: `app` (your code), `library`, `native` (browser
 * internals such as `Array.forEach`, no file) or `hidden` (tracking wrappers).
 */
export function classifyFrames<F extends InsightFrame>(frames: readonly F[] | null | undefined, settings: InsightSettingsInput | null | undefined): ClassifiedFrame<F>[] {
  const { libraryPaths, hiddenFrames } = insightSettings(settings);
  return (Array.isArray(frames) ? (frames as readonly F[]) : []).filter((f) => isRecord(f)).map((frame): ClassifiedFrame<F> => {
    if (isHiddenFrame(frame, hiddenFrames)) return { frame, kind: 'hidden', library: null };
    if (!asText(frame.filename)) return { frame, kind: 'native', library: null };
    const library = libraryOf(frame.filename, libraryPaths);
    return { frame, kind: library ? 'library' : 'app', library };
  });
}

/** "850 ms", "6.4 s", "3 min". */
export function duration(ms: number): string {
  const abs = Math.abs(ms);
  return abs < 1000 ? `${Math.round(abs)} ms` : abs < 60000 ? `${(abs / 1000).toFixed(1)} s` : `${Math.round(abs / 60000)} min`;
}

/** "-850 ms", "-6.4 s": how long before the error something happened ("+" for after it). */
export function relativeTime(ms: number): string {
  return `${ms < 0 ? '+' : '-'}${duration(ms)}`;
}

/** A breadcrumb as stored; untrusted. */
interface Crumb {
  timestamp?: unknown;
  type?: unknown;
  message?: unknown;
  data?: unknown;
}

const timeOf = (b: Crumb | null | undefined): number | null => {
  const t = parseTime(b && b.timestamp);
  return Number.isFinite(t) ? t : null;
};

const requestFailed = (b: Crumb): boolean => b.type === 'api' && isRecord(b.data)
  && (asText(b.data.failure) !== '' || (asNumber(b.data.status) ?? 0) >= 400);

export type Tone = 'bad' | 'warn' | 'user' | '';

/** One timeline row's tone: `bad` (failed request, error log), `warn`, `user` (click) or ''. */
function crumbTone(b: Crumb & { message: string }, beforeMs: number | null): Tone {
  if (requestFailed(b)) return 'bad';
  if (b.type === 'console' || b.type === 'log') return /error/i.test(b.message) ? 'bad' : 'warn';
  if (b.type === 'lifecycle' && /hidden/i.test(b.message) && beforeMs !== null && beforeMs <= RECENTLY_HIDDEN_MS) return 'warn';
  if (b.type === 'click') return 'user';
  return '';
}

/**
 * The error's time in ms, or null when it can't be compared with the
 * breadcrumbs. The server replaces a missing or far-off client timestamp with
 * its receive time (server/validate.ts), while breadcrumbs keep the device clock;
 * a timestamp equal to `receivedAt` is that case (a device clock more than a
 * day off, or an event sent from the offline queue days later).
 */
export function errorTime(event: { timestamp?: unknown } | null | undefined, receivedAt: unknown): number | null {
  const at = parseTime(event && event.timestamp);
  if (!Number.isFinite(at)) return null;
  return parseTime(receivedAt) === at ? null : at;
}

export interface Moment {
  when: string | null;
  at: string | null;
  type: string;
  message: string;
  tone: Tone;
  /** Position in the event's breadcrumbs (the first one of a folded run). */
  index: number;
}

/**
 * The breadcrumbs just before the error, oldest first, with their time
 * relative to it (`when`) and the breadcrumb's own time (`at`, ISO). Runs of
 * tab hidden/visible noise are folded into one row. With no usable error time
 * (`errorAt` null) it shows the newest breadcrumbs, without relative times.
 */
export function lastMoments(breadcrumbs: readonly unknown[] | null | undefined, errorAt: number | null): Moment[] {
  const all = breadcrumbs || [];
  const crumbs = all.filter((b): b is Crumb & { message: string } => isRecord(b) && typeof b.message === 'string');
  const known = typeof errorAt === 'number' && Number.isFinite(errorAt);
  const errorMs = known ? errorAt : 0;
  let picked = known
    ? crumbs.filter((b) => {
        const t = timeOf(b);
        return t === null || errorMs - t <= LAST_MOMENTS_WINDOW_MS;
      })
    : crumbs;
  if (picked.length < LAST_MOMENTS_MIN_ITEMS) picked = crumbs.slice(-LAST_MOMENTS_MIN_ITEMS);
  picked = picked.slice(-LAST_MOMENTS_MAX_ITEMS);

  // Position in the event's breadcrumbs array, so the dashboard can point at it in the raw JSON.
  const indexOf = (b: Crumb) => all.indexOf(b);
  const before = (b: Crumb): number | null => {
    const t = timeOf(b);
    return known && t !== null ? errorMs - t : null;
  };
  const at = (b: Crumb): string | null => {
    const t = timeOf(b);
    return t === null ? null : new Date(t).toISOString();
  };
  const rows: Moment[] = [];
  for (let i = 0; i < picked.length; i++) {
    let j = i;
    while (j < picked.length && picked[j].type === 'lifecycle') j++;
    // Fold a long run of lifecycle crumbs, but keep its last one: it says the tab's state at the error.
    if (j - i >= LIFECYCLE_FOLD_MIN) {
      const first = before(picked[i]);
      rows.push({ when: first === null ? null : relativeTime(first), at: at(picked[i]), type: 'lifecycle', message: `Tab hidden/shown ${j - i - 1} times`, tone: '', index: indexOf(picked[i]) });
      i = j - 2;
      continue;
    }
    const b = picked[i];
    const ms = before(b);
    rows.push({ when: ms === null ? null : relativeTime(ms), at: at(b), type: asText(b.type), message: b.message, tone: crumbTone(b, ms), index: indexOf(b) });
  }
  return rows;
}

/** The newest breadcrumb before the error that passes `test`, with how long before it was. */
function lastCrumb(breadcrumbs: readonly Crumb[], errorAt: number | null, test: (b: Crumb) => boolean): { crumb: Crumb; beforeMs: number | null } | null {
  for (let i = breadcrumbs.length - 1; i >= 0; i--) {
    const b = breadcrumbs[i];
    if (!b || !test(b)) continue;
    const t = timeOf(b);
    return { crumb: b, beforeMs: t !== null && errorAt !== null && Number.isFinite(errorAt) ? errorAt - t : null };
  }
  return null;
}

const ago = (beforeMs: number | null) => (beforeMs === null ? '' : ` · ${duration(beforeMs)} before the error`);

const STATUS_HINTS: Array<[(status: number) => boolean, string]> = [
  [(s) => s >= 500, 'The server failed while handling this request (a bug or outage on the server side). Check the server logs for this endpoint at this time.'],
  [(s) => s === 404, 'The endpoint was not found: a wrong URL, a removed route, or a missing id in the path.'],
  [(s) => s === 400, 'The server rejected the request as invalid: check what the app sent (missing or wrongly formatted fields).'],
  [(s) => s === 405, 'The endpoint does not accept this HTTP method (e.g. GET where POST is expected).'],
  [(s) => s === 413, 'The request body was too large for the server (often a file upload).'],
];

const FAILURE_HINTS: Record<string, string> = {
  offline: 'The device was offline. Usually not a bug; it matters only if it happens a lot.',
  timeout: 'The request took longer than its timeout: a slow server or network.',
  aborted: 'The app cancelled the request itself.',
  network: 'No response at all: connection refused, DNS or SSL failure, or the browser blocked it (CORS). Check whether the server was reachable and sends CORS headers for this site.',
};

/** Hints for the event types the SDK builds itself. */
const TYPE_HINTS: Record<string, string> = {
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
const MESSAGE_HINTS: Array<[RegExp, string | ((m: RegExpExecArray) => string)]> = [
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

// ---------------------------------------------------------------------------
// Diagnostic context (SDK 0.11.0+): `context.cause` and the fields around it.
// Older events don't have these fields, so every reader falls back to nothing.
// ---------------------------------------------------------------------------

/**
 * A file name with a content hash (`favicon32.b64ecc03.png`, `main-3f9a1c2e.js`): it changes on every release.
 * The hash must contain a letter, so dates such as `photo-20231105.jpg` don't count.
 */
const HASHED_FILE = /[.-](?=[0-9]*[a-f])[0-9a-f]{8,}\.[a-z0-9]+$/i;

const RESOURCE_CAUSE_TEXT: Record<string, string> = {
  bad_content: 'the server answered, but the browser could not use the file',
  hidden_cross_origin: 'the browser hides the reason (the file is on another origin)',
  no_response: 'no response at all',
  offline: 'the device was offline',
  unknown: 'the browser gave no details',
};

const RESOURCE_CAUSE_HINTS: Record<string, string> = {
  bad_content:
    'The server answered, but the file was not usable: corrupt, empty, or a different kind of file than the tag expects. An HTML error or login page served in place of an image or script is the usual case; see the content type above.',
  hidden_cross_origin:
    'The file is on another origin, so the browser does not tell the page why it failed: it could be 403/404, a DNS failure or a blocked request. Open the page with DevTools → Network to see the real status. Files from other companies\' servers can disappear or block hotlinking at any time; host a copy yourself when you can.',
  no_response:
    'The browser got no response at all: the server was down or unreachable, or an ad/privacy blocker, company proxy or the browser blocked the request.',
  offline: 'The device was offline. Usually not a bug; it matters only if it happens a lot.',
  unknown:
    'The browser gave no details about this failure (older browser, or its timing buffer was full). Check the file\'s URL and server.',
};

const RESOURCE_STATUS_HINTS: Array<[(status: number) => boolean, string]> = [
  [(s) => s === 404 || s === 410, 'The file is not on the server: a wrong path, or a file removed by a deploy while this page (or a cached copy of it) still pointed at the old name.'],
  [(s) => s === 401 || s === 403, 'The server refused to send the file: it needs a login or signed URL, the link expired, or the server blocks requests from this site.'],
  [(s) => s >= 500, 'The server or CDN failed while serving the file. Check that server\'s status and logs at this time.'],
];

const JSON_CAUSE_TEXT: Record<string, string> = {
  html_page: 'an HTML page',
  empty_body: 'an empty body',
  incomplete_json: 'JSON that stops early (or only whitespace)',
  empty_or_incomplete: 'an empty body or JSON that stops early',
  malformed_json: 'broken JSON',
  not_json: 'text that is not JSON',
};

const JSON_CAUSE_HINTS: Record<string, string> = {
  html_page:
    'An HTML page came back where the app expected JSON. Typical reasons: the session expired and the server redirected to a login page, a proxy or gateway returned its own error page, or the URL is wrong and the server sent its normal page (the SPA fallback). The status and URL above tell which.',
  empty_body: 'The server sent an empty body (e.g. 204 or an empty 200) where the app expected JSON. Either the server should return JSON or the app should not parse an empty answer.',
  incomplete_json: 'The whole response arrived, but its JSON stops early (or is only whitespace): the server built an incomplete answer, e.g. it crashed or hit an error after it started writing. Check the endpoint\'s logs at this time.',
  empty_or_incomplete: 'The response was empty or its JSON stops early. Either the endpoint should return JSON here, or the app should not parse an empty answer; check the endpoint\'s logs at this time.',
  malformed_json: 'The server said it sent JSON, but the text is not valid JSON: a server-side bug in building the response (string concatenation, debug output, a stray character).',
  not_json: 'The server answered with plain text or another format where the app expected JSON.',
};

const SLOW_CONNECTIONS = ['slow-2g', '2g'];

/** A JSON object (not an array): diagnostic fields that hold key/value pairs. */
const isObjectMap = (v: unknown): v is Record<string, unknown> => isRecord(v) && !Array.isArray(v);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "x-request-id: abc · cf-ray: 8a1" from a response_headers object; '' when none. */
function serverIds(value: unknown): string {
  if (!isObjectMap(value)) return '';
  return Object.keys(value)
    .filter((k) => asText(value[k]) !== '')
    .map((k) => `${k}: ${asText(value[k])}`)
    .join(' · ');
}

/** The built-in hint for an event the SDK described with `context.cause`, or null. */
function diagnosisHint(type: unknown, ctx: Record<string, unknown>): string | null {
  const cause = asText(ctx.cause);
  if (type === 'ResourceError') {
    const status = asNumber(ctx.status);
    let hint: string | null = null;
    if (status !== null) {
      const found = RESOURCE_STATUS_HINTS.find(([test]) => test(status));
      hint = found ? found[1] : null;
    }
    if (hint === null && cause) hint = lookup(RESOURCE_CAUSE_HINTS, cause) ?? null;
    // Only the file name's end: event text is untrusted and can be 16 KB long.
    if (hint !== null && HASHED_FILE.test(stripQuery(ctx.url).split('/').pop()?.slice(-300) ?? '')) {
      hint += ' The file name contains a version hash, so it changes on every release of whoever serves it: the old name usually stops existing after their next deploy.';
    }
    return hint;
  }
  if (type === 'InvalidJsonResponse') return lookup(JSON_CAUSE_HINTS, cause) ?? null;
  if (type === 'CrossOriginScriptError') {
    const hosts = Array.isArray(ctx.scripts_without_crossorigin) ? ctx.scripts_without_crossorigin.map(asText).filter(Boolean) : [];
    if (hosts.length === 0) return null;
    return `${lookup(TYPE_HINTS, type)} Scripts on this page from other origins without crossorigin: ${hosts.join(', ')}.`;
  }
  return null;
}

/** A sentence about how the request's server had been doing on this page, or ''. */
function hostHealthText(ctx: Record<string, unknown>): string {
  const host = asText(ctx.host);
  const failures = asNumber(ctx.same_host_failures);
  const okAgo = asNumber(ctx.ms_since_host_ok);
  if (!host || (failures === null && okAgo === null)) return '';
  if (failures !== null && failures > 0) {
    const last = okAgo === null ? 'it had not answered without an error on this page before' : `it last answered fine ${duration(okAgo)} before`;
    return `${plural(failures, 'other request')} to ${host} failed in the minute before; ${last}.`;
  }
  return okAgo !== null ? `${host} answered fine ${duration(okAgo)} before this request.` : '';
}

/** Facts from the SDK's diagnostic context: the failed file, the server, the response, the thrown value. */
function diagnosisFacts(event: InsightEvent): Fact[] {
  const ctx = isRecord(event.context) ? event.context : null;
  if (!ctx) return [];
  const facts: Fact[] = [];
  const type = isRecord(event.error) ? event.error.type : null;

  if (type === 'ResourceError' && asText(ctx.url)) {
    const status = asNumber(ctx.status);
    const what = status !== null ? `status ${status}` : lookup(RESOURCE_CAUSE_TEXT, ctx.cause) ?? '';
    const served = asText(ctx.content_type) ? ` (served as ${asText(ctx.content_type)})` : '';
    const took = asNumber(ctx.duration_ms) !== null ? ` · after ${duration(asNumber(ctx.duration_ms) as number)}` : '';
    const tag = asText(ctx.resource) ? `<${asText(ctx.resource)}> ` : '';
    facts.push({ label: 'File', text: `${tag}${stripQuery(ctx.url)}${what ? ` · ${what}` : ''}${served}${took}`, tone: 'bad' });
    const parts = [asText(ctx.selector)];
    if (asText(ctx.alt)) parts.push(`alt "${asText(ctx.alt)}"`);
    if (asText(ctx.current_src)) parts.push(`srcset picked ${stripQuery(ctx.current_src)}`);
    if (asText(ctx.loading)) parts.push(`loading=${asText(ctx.loading)}`);
    if (asText(ctx.crossorigin)) parts.push(`crossorigin=${asText(ctx.crossorigin)}`);
    if (ctx.before_sdk_start === true) parts.push('failed before the SDK started');
    if (parts.filter(Boolean).length > 0) facts.push({ label: 'Element', text: parts.filter(Boolean).join(' · ') });
    const others = asNumber(ctx.same_host_failures);
    if (others !== null && others > 0 && asText(ctx.host)) {
      facts.push({ label: 'Same host', text: `${plural(others, 'other file')} from ${asText(ctx.host)} failed earlier on this page, so the whole host may be failing.`, tone: 'warn' });
    }
  }

  if (type === 'InvalidJsonResponse' && asText(ctx.cause)) {
    const what = lookup(JSON_CAUSE_TEXT, ctx.cause) ?? asText(ctx.cause);
    const served = asText(ctx.content_type) ? ` (Content-Type ${asText(ctx.content_type)})` : '';
    const length = asNumber(ctx.content_length) !== null ? ` · ${asNumber(ctx.content_length)} bytes` : '';
    const status = asText(ctx.status) ? `answered ${asText(ctx.status)}` : 'answered';
    facts.push({ label: 'Response', text: `${stripQuery(ctx.url)} ${status} with ${what}${served}${length}`, tone: 'bad' });
  }

  const ids = serverIds(ctx.response_headers);
  if (ids) facts.push({ label: 'Server log id', text: `${ids}. Search the server, CDN or proxy logs for it.` });
  if (type === 'HttpError' || type === 'NetworkError') {
    const health = hostHealthText(ctx);
    if (health) {
      const failing = (asNumber(ctx.same_host_failures) ?? 0) > 0;
      facts.push({ label: 'Server', text: health, tone: failing ? (ctx.ms_since_host_ok === null ? 'bad' : 'warn') : '' });
    }
  }

  if (Array.isArray(ctx.error_causes) && ctx.error_causes.length > 0) {
    const chain = ctx.error_causes.filter(isRecord).map((c) => {
      const frames = Array.isArray(c.stacktrace) ? c.stacktrace.filter(isRecord) : [];
      const where = frames.length > 0 ? ` (at ${frameLabel(frames[0] as InsightFrame)})` : '';
      return `${asText(c.type) || 'value'}: ${asText(c.message)}${where}`;
    });
    if (chain.length > 0) facts.push({ label: 'Caused by', text: chain.join(' ← ') });
  }
  if (isObjectMap(ctx.error_fields)) {
    const fields = ctx.error_fields;
    const text = Object.keys(fields)
      .filter((k) => asText(fields[k]) !== '' || typeof fields[k] === 'boolean')
      .map((k) => `${k}: ${typeof fields[k] === 'boolean' ? String(fields[k]) : asText(fields[k])}`)
      .join(' · ');
    if (text) facts.push({ label: 'Error fields', text });
  }
  const kind = asText(ctx.thrown_kind);
  if (kind) {
    facts.push({
      label: 'Thrown value',
      text: `a ${kind}, not an Error object, so the browser recorded no stack trace. Throw or reject with new Error(...) to get one.`,
      tone: 'warn',
    });
  }
  return facts;
}

/** Facts from `context.situation`: the network and page state when the event happened. */
function situationFacts(event: InsightEvent, hasTabFact: boolean): Fact[] {
  const ctx = isRecord(event.context) ? event.context : null;
  const s = ctx && isObjectMap(ctx.situation) ? ctx.situation : null;
  if (!s) return [];
  const facts: Fact[] = [];
  const connection = asText(s.connection);
  if (s.online === false) {
    facts.push({ label: 'Network', text: 'the device was offline when this happened.', tone: 'bad' });
  } else if (SLOW_CONNECTIONS.includes(connection)) {
    facts.push({ label: 'Network', text: `slow connection (${connection}): timeouts and late responses are expected on this device.`, tone: 'warn' });
  }
  const sinceLoad = asNumber(s.ms_since_page_load);
  if (s.during_page_load === true) {
    facts.push({ label: 'Page', text: `still loading${sinceLoad !== null ? ` (${duration(sinceLoad)} after it started)` : ''}, before everything on it was ready.` });
  }
  if (s.visibility === 'hidden' && !hasTabFact) {
    facts.push({ label: 'Tab', text: 'in the background when this happened. Browsers pause timers and drawing in background tabs.', tone: 'warn' });
  }
  return facts;
}

/** The text a project hint is matched against: error type, message and context values. */
function hintHaystack(event: InsightEvent): string[] {
  const parts: unknown[] = [event.error && event.error.type, event.error && event.error.message];
  if (isRecord(event.context)) {
    for (const [key, value] of Object.entries(event.context)) {
      // `_id` is a random request id: a hint like "500" must not match it by chance.
      if (key !== '_id' && (typeof value === 'string' || typeof value === 'number')) parts.push(value);
    }
  }
  return parts.filter((v) => v !== null && v !== undefined).map(lower);
}

export interface InsightHint {
  source: 'project' | 'built-in';
  text: string;
}

/**
 * Project hints first (their `match` appears in the error type, message or a
 * context value, case-insensitive), then the best built-in one.
 */
export function hintsFor(event: InsightEvent, settings: InsightSettingsInput | null | undefined): InsightHint[] {
  const out: InsightHint[] = [];
  const haystack = hintHaystack(event);
  for (const hint of insightSettings(settings).hints) {
    const h = isRecord(hint) ? hint : {};
    const match = lower(h.match).trim();
    if (match && asText(h.text) && haystack.some((text) => text.includes(match))) out.push({ source: 'project', text: asText(h.text) });
  }
  const error = isRecord(event.error) ? event.error : {};
  const ctx = isRecord(event.context) ? event.context : {};
  // From the SDK's context.cause (0.11.0+) first; older events fall through to the rules below.
  let builtIn: string | null = diagnosisHint(error.type, ctx);
  if (builtIn !== null) {
    out.push({ source: 'built-in', text: builtIn });
    return out;
  }
  if (error.type === 'HttpError') {
    const status = asNumber(ctx.status);
    const found = status === null ? undefined : STATUS_HINTS.find(([test]) => test(status));
    builtIn = found ? found[1] : null;
    if (builtIn !== null && serverIds(ctx.response_headers)) builtIn += ' The server log id above finds this exact request.';
  } else if (error.type === 'NetworkError') {
    builtIn = lookup(FAILURE_HINTS, ctx.failure) || FAILURE_HINTS.network;
    const failures = asNumber(ctx.same_host_failures);
    const okAgo = asNumber(ctx.ms_since_host_ok);
    if (ctx.failure === 'network' && failures !== null && failures > 0 && okAgo === null) {
      builtIn += ' Every request to this server failed on this page, so the server was down or unreachable from this user\'s network.';
    } else if (ctx.failure === 'network' && okAgo !== null && okAgo < RECENT_HOST_OK_MS) {
      builtIn += ' The same server answered moments earlier, so look at this request in particular (CORS on this route, a timeout) or a brief network drop.';
    }
  } else if (lookup(TYPE_HINTS, error.type)) {
    builtIn = lookup(TYPE_HINTS, error.type) ?? null;
  } else {
    for (const [pattern, text] of MESSAGE_HINTS) {
      const m = pattern.exec(asText(error.message));
      if (m) { builtIn = typeof text === 'function' ? text(m) : text; break; }
    }
  }
  if (builtIn) out.push({ source: 'built-in', text: builtIn });
  return out;
}

export interface Fact {
  label: string;
  text: string;
  tone?: Tone;
}

/** Sentence about where in the stack the error was thrown. */
function stackFact(classified: ClassifiedFrame[]): Fact | null {
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
function contextFact(event: InsightEvent): Fact | null {
  const ctx = isRecord(event.context) ? event.context : null;
  if (!ctx) return null;
  const text = asText;
  if (event.error && event.error.type === 'ResourceError') return null; // diagnosisFacts() shows the file
  if (text(ctx.iface)) {
    const callback = text(ctx.callback) ? `, in its callback ${text(ctx.callback)}` : '';
    const code = text(ctx.errorCode) ? ` · error code ${text(ctx.errorCode)}${text(ctx.errorMessage) ? ` (${text(ctx.errorMessage)})` : ''}` : '';
    return { label: 'During', text: `server call "${text(ctx.iface)}"${callback}${code}` };
  }
  if (typeof ctx.url === 'string' && typeof ctx.method === 'string') {
    const type = text(ctx.content_type) ? ` (${text(ctx.content_type)})` : '';
    const result = text(ctx.status) ? `answered ${text(ctx.status)}${type}` : text(ctx.failure) ? `got no response (${text(ctx.failure)})` : '';
    const tookMs = asNumber(ctx.duration_ms);
    const took = tookMs !== null ? ` after ${duration(tookMs)}` : '';
    // Red only when the request failed: a SlowApiCall's context describes a 200.
    const failed = text(ctx.failure) !== '' || (asNumber(ctx.status) ?? 0) >= 400;
    return { label: 'Request', text: `${ctx.method} ${ctx.url} ${result}${took}`.trim(), tone: failed ? 'bad' : '' };
  }
  return null;
}

export interface Insight<F extends InsightFrame = InsightFrame> {
  facts: Fact[];
  frames: ClassifiedFrame<F>[];
  whereToLook: ClassifiedFrame<F> | null;
  moments: Moment[];
  hints: InsightHint[];
}

/**
 * Everything the issue page shows above the raw data.
 *
 * @param event the stored payload (shared schema)
 * @param settings the project's insight settings (library paths, frames to hide, hints)
 * @param receivedAt when the server received it; detects a replaced timestamp (see errorTime)
 */
export function analyzeEvent<F extends InsightFrame>(event: InsightEvent<F>, settings: InsightSettingsInput | null | undefined, receivedAt?: unknown): Insight<F> {
  const frames = classifyFrames(event.stacktrace, settings);
  const errorAt = errorTime(event, receivedAt);
  const crumbs: Crumb[] = (Array.isArray(event.breadcrumbs) ? event.breadcrumbs : []).filter(isRecord);
  const facts: Fact[] = [];

  const stack = stackFact(frames);
  if (stack) facts.push(stack);
  const context = contextFact(event);
  if (context) facts.push(context);

  const request = lastCrumb(crumbs, errorAt, (b) => b.type === 'api');
  if (request && request.beforeMs !== null && request.beforeMs <= TRIGGER_REQUEST_MS && !(context && context.label === 'Request')) {
    const failed = requestFailed(request.crumb);
    facts.push({ label: failed ? 'Failed request' : 'Last request', text: `${asText(request.crumb.message)}${ago(request.beforeMs)}`, tone: failed ? 'bad' : '' });
  }
  // The screen the app named (setScreen) beats the last URL change: on one-URL apps the URL says nothing.
  const named = typeof event.screen === 'string' && event.screen.length > 0 ? event.screen : null;
  const screen = lastCrumb(crumbs, errorAt, (b) => b.type === 'navigation');
  if (named) {
    const opened = screen && screen.crumb.message === `Screen: ${named}` ? ago(screen.beforeMs) : '';
    facts.push({ label: 'Screen', text: `${named}${opened}` });
  } else if (screen) {
    facts.push({ label: 'Screen', text: `${asText(screen.crumb.message)}${ago(screen.beforeMs)}` });
  }
  const click = lastCrumb(crumbs, errorAt, (b) => b.type === 'click');
  if (click) facts.push({ label: 'User did', text: `${asText(click.crumb.message)}${ago(click.beforeMs)}` });

  facts.push(...diagnosisFacts(event));

  const lifecycle = lastCrumb(crumbs, errorAt, (b) => b.type === 'lifecycle');
  const tabHidden = !!lifecycle && /hidden/i.test(asText(lifecycle.crumb.message));
  facts.push(...situationFacts(event, tabHidden));
  if (lifecycle && tabHidden) {
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
