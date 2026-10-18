/**
 * Error Tracker dashboard: a small single-page app with hash routes.
 *
 *   #/login            shared-password login
 *   #/dashboard        overview charts (all projects or one; ?range=24h|7d&project=<id>)
 *   #/projects         projects, create project / API key
 *   #/p/<projectId>    issues of a project (filters in the hash query)
 *   #/i/<issueId>      one issue with its events
 *
 * All event data comes from end users' browsers and is untrusted: the UI is
 * built from DOM nodes with textContent only, never innerHTML.
 */

const REFRESH_MS = 15000;
/** Cached data younger than this is used as is; older data is shown and refreshed in the background. */
const STALE_MS = 10000;
/** Cached data older than this is never shown, the page waits for fresh data instead. */
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
/** The loading spinner only appears if data takes longer than this, so cached pages never flash it. */
const LOADING_DELAY_MS = 150;
const SOFT_RENDER_RETRY_MS = 100;
/** The login session is not re-checked on every page change, only this often. */
const SESSION_RECHECK_MS = 60 * 1000;
const SDK_PACKAGE = '@sourav732/error-tracker-js';
const SCREENSHOT_HOST = 'https://res.cloudinary.com/';
const STATUSES = ['open', 'resolved', 'ignored', 'all'];
const EVENT_TYPES = ['error', 'message', 'performance', 'crash'];

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const sidebar = document.getElementById('sidebar');
const crumbs = document.getElementById('crumbs');
let refreshTimer = null;
let loadingTimer = null;
let sessionCheckedAt = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates an element. `props`: class, text, attrs (object), on<Event> handlers, any DOM property. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'attrs') for (const [a, v] of Object.entries(value)) node.setAttribute(a, v);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node[key] = value;
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

class ApiError extends Error {}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    sessionCheckedAt = 0;
    cache.clear();
    go('#/login');
    throw new ApiError('Session expired');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError((data.error && data.error.message) || `Request failed (${response.status})`);
  // Any change (resolve, delete, new project, login, logout…) makes every cached read suspect: start fresh.
  if (options.method && options.method !== 'GET') cache.clear();
  return data;
}

// ---------------------------------------------------------------------------
// Data cache (stale-while-revalidate)
//   cachedGet(path): cached data right away when there is any (and a background refresh when it is
//   getting old), otherwise a normal fetch. Concurrent reads of one URL share one request. When a
//   background refresh brings new data the current page is redrawn quietly, keeping the scroll position.
// ---------------------------------------------------------------------------

const cache = new Map(); // path → { data, json, at }
const inflight = new Map(); // path → Promise
const revalidating = new Set();
let activeKeys = new Set(); // paths the page on screen was built from
let rendering = false;
let pageGuard = () => true;

function storeInCache(path, data) {
  cache.delete(path); // re-inserting moves it to the end: the Map doubles as an LRU list
  cache.set(path, { data, json: JSON.stringify(data), at: Date.now() });
  if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

function fetchIntoCache(path) {
  let pending = inflight.get(path);
  if (!pending) {
    pending = api(path)
      .then((data) => { storeInCache(path, data); return data; })
      .finally(() => inflight.delete(path));
    inflight.set(path, pending);
  }
  return pending;
}

async function cachedGet(path) {
  activeKeys.add(path);
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MAX_AGE_MS) {
    if (Date.now() - hit.at >= STALE_MS) revalidate(path);
    return hit.data;
  }
  return fetchIntoCache(path);
}

/** Warms the cache (e.g. on hover) so the next page opens instantly. Never throws. */
function prefetch(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < STALE_MS) return;
  fetchIntoCache(path).catch(() => {});
}

/** Refreshes one cached read in the background; redraws the page only if the data changed. */
async function revalidate(path) {
  if (revalidating.has(path)) return;
  revalidating.add(path);
  const before = cache.get(path) && cache.get(path).json;
  try {
    await fetchIntoCache(path);
    const after = cache.get(path);
    if (after && after.json !== before && activeKeys.has(path)) softRender();
  } catch {
    // Offline or server hiccup: keep showing what we have.
  } finally {
    revalidating.delete(path);
  }
}

/** Redraws the current page from the cache without a loading state, unless the user is mid-action. */
async function softRender() {
  const typing = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (rendering) { setTimeout(softRender, SOFT_RENDER_RETRY_MS); return; }
  if (typing || app.querySelector('form, .key-box') || !pageGuard()) return;
  const scroll = window.scrollY;
  await render();
  window.scrollTo(0, scroll);
}

/** Refreshes the page on screen every REFRESH_MS. `guard` can veto a redraw (e.g. rows are selected). */
function startAutoRefresh(guard = () => true) {
  pageGuard = guard;
  refreshTimer = setInterval(() => { for (const path of activeKeys) revalidate(path); }, REFRESH_MS);
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function parseHash() {
  const raw = location.hash.slice(1) || '/dashboard';
  const [path, query = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

function timeAgo(value) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} h ago`;
  if (days < 30) return `${days} d ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '–';
}

/** Drops null/false entries: `replaceChildren(null)` would otherwise render the text "null". */
function nodes(...items) {
  return items.flat().filter((item) => item !== null && item !== undefined && item !== false);
}

/** Highlights the active sidebar link. */
function setNav(name) {
  for (const link of document.querySelectorAll('[data-nav]')) link.classList.toggle('active', link.dataset.nav === name);
}

function setCrumbs(...items) {
  const present = nodes(items);
  crumbs.replaceChildren(...present.flatMap((item, i) => (i > 0 ? [el('span', { text: '/' }), item] : [item])));
}

/** Replaces the page content, ignoring absent (null) sections. */
function show(...items) {
  clearTimeout(loadingTimer);
  app.replaceChildren(...nodes(items));
}

/** Shows the spinner only if the data is slow; until then the previous page stays on screen. */
function loading() {
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    app.replaceChildren(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'Loading…'));
  }, LOADING_DELAY_MS);
}

const ICONS = {
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  check: 'M20 6 9 17l-5-5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
};

/** A rounded icon tile for empty states (static SVG, no event data). */
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return el('div', { class: 'empty-icon' }, svg);
}

function emptyState(iconName, title, text, ...extra) {
  return el('div', { class: 'card empty-state' }, icon(iconName), el('h2', { text: title }), el('p', { text }), ...extra);
}

/** Square tile with the project's initial. */
function avatar(name, large = false) {
  return el('div', { class: `avatar${large ? ' lg' : ''}`, text: (name.trim()[0] || '?').toUpperCase(), attrs: { 'aria-hidden': 'true' } });
}

function showError(error) {
  if (error instanceof ApiError && error.message === 'Session expired') return;
  show(el('div', { class: 'notice error', text: error.message || 'Something went wrong' }));
}

function badge(text, kind = text) {
  return el('span', { class: `badge ${kind}`, text });
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = original), 1500);
  } catch {
    button.textContent = 'Copy failed';
  }
}

function setupSnippet(apiKey) {
  return [
    `npm install ${SDK_PACKAGE}`,
    '',
    `import ErrorTracker from '${SDK_PACKAGE}';`,
    '',
    'ErrorTracker.init({',
    `  apiKey: '${apiKey}',`,
    `  endpoint: '${location.origin}/api/v1/events',`,
    "  environment: 'production',",
    '});',
  ].join('\n');
}

async function getProjects() {
  return (await cachedGet('/api/projects')).projects;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function loginPage() {
  topbar.hidden = true;
  sidebar.hidden = true;
  const input = el('input', { type: 'password', placeholder: 'Dashboard password', required: true, autocomplete: 'current-password', attrs: { 'aria-label': 'Password' } });
  const message = el('p', { class: 'notice error', hidden: true });
  const submit = el('button', { class: 'primary', type: 'submit', text: 'Log in' });
  const form = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      message.hidden = true;
      try {
        await api('/api/auth/login', { method: 'POST', body: { password: input.value } });
        go('#/dashboard');
      } catch (error) {
        message.textContent = error.message;
        message.hidden = false;
        submit.disabled = false;
        input.select();
      }
    },
  }, input, submit, message);

  show(el('div', { class: 'login-wrap' },
    el('div', { class: 'login card' },
      el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }), 'ERROR TRACKER'),
      el('h1', { text: 'Welcome back' }),
      el('p', { class: 'muted', text: 'Log in to Error Tracker to see your projects and issues.' }),
      form,
    )));
  input.focus();
}

// ---------------------------------------------------------------------------
// Dashboard overview (charts are inline SVG built from numbers only)
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const RANGE_LABELS = { '24h': '24H', '7d': '7 DAYS' };
const CHART_SMALL = { width: 300, height: 110 };
const CHART_LARGE = { width: 560, height: 220 };
const CHART_AXIS_WIDTH = 34;
const CHART_LABEL_HEIGHT = 22;
const CHART_GRID_LINES = 4;
const CHART_X_LABELS = 5;
const ISSUE_TICKS = 50;
const PROJECT_ROWS = 4;

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Axis top for a maximum: four equal grid steps of 1, 2, 5 × 10ⁿ (minimum top of 4). */
function niceMax(value) {
  const rough = Math.max(value, CHART_GRID_LINES) / CHART_GRID_LINES;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= rough) || 10) * magnitude;
  return step * CHART_GRID_LINES;
}

function bucketLabel(iso, range) {
  const date = new Date(iso);
  return range === '7d'
    ? date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Column chart. `values` are bar heights, `labels` the x-axis text (a handful are shown).
 * `axis: true` adds a y-axis with dashed grid lines.
 */
function columnChart(values, labels, { size, axis = false }) {
  const { width, height } = size;
  const left = axis ? CHART_AXIS_WIDTH : 0;
  const plotH = height - CHART_LABEL_HEIGHT;
  const top = axis ? niceMax(Math.max(...values, 0)) : Math.max(...values, 1);
  const slot = (width - left) / values.length;
  const barW = Math.max(2, slot * 0.58);
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Bar chart' });

  if (axis) {
    for (let i = 0; i <= CHART_GRID_LINES; i++) {
      const y = plotH - (plotH * i) / CHART_GRID_LINES;
      svg.append(svgEl('line', { class: 'grid-line', x1: left, x2: width, y1: y, y2: y }));
      svg.append(svgEl('text', { x: 0, y: y + 3 }, String(Math.round((top * i) / CHART_GRID_LINES))));
    }
  }
  values.forEach((value, i) => {
    const h = value === 0 ? 0 : Math.max(2, (value / top) * plotH);
    svg.append(svgEl('rect', { class: 'bar', x: left + i * slot + (slot - barW) / 2, y: plotH - h, width: barW, height: h }));
  });
  const every = Math.max(1, Math.floor((values.length - 1) / (CHART_X_LABELS - 1)));
  for (let i = 0; i < values.length; i += every) {
    const x = left + i * slot + slot / 2;
    svg.append(svgEl('text', { x, y: height - 6, 'text-anchor': i === 0 ? 'start' : 'middle' }, labels[i]));
  }
  return svg;
}

function panel(className, label, side, ...content) {
  return el('section', { class: `panel ${className}`.trim() },
    el('div', { class: 'panel-head' }, el('span', { text: label }), el('span', { text: side })), ...content);
}

function deltaText(total, previous, range) {
  if (previous === 0) return total === 0 ? 'No events yet' : 'No events in the previous period';
  const percent = Math.round(((total - previous) / previous) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}% vs previous ${RANGE_LABELS[range].toLowerCase()}`;
}

async function dashboardPage(query) {
  setNav('dashboard');
  setCrumbs(el('span', { text: 'Dashboard' }));
  loading();
  const range = query.get('range') === '7d' ? '7d' : '24h';
  const projects = await getProjects();
  const projectId = projects.some((p) => p.id === query.get('project')) ? query.get('project') : '';
  const stats = await cachedGet(`/api/stats?range=${range}${projectId ? `&projectId=${projectId}` : ''}`);

  const change = (changes) => {
    const next = new URLSearchParams({ range, ...(projectId ? { project: projectId } : {}), ...changes });
    for (const [key, value] of [...next]) if (value === '') next.delete(key);
    go(`#/dashboard?${next}`);
  };
  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Time range' } },
      Object.entries(RANGE_LABELS).map(([key, text]) => el('button', { class: range === key ? 'active' : '', text, onclick: () => change({ range: key }) }))),
    el('select', { attrs: { 'aria-label': 'Project' }, onchange: (e) => change({ project: e.target.value }) },
      el('option', { value: '', text: 'All projects' }),
      projects.map((p) => el('option', { value: p.id, text: p.name, selected: p.id === projectId }))),
  );

  if (projects.length === 0) {
    show(toolbar, emptyState('folder', 'No projects yet', 'Create a project to get an API key. Charts appear once events arrive.',
      el('button', { class: 'primary', attrs: { style: 'margin-top:16px' }, text: 'Create a project', onclick: () => go('#/projects') })));
    return;
  }

  const labels = stats.series.map((b) => bucketLabel(b.start, range));
  const totals = stats.series.map((b) => b.error + b.message + b.performance + b.crash);
  const incidents = stats.series.map((b) => b.error + b.crash);
  const sideLabel = RANGE_LABELS[range];

  const events = panel('', 'Events', sideLabel,
    el('div', { class: 'big', text: stats.total.toLocaleString() }),
    el('div', { class: 'delta', text: deltaText(stats.total, stats.previousTotal, range) }),
    el('div', { attrs: { style: 'margin-top:16px' } }, columnChart(totals, labels, { size: CHART_SMALL })));

  const { open, resolved, ignored } = stats.statuses;
  const issueTotal = open + resolved + ignored;
  const onTicks = issueTotal === 0 ? 0 : Math.round((open / issueTotal) * ISSUE_TICKS);
  const scoped = projects.filter((p) => !projectId || p.id === projectId).slice(0, PROJECT_ROWS);
  const issuesPanel = panel('', 'Issues', 'NOW',
    el('div', { class: 'big' }, open.toLocaleString(), el('small', { text: 'open' })),
    el('div', { class: 'ticks', attrs: { 'aria-hidden': 'true' } }, Array.from({ length: ISSUE_TICKS }, (_, i) => el('i', { class: i < onTicks ? 'on' : '' }))),
    el('div', { class: 'tick-legend' },
      el('span', { text: `Open ${issueTotal === 0 ? 0 : Math.round((open / issueTotal) * 100)}%` }),
      el('span', { class: 'muted', text: `Resolved ${resolved} · Ignored ${ignored}` })),
    el('div', { class: 'list-lines' }, scoped.map((p) =>
      el('a', { href: `#/p/${p.id}` }, el('span', { class: `k${p.openIssues === 0 ? ' off' : ''}`, text: p.name }), el('span', { class: 'muted', text: `${p.openIssues} open` })))));

  const typeMax = Math.max(...Object.values(stats.byType), 1);
  const types = panel('', 'Event types', sideLabel,
    el('div', { class: 'hbars' }, Object.entries(stats.byType).sort((a, b) => b[1] - a[1]).map(([type, n]) =>
      el('div', { class: `hbar-row type-${type}` },
        el('div', { class: 'top' }, el('span', { text: type }), el('span', { text: n.toLocaleString() })),
        el('div', { class: 'hbar' }, el('i', { attrs: { style: `width:${(n / typeMax) * 100}%` } }))))));

  const flow = panel('span-2', 'Error trend monitor', sideLabel,
    el('h3', { class: 'panel-title', text: 'Incident Flow' }),
    el('div', { class: 'legend' }, el('span', {}, el('i'), `Errors + crashes per ${range === '7d' ? 'day' : 'hour'}`)),
    columnChart(incidents, labels, { size: CHART_LARGE, axis: true }));

  const topMax = Math.max(...stats.topIssues.map((i) => i.count), 1);
  const top = panel('', 'Top issues', sideLabel,
    el('h3', { class: 'panel-title', text: 'Incident Volume' }),
    stats.topIssues.length === 0
      ? el('p', { class: 'muted', text: 'No events in this range.' })
      : el('div', { class: 'hbars', attrs: { style: 'margin-top:18px' } }, stats.topIssues.map((issue) =>
          el('a', { class: 'hbar-row', href: `#/i/${issue.id}`, title: issue.message || issue.errorType },
            el('div', { class: 'top' }, el('span', { text: issue.errorType }), el('span', { text: issue.count.toLocaleString() })),
            el('div', { class: 'hbar' }, el('i', { attrs: { style: `width:${(issue.count / topMax) * 100}%` } }))))));

  show(toolbar, el('div', { class: 'dash-grid' }, events, issuesPanel, types, flow, top));
  startAutoRefresh();
}

async function projectsPage() {
  setNav('projects');
  setCrumbs(el('span', { text: 'Projects' }));
  loading();
  const projects = await getProjects();

  const createArea = el('div');
  const newButton = el('button', { class: 'primary', text: 'New project', onclick: () => showCreateForm(createArea, newButton) });

  const cards = projects.map((p) =>
    el('div', { class: 'card project' },
      el('a', { class: 'project-card', href: `#/p/${p.id}` },
        el('div', { class: 'project-top' }, avatar(p.name), el('h2', { text: p.name })),
        el('div', { class: 'stats' },
          el('div', { class: `stat${p.openIssues > 0 ? ' alert' : ''}` }, el('b', { text: p.openIssues.toLocaleString() }), el('span', { class: 'muted small', text: 'open issues' })),
          el('div', { class: 'stat' }, el('b', { text: p.events24h.toLocaleString() }), el('span', { class: 'muted small', text: 'events (24h)' })),
        ),
        el('div', { class: 'key-hint mono', text: `Key: ${p.apiKeyHint}` }),
      ),
    ),
  );

  show(
    el('div', { class: 'page-head' }, el('h1', { text: 'Projects' }), el('span', { class: 'spacer' }), newButton),
    el('p', { class: 'page-sub', text: 'Each app that sends errors is a project with its own API key.' }),
    createArea,
    projects.length > 0 ? el('div', { class: 'grid section' }, cards) : emptyState('folder', 'No projects yet', 'Create your first project to get an API key and start tracking errors.'),
  );
}

function showCreateForm(area, newButton) {
  newButton.disabled = true;
  const input = el('input', { placeholder: 'Project name, e.g. "Web shop"', maxLength: 80, required: true, attrs: { 'aria-label': 'Project name' } });
  const error = el('p', { class: 'notice error', hidden: true });
  const form = el('form', {
    class: 'row',
    onsubmit: async (event) => {
      event.preventDefault();
      try {
        const { project, apiKey } = await api('/api/projects', { method: 'POST', body: { name: input.value } });
        area.replaceChildren(keyBox(`Project "${project.name}" created.`, apiKey, () => projectsPage()));
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
      }
    },
  }, input, el('button', { class: 'primary', type: 'submit', text: 'Create' }),
    el('button', { type: 'button', text: 'Cancel', onclick: () => { area.replaceChildren(); newButton.disabled = false; } }));
  area.replaceChildren(el('div', { class: 'card card-body section' }, form, error));
  input.focus();
}

/** Shows a just-issued API key once, with a ready-to-paste setup snippet. */
function keyBox(title, apiKey, onDone) {
  const copyKey = el('button', { text: 'Copy key', onclick: (e) => copy(apiKey, e.currentTarget) });
  const snippet = setupSnippet(apiKey);
  const copySnippet = el('button', { text: 'Copy setup code', onclick: (e) => copy(snippet, e.currentTarget) });
  return el('div', { class: 'card card-body section' },
    el('h2', { text: title }),
    el('p', { text: 'Copy this API key now. For security it is stored hashed and cannot be shown again.' }),
    el('div', { class: 'key-box row' }, el('code', { text: apiKey }), el('span', { class: 'spacer' }), copyKey),
    el('p', { class: 'muted section', text: 'Add the SDK to your app:' }),
    el('div', { class: 'key-box' }, el('pre', { text: snippet })),
    el('div', { class: 'row section' }, copySnippet, el('span', { class: 'spacer' }), el('button', { class: 'primary', text: 'Done', onclick: onDone })),
  );
}

async function issuesPage(projectId, query) {
  setNav('projects');
  loading();
  const projects = await getProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Project not found');
  setCrumbs(el('a', { href: '#/projects', text: 'Projects' }), el('span', { text: project.name }));

  const filters = {
    status: query.get('status') || 'open',
    type: query.get('type') || '',
    env: query.get('env') || '',
    q: query.get('q') || '',
    sort: query.get('sort') || 'lastSeen',
    page: Number(query.get('page')) || 1,
  };
  const params = new URLSearchParams({ projectId, ...filters, page: String(filters.page) });
  for (const [key, value] of [...params]) if (value === '') params.delete(key);
  const data = await cachedGet(`/api/issues?${params}`);

  const setFilter = (changes) => {
    const next = new URLSearchParams({ ...filters, page: '1', ...changes });
    for (const [key, value] of [...next]) if (value === '' || (key === 'page' && value === '1')) next.delete(key);
    go(`#/p/${projectId}?${next}`);
  };

  const allCount = data.counts.open + data.counts.resolved + data.counts.ignored;
  const tabs = el('div', { class: 'tabs', attrs: { role: 'tablist' } },
    STATUSES.map((s) => el('button', {
      class: filters.status === s ? 'active' : '',
      text: `${s[0].toUpperCase()}${s.slice(1)} (${s === 'all' ? allCount : data.counts[s]})`,
      attrs: { role: 'tab', 'aria-selected': String(filters.status === s) },
      onclick: () => setFilter({ status: s }),
    })),
  );

  const search = el('input', { type: 'search', placeholder: 'Search message, type or location…', value: filters.q, attrs: { 'aria-label': 'Search issues' } });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') setFilter({ q: search.value.trim() }); });
  const select = (label, value, options, key) =>
    el('select', { attrs: { 'aria-label': label }, onchange: (e) => setFilter({ [key]: e.target.value }) },
      options.map(([v, text]) => el('option', { value: v, text, selected: v === value })));

  const filterBar = el('div', { class: 'filters' },
    search,
    select('Event type', filters.type, [['', 'All types'], ...EVENT_TYPES.map((t) => [t, t])], 'type'),
    select('Environment', filters.env, [['', 'All environments'], ...data.environments.map((e) => [e, e])], 'env'),
    select('Sort', filters.sort, [['lastSeen', 'Last seen'], ['count', 'Most events'], ['firstSeen', 'Newest']], 'sort'),
  );

  const selected = new Set();
  const deleteSelected = el('button', { class: 'danger', text: 'Delete selected', disabled: true });
  const updateSelection = () => {
    deleteSelected.disabled = selected.size === 0;
    deleteSelected.textContent = selected.size > 0 ? `Delete selected (${selected.size})` : 'Delete selected';
  };
  deleteSelected.addEventListener('click', async () => {
    if (!confirm(`Delete ${selected.size} issue(s) and all their events? This can't be undone.`)) return;
    await api(`/api/issues?projectId=${projectId}`, { method: 'DELETE', body: { ids: [...selected] } });
    render();
  });
  const selectAll = el('input', { type: 'checkbox', attrs: { 'aria-label': 'Select all issues on this page' } });
  const boxes = [];
  selectAll.addEventListener('change', () => {
    for (const box of boxes) { box.checked = selectAll.checked; box.dispatchEvent(new Event('change')); }
  });

  let list;
  if (data.issues.length === 0) {
    list = allCount === 0
      ? emptyState('inbox', 'No issues yet',
          `Errors appear here as soon as an app using this project's key (${project.apiKeyHint}) sends them. Setup:`,
          el('div', { class: 'key-box', attrs: { style: 'text-align:left;margin-top:16px;max-width:100%' } }, el('pre', { text: setupSnippet('<your API key>') })))
      : emptyState('search', 'No issues match these filters', 'Try a different status, type or search term.');
  } else {
    list = el('div', { class: 'card issue-list' },
      el('div', { class: 'list-head' }, selectAll, el('span', { text: 'Issue' }), el('span', { text: 'Events' }), el('span', { text: 'Last seen' })),
      data.issues.map((issue) => {
        const box = el('input', { type: 'checkbox', attrs: { 'aria-label': 'Select issue' } });
        box.addEventListener('change', () => { if (box.checked) selected.add(issue.id); else selected.delete(issue.id); updateSelection(); });
        box.addEventListener('click', (e) => e.stopPropagation());
        boxes.push(box);
        return el('a', { class: `issue-row sev-${issue.eventType}`, href: `#/i/${issue.id}`, onmouseenter: () => prefetch(`/api/issue?id=${issue.id}`), onfocus: () => prefetch(`/api/issue?id=${issue.id}`) },
          box,
          el('div', { attrs: { style: 'min-width:0' } },
            el('div', { class: 'issue-title' }, badge(issue.eventType), issue.errorType,
              issue.status !== 'open' ? badge(issue.status) : null,
              issue.regressedAt && issue.status === 'open' ? badge('regressed', 'error') : null),
            el('div', { class: 'issue-msg', text: issue.message || '(no message)' }),
            el('div', { class: 'issue-meta', text: [issue.culprit, issue.environments.join(', ')].filter(Boolean).join(' · ') }),
          ),
          el('div', { class: 'issue-count', text: issue.count.toLocaleString() }),
          el('div', { class: 'issue-when', text: timeAgo(issue.lastSeen), title: formatDate(issue.lastSeen) }),
        );
      }),
    );
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pager = pages > 1
    ? el('div', { class: 'pager' },
        el('button', { text: 'Previous', disabled: filters.page <= 1, onclick: () => setFilter({ page: String(filters.page - 1) }) }),
        el('span', { class: 'muted', text: `Page ${filters.page} of ${pages}` }),
        el('button', { text: 'Next', disabled: filters.page >= pages, onclick: () => setFilter({ page: String(filters.page + 1) }) }))
    : null;

  const rotate = el('button', {
    class: 'ghost',
    text: 'Rotate API key',
    onclick: async () => {
      if (!confirm(`Replace the API key of "${project.name}"? Apps using the old key stop sending errors until updated.`)) return;
      const { apiKey } = await api(`/api/projects?id=${projectId}&action=rotate-key`, { method: 'POST' });
      show(keyBox(`New API key for "${project.name}"`, apiKey, () => go(`#/p/${projectId}`)));
      clearInterval(refreshTimer);
    },
  });

  const clearLabel = filters.status === 'all' ? 'all' : filters.status;
  const clearCount = filters.status === 'all' ? allCount : data.counts[filters.status];
  const clearAll = el('button', {
    class: 'danger',
    text: filters.status === 'all' ? `Delete everything (${clearCount})` : `Delete all ${clearLabel} (${clearCount})`,
    disabled: clearCount === 0,
    onclick: async () => {
      if (!confirm(`Delete ALL ${clearCount} ${filters.status === 'all' ? '' : clearLabel + ' '}issue(s) of "${project.name}" with their events? This can't be undone.`)) return;
      await api(`/api/issues?projectId=${projectId}&status=${filters.status}`, { method: 'DELETE' });
      render();
    },
  });
  const deleteProject = el('button', {
    class: 'ghost danger',
    text: 'Delete project',
    onclick: async () => {
      if (!confirm(`Delete the project "${project.name}", every issue and event in it, and its API key? Apps using the key stop reporting. This can't be undone.`)) return;
      clearInterval(refreshTimer);
      await api(`/api/projects?id=${projectId}`, { method: 'DELETE' });
      go('#/projects');
    },
  });

  show(
    el('div', { class: 'page-head' }, avatar(project.name, true), el('h1', { text: project.name }), el('span', { class: 'spacer' }), rotate, deleteProject),
    el('p', { class: 'page-sub', text: `${data.total} issue(s) · refreshes every ${REFRESH_MS / 1000}s` }),
    tabs, filterBar,
    data.issues.length > 0 ? el('div', { class: 'row bulk' }, deleteSelected, el('span', { class: 'spacer' }), clearAll) : null,
    list, pager,
  );
  // Keep the search box focused across auto-refreshes.
  if (query.get('q')) search.focus();
  startAutoRefresh(() => selected.size === 0);
}

async function issuePage(issueId, query) {
  setNav('projects');
  loading();
  const data = await cachedGet(`/api/issue?id=${issueId}`);
  const { issue } = data;
  const selectedId = query.get('event') || (data.latestEvent && data.latestEvent.id);
  const event = !selectedId ? null
    : data.latestEvent && data.latestEvent.id === selectedId ? data.latestEvent
    : (await cachedGet(`/api/event?id=${selectedId}`)).event;

  setCrumbs(
    el('a', { href: '#/projects', text: 'Projects' }),
    data.project ? el('a', { href: `#/p/${data.project.id}`, text: data.project.name }) : null,
    el('span', { text: issue.errorType }),
  );

  const setStatus = async (status) => {
    await api(`/api/issue?id=${issueId}`, { method: 'PATCH', body: { status } });
    render();
  };
  const actions = el('div', { class: 'row' },
    issue.status !== 'resolved' ? el('button', { class: 'primary', text: 'Resolve', onclick: () => setStatus('resolved') }) : null,
    issue.status !== 'ignored' ? el('button', { text: 'Ignore', onclick: () => setStatus('ignored') }) : null,
    issue.status !== 'open' ? el('button', { text: 'Reopen', onclick: () => setStatus('open') }) : null,
    el('button', {
      class: 'danger',
      text: 'Delete',
      onclick: async () => {
        if (!confirm(`Delete this issue and its ${issue.count.toLocaleString()} event(s)? This can't be undone.`)) return;
        await api(`/api/issue?id=${issueId}`, { method: 'DELETE' });
        go(data.project ? `#/p/${data.project.id}` : '#/projects');
      },
    }),
  );

  const header = el('div', { class: 'card card-body' },
    el('div', { class: 'issue-header' },
      el('div', { class: 'title' },
        el('div', { class: 'row' }, badge(issue.eventType), badge(issue.status), issue.regressedAt && issue.status === 'open' ? badge('regressed', 'error') : null),
        el('h1', { text: issue.errorType }),
        el('div', { class: 'message', text: issue.message || '(no message)' }),
        issue.culprit ? el('div', { class: 'culprit mono small', text: issue.culprit }) : null,
      ),
      actions,
    ),
    el('div', { class: 'meta' },
      metaItem('Events', issue.count.toLocaleString()),
      metaItem('First seen', timeAgo(issue.firstSeen), formatDate(issue.firstSeen)),
      metaItem('Last seen', timeAgo(issue.lastSeen), formatDate(issue.lastSeen)),
      metaItem('Environments', issue.environments.join(', ') || '–'),
      metaItem('Platforms', issue.platforms.join(', ') || '–'),
    ),
  );

  const eventsList = el('div', { class: 'card events-list' },
    data.events.map((e) => el('button', {
      class: e.id === selectedId ? 'active' : '',
      onclick: () => go(`#/i/${issueId}?event=${e.id}`),
    },
      el('div', { text: timeAgo(e.receivedAt), title: formatDate(e.receivedAt) }),
      el('div', { class: 'muted small', text: [e.environment, e.browser, e.userId ? `user ${e.userId}` : null].filter(Boolean).join(' · ') }),
    )),
  );

  show(header, el('div', { class: 'detail' },
    el('div', {}, el('h2', { text: `Latest events (${data.events.length})` }), eventsList),
    event ? eventDetail(event) : emptyState('inbox', 'No events stored', 'Older events are deleted after 30 days.'),
  ));
  startAutoRefresh();
}

function metaItem(label, value, title) {
  return el('div', {}, el('span', { text: label }), el('b', { text: value, title }));
}

function kv(rows) {
  return el('dl', { class: 'kv' },
    rows.filter(([, value]) => value !== null && value !== undefined && value !== '')
      .flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: String(value) })]));
}

function section(title, ...content) {
  return el('div', { class: 'card card-body section' }, el('h2', { text: title }), ...content);
}

function eventDetail(event) {
  const p = event.payload;
  const parts = [];

  parts.push(section('Event',
    kv([
      ['Time', formatDate(p.timestamp)],
      ['Received', formatDate(event.receivedAt)],
      ['Environment', p.environment],
      ['App version', p.app_version],
      ['Level', p.level],
      ['Handled', p.error ? (p.error.handled ? 'yes' : 'no') : null],
      ['Page', p.device.url],
      ['User', [p.user.id, p.user.name, p.user.email].filter(Boolean).join(' · ')],
      ['SDK', `${p.sdk.name} ${p.sdk.version || ''}`],
    ]),
  ));

  if (p.stacktrace.length > 0) {
    parts.push(section('Stack trace',
      el('div', { class: 'frames' },
        p.stacktrace.map((f) => el('div', { class: 'frame mono' },
          el('span', { class: 'fn', text: f.function }), ' ',
          el('span', { class: 'muted', text: `${f.filename || '?'}${f.lineno !== null ? ':' + f.lineno : ''}${f.colno !== null ? ':' + f.colno : ''}` }),
        )),
      ),
    ));
  }

  if (event.screenshotUrl && event.screenshotUrl.startsWith(SCREENSHOT_HOST)) {
    parts.push(section('Screenshot',
      el('a', { class: 'screenshot', href: event.screenshotOriginalUrl, target: '_blank', rel: 'noopener noreferrer' },
        el('img', { src: event.screenshotUrl, alt: 'Screenshot of the page when the error happened', loading: 'lazy' })),
    ));
  } else if (event.screenshotSkipped) {
    parts.push(section('Screenshot', el('p', { class: 'muted', text: `Not stored (${event.screenshotSkipped.replace(/_/g, ' ')}).` })));
  }

  if (p.breadcrumbs.length > 0) {
    parts.push(section(`Breadcrumbs (${p.breadcrumbs.length})`,
      el('ul', { class: 'timeline' },
        p.breadcrumbs.slice().reverse().map((b) => el('li', {},
          el('span', { class: 'muted mono small', text: b.timestamp ? new Date(b.timestamp).toLocaleTimeString() : '' }),
          el('span', { class: 'bc-type' }, badge(b.type, 'info')),
          el('span', { text: b.message }),
        )),
      ),
    ));
  }

  if (p.context) parts.push(section('Context', el('pre', { class: 'mono', text: JSON.stringify(p.context, null, 2) })));

  parts.push(section('Device', kv([
    ['Platform', p.device.platform],
    ['OS', [p.device.os, p.device.os_version].filter(Boolean).join(' · ')],
    ['Browser', [p.device.browser, p.device.browser_version].filter(Boolean).join(' ')],
    ['Device', [p.device.manufacturer, p.device.model].filter(Boolean).join(' ')],
    ['Screen', p.device.screen_width ? `${p.device.screen_width} × ${p.device.screen_height}` : null],
    ['Locale', p.device.locale],
    ['Referrer', p.device.referrer],
  ])));

  const perf = p.performance;
  const ms = (v) => (v === null ? null : `${v} ms`);
  parts.push(section('Performance',
    kv([
      ['Page load', ms(perf.page_load_ms)], ['TTFB', ms(perf.ttfb_ms)], ['FCP', ms(perf.fcp_ms)], ['LCP', ms(perf.lcp_ms)],
      ['CLS', perf.cls], ['Startup', ms(perf.startup_ms)], ['Frame rate', perf.frame_rate_fps === null ? null : `${perf.frame_rate_fps} fps`],
      ['Slow screen', perf.slow_screen ? 'yes' : null],
      ['Memory', p.memory.used_mb !== null ? `${p.memory.used_mb} MB of ${p.memory.total_mb} MB${p.memory.leak_suspected ? ' · leak suspected' : ''}` : null],
    ]),
    perf.api_calls.length > 0
      ? el('details', { class: 'section' }, el('summary', { text: `API calls (${perf.api_calls.length})` }),
          el('pre', { text: perf.api_calls.map((c) => `${c.method} ${c.url} → ${c.status} (${c.duration_ms} ms)`).join('\n') }))
      : null,
  ));

  parts.push(el('details', { class: 'section' }, el('summary', { text: 'Raw event JSON' }), el('pre', { text: JSON.stringify(p, null, 2) })));
  return el('div', {}, parts);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function render() {
  clearInterval(refreshTimer);
  clearTimeout(loadingTimer);
  activeKeys = new Set();
  pageGuard = () => true;
  rendering = true;
  const { parts, query } = parseHash();
  try {
    if (parts[0] === 'login') return loginPage();
    if (Date.now() - sessionCheckedAt > SESSION_RECHECK_MS) {
      const session = await api('/api/auth/session');
      if (!session.authenticated) return go('#/login');
      sessionCheckedAt = Date.now();
    }
    topbar.hidden = false;
    sidebar.hidden = false;
    if (parts[0] === 'projects') return await projectsPage();
    if (parts[0] === 'p' && parts[1]) return await issuesPage(parts[1], query);
    if (parts[0] === 'i' && parts[1]) return await issuePage(parts[1], query);
    return await dashboardPage(query);
  } catch (error) {
    showError(error);
  } finally {
    rendering = false;
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  sessionCheckedAt = 0;
  go('#/login');
});

for (const button of document.querySelectorAll('[data-theme-set]')) {
  button.addEventListener('click', () => {
    document.documentElement.setAttribute('data-theme', button.dataset.themeSet);
    try { localStorage.setItem('et_theme', button.dataset.themeSet); } catch { /* storage blocked: theme just isn't remembered */ }
    syncThemeButtons();
  });
}
function syncThemeButtons() {
  const current = document.documentElement.getAttribute('data-theme');
  for (const button of document.querySelectorAll('[data-theme-set]')) button.classList.toggle('active', button.dataset.themeSet === current);
}
syncThemeButtons();
window.addEventListener('hashchange', render);
// Coming back to the tab: bring the page up to date right away instead of waiting for the next tick.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) for (const path of activeKeys) revalidate(path);
});
render();
