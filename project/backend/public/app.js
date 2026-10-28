/**
 * Error Tracker dashboard: a small single-page app with hash routes.
 *
 *   #/login, #/signup  accounts (anyone can sign up; each user sees only their own projects)
 *   #/dashboard        overview charts (all projects or one; ?range=24h|7d&project=<id>)
 *   #/performance      Web Vitals, endpoints and pages (&env=, &endpoint=<key> or &page=<route> for a detail view)
 *   #/projects         projects, create project / API key
 *   #/p/<projectId>    issues of a project (filters in the hash query)
 *   #/i/<issueId>      one issue with its events
 *   #/account          profile, password, sessions, delete account
 *   #/admin            users and usage (admins only)
 *
 * All event data comes from end users' browsers and is untrusted: the UI is
 * built from DOM nodes with textContent only, never innerHTML.
 */

import { analyzeEvent, APP_PATH_PREFIX, BUILT_IN_LIBRARY_NAMES, frameLabel, insightSettings, stackText } from './insights.js';

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
const STATUSES = ['open', 'resolved', 'ignored', 'all'];
const EVENT_TYPES = ['error', 'message', 'performance', 'crash'];
/** Mirrors the server's rules (lib/constants.js); the server re-checks everything. */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_ROUTES = ['login', 'signup'];
const TOAST_MS = 3600;
const TOAST_EXIT_MS = 250;

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const sidebar = document.getElementById('sidebar');
const crumbs = document.getElementById('crumbs');
let loadingTimer = null;
let sessionCheckedAt = 0;
/** The logged-in user ({ id, email, name, role }), or null. */
let me = null;
/** Where to go after logging in (the page that asked for a login). */
let returnTo = null;
let fieldSeq = 0;
/** A just-created project's key, shown once on the redrawn Projects page. */
let pendingKey = null;
/** Project whose "Allowed origins" panel is open, so it stays open across redraws. */
let originsOpenFor = null;
/** Project whose "Issue insights" panel is open. */
let insightsOpenFor = null;

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

class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('Network error. Check your connection and try again.', { code: 'network' });
  }
  if (response.status === 401 && !path.startsWith('/api/auth')) {
    forgetSession();
    if (!AUTH_ROUTES.includes(parseHash().parts[0])) returnTo = location.hash;
    go('#/login');
    throw new ApiError('Session expired', { status: 401, code: 'session_expired' });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError((data.error && data.error.message) || `Request failed (${response.status})`, {
      status: response.status,
      code: data.error && data.error.code,
    });
  }
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

/** `guard` can veto the quiet redraw that follows a background refresh (e.g. while rows are selected). */
function guardRedraw(guard) {
  pageGuard = guard;
}

/** The header's refresh button: fetches everything the page on screen shows, then redraws it. */
async function refreshNow(button) {
  if (rendering || button.classList.contains('spinning')) return;
  button.classList.add('spinning');
  const scroll = window.scrollY;
  try {
    await Promise.all([...activeKeys].map((path) => fetchIntoCache(path)));
    await render();
    window.scrollTo(0, scroll);
  } catch {
    // The page keeps what it shows; the spinner just stops.
  } finally {
    button.classList.remove('spinning');
  }
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
  if (error instanceof ApiError && error.code === 'session_expired') return;
  show(el('div', { class: 'notice error', text: error.message || 'Something went wrong' }));
}

function forgetSession() {
  me = null;
  sessionCheckedAt = 0;
  cache.clear();
}

// ---------------------------------------------------------------------------
// UI kit: toasts, dialogs, form fields, busy buttons
// ---------------------------------------------------------------------------

/** Short confirmation at the bottom of the screen. `kind`: success | error. */
function toast(message, kind = 'success') {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${kind}`, attrs: { role: kind === 'error' ? 'alert' : 'status' } }, el('span', { class: 'toast-dot' }), el('span', { text: message }));
  host.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), TOAST_EXIT_MS);
  }, TOAST_MS);
}

/** Wraps a click handler: failures become an error toast instead of an unhandled rejection. */
function action(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'session_expired')) toast(error.message || 'Something went wrong', 'error');
    }
  };
}

/** Disables a button and shows a spinner in it while work is in progress. */
function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('busy', busy);
  button.setAttribute('aria-busy', String(busy));
}

/**
 * Modal dialog. Resolves with `true` (or the typed value when `input` is given),
 * or `false`/`null` when cancelled. With `onConfirm`, the dialog stays open and
 * shows the error if that async step fails (e.g. a wrong password).
 */
function openDialog({ title, message, confirmText = 'Confirm', danger = false, input = null, onConfirm = null }) {
  return new Promise((resolve) => {
    const cancelled = input ? null : false;
    const inputField = input
      ? field({ label: input.label, type: input.type || 'text', autocomplete: input.autocomplete || 'off', placeholder: input.placeholder || '' })
      : null;
    if (inputField && input.type === 'password') addPasswordToggle(inputField);
    const error = el('p', { class: 'notice error', hidden: true, attrs: { role: 'alert' } });
    const confirmButton = el('button', { class: danger ? 'danger solid' : 'primary', type: 'submit', text: confirmText });
    const cancelButton = el('button', { type: 'button', text: 'Cancel' });
    const form = el('form', { class: 'modal-body', noValidate: true },
      el('h2', { class: 'modal-title', text: title }),
      message ? el('p', { class: 'modal-text', text: message }) : null,
      inputField && inputField.wrap,
      error,
      el('div', { class: 'modal-actions' }, cancelButton, confirmButton));
    const dialog = el('dialog', { class: `modal${danger ? ' modal-danger' : ''}`, attrs: { 'aria-label': title } }, form);

    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancelButton.addEventListener('click', () => finish(cancelled));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (!confirmButton.disabled) finish(cancelled); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog && !confirmButton.disabled) finish(cancelled); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = inputField ? inputField.input.value : true;
      if (inputField && value.trim() === '') { inputField.setError('This field is required'); inputField.input.focus(); return; }
      if (!onConfirm) { finish(value); return; }
      setBusy(confirmButton, true);
      cancelButton.disabled = true;
      error.hidden = true;
      try {
        await onConfirm(value);
        finish(value);
      } catch (failure) {
        setBusy(confirmButton, false);
        cancelButton.disabled = false;
        if (inputField) { inputField.setError(failure.message); inputField.input.select(); } else { error.textContent = failure.message; error.hidden = false; }
      }
    });

    document.body.append(dialog);
    dialog.showModal();
    (inputField ? inputField.input : cancelButton).focus();
  });
}

/** Labelled input with hint and inline error. Extra props go to the <input>. */
function field({ label, hint, ...props }) {
  const id = `f${++fieldSeq}`;
  const input = el('input', { ...props, id });
  const error = el('p', { class: 'field-error', hidden: true, attrs: { id: `${id}-error` } });
  const wrap = el('div', { class: 'field' },
    el('label', { class: 'field-label', text: label, attrs: { for: id } }),
    input,
    hint ? el('p', { class: 'field-hint', text: hint }) : null,
    error);
  input.addEventListener('input', () => setError(''));
  function setError(message) {
    error.textContent = message || '';
    error.hidden = !message;
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', error.id);
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }
  return { wrap, input, setError };
}

/** Adds a Show/Hide button inside a password field. */
function addPasswordToggle(passwordField) {
  const { input } = passwordField;
  const toggle = el('button', { type: 'button', class: 'input-addon', text: 'Show', attrs: { 'aria-label': 'Show password', 'aria-pressed': 'false' } });
  toggle.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    toggle.textContent = reveal ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    toggle.setAttribute('aria-pressed', String(reveal));
    input.focus();
  });
  const box = el('div', { class: 'input-wrap' });
  input.replaceWith(box);
  box.append(input, toggle);
  return passwordField;
}

function passwordField(props) {
  return addPasswordToggle(field({ type: 'password', maxLength: MAX_PASSWORD_LENGTH, ...props }));
}

const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

/** 0 (too short) to 4 (strong): length, mixed case, digits and symbols. */
function passwordScore(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return 0;
  let score = 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  return score;
}

/** Four-segment strength bar that follows a password input. */
function strengthMeter(input) {
  const bars = Array.from({ length: 4 }, () => el('i'));
  const label = el('span', { class: 'strength-label' });
  const meter = el('div', { class: 'strength', hidden: true, attrs: { 'aria-live': 'polite' } }, el('div', { class: 'strength-bars' }, bars), label);
  input.addEventListener('input', () => {
    const score = passwordScore(input.value);
    meter.hidden = input.value.length === 0;
    meter.dataset.score = String(score);
    bars.forEach((bar, i) => bar.classList.toggle('on', i < score));
    label.textContent = STRENGTH_LABELS[score];
  });
  return meter;
}

/** Client-side check of a new password; the server applies the same rules. */
function newPasswordProblem(password, email = '') {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.trim() === '') return 'Password cannot be only spaces';
  if (email && password.toLowerCase() === email.trim().toLowerCase()) return 'Password cannot be your email address';
  return null;
}

/** Small theme switch (dark / light), used on the login and sign-up pages. */
function themeToggle() {
  const make = (theme, label, path) => {
    const button = el('button', { type: 'button', attrs: { 'data-theme-set': theme, 'aria-label': label, title: label } });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(SVG_NS, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    button.append(svg);
    button.classList.toggle('active', document.documentElement.getAttribute('data-theme') === theme);
    bindThemeButton(button);
    return button;
  };
  return el('div', { class: 'theme-toggle', attrs: { role: 'group', 'aria-label': 'Theme' } },
    make('dark', 'Dark theme', 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'),
    make('light', 'Light theme', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'));
}

function firstName(user) {
  return (user && user.name ? user.name.split(' ')[0] : '') || 'there';
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

// ---------------------------------------------------------------------------
// Sign up / log in
// ---------------------------------------------------------------------------

const AUTH_FEATURES = [
  ['Every error, grouped', 'Uncaught exceptions, failed requests and crashes, grouped into issues with stack traces and breadcrumbs.'],
  ['Performance & 404s', 'Slow pages, slow API calls, frozen UIs, memory leaks and missing pages, out of the box.'],
  ['Private by default', 'Your projects and their data are visible only to your account.'],
];

/** Split layout: product intro on the left, the form card on the right. */
function authLayout(card) {
  const check = () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS.check);
    svg.append(path);
    return el('span', { class: 'feature-icon' }, svg);
  };
  const snippet = [`import ErrorTracker from '${SDK_PACKAGE}';`, '', 'ErrorTracker.init({', "  apiKey: 'et_…',", `  endpoint: '${location.origin}/api/v1/events',`, '});'].join('\n');
  return el('div', { class: 'auth' },
    el('section', { class: 'auth-hero', attrs: { 'aria-label': 'About Error Tracker' } },
      el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }), 'ERROR TRACKER'),
      el('div', { class: 'auth-pitch' },
        el('p', { class: 'eyebrow', text: 'Error monitoring for web apps' }),
        el('h2', { class: 'auth-headline', text: 'Know about every error before your users report it.' }),
        el('ul', { class: 'auth-features' }, AUTH_FEATURES.map(([title, text]) => el('li', {}, check(), el('div', {}, el('b', { text: title }), el('span', { text }))))),
        el('div', { class: 'auth-code' }, el('div', { class: 'auth-code-head' }, el('i'), el('i'), el('i'), el('span', { text: 'app.js' })), el('pre', { text: snippet }))),
      el('p', { class: 'auth-foot', text: 'Free to use · Zero-dependency SDK · Set up in two minutes' })),
    el('div', { class: 'auth-main' },
      el('div', { class: 'auth-top' }, el('div', { class: 'brand auth-brand-mobile' }, el('span', { class: 'brand-mark' }), 'ERROR TRACKER'), el('span', { class: 'spacer' }), themeToggle()),
      el('div', { class: 'auth-card' }, card)));
}

/** Shows a server error next to the field it belongs to, or in the form's banner. */
function showFormError(error, fieldsByCode, banner) {
  const target = fieldsByCode[error.code];
  if (target) {
    target.setError(error.message);
    target.input.focus();
  } else {
    banner.textContent = error.message;
    banner.hidden = false;
  }
}

function afterLogin(user) {
  me = user;
  sessionCheckedAt = Date.now();
  updateChrome();
  const target = returnTo && !AUTH_ROUTES.some((r) => returnTo.startsWith(`#/${r}`)) ? returnTo : '#/dashboard';
  returnTo = null;
  go(target);
}

function loginPage() {
  const email = field({ label: 'Email', type: 'email', name: 'email', autocomplete: 'email', maxLength: 254, placeholder: 'you@company.com' });
  const password = passwordField({ label: 'Password', name: 'password', autocomplete: 'current-password' });
  const banner = el('div', { class: 'notice error', hidden: true, attrs: { role: 'alert' } });
  const submit = el('button', { class: 'primary block', type: 'submit', text: 'Log in' });

  const form = el('form', {
    class: 'auth-form',
    noValidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      banner.hidden = true;
      let invalid = null;
      if (password.input.value === '') { password.setError('Enter your password'); invalid = password; }
      if (!EMAIL_PATTERN.test(email.input.value.trim())) { email.setError('Enter a valid email address'); invalid = email; }
      if (invalid) { invalid.input.focus(); return; }
      setBusy(submit, true);
      try {
        const { user } = await api('/api/auth?action=login', { method: 'POST', body: { email: email.input.value, password: password.input.value } });
        afterLogin(user);
      } catch (error) {
        setBusy(submit, false);
        showFormError(error, {}, banner);
        if (error.code === 'invalid_credentials') password.input.select();
      }
    },
  }, banner, email.wrap, password.wrap, submit);

  show(authLayout(el('div', {},
    el('h1', { text: 'Log in' }),
    el('p', { class: 'auth-sub', text: 'Welcome back. Enter your details to see your projects.' }),
    form,
    el('p', { class: 'auth-switch' }, 'New to Error Tracker? ', el('a', { href: '#/signup', text: 'Create an account' })))));
  email.input.focus();
}

function signupPage() {
  const name = field({ label: 'Full name', name: 'name', autocomplete: 'name', maxLength: 80, placeholder: 'Jane Doe' });
  const email = field({ label: 'Work email', type: 'email', name: 'email', autocomplete: 'email', maxLength: 254, placeholder: 'you@company.com' });
  const password = passwordField({ label: 'Password', name: 'new-password', autocomplete: 'new-password', hint: `At least ${MIN_PASSWORD_LENGTH} characters. A longer passphrase is stronger.` });
  password.wrap.append(strengthMeter(password.input));
  const banner = el('div', { class: 'notice error', hidden: true, attrs: { role: 'alert' } });
  const submit = el('button', { class: 'primary block', type: 'submit', text: 'Create account' });

  const form = el('form', {
    class: 'auth-form',
    noValidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      banner.hidden = true;
      const problems = [
        [password, newPasswordProblem(password.input.value, email.input.value)],
        [email, EMAIL_PATTERN.test(email.input.value.trim()) ? null : 'Enter a valid email address'],
        [name, name.input.value.trim() ? null : 'Enter your name'],
      ].filter(([, problem]) => problem);
      for (const [f, problem] of problems) f.setError(problem);
      if (problems.length > 0) { problems.at(-1)[0].input.focus(); return; }
      setBusy(submit, true);
      try {
        const { user } = await api('/api/auth?action=signup', {
          method: 'POST',
          body: { name: name.input.value, email: email.input.value, password: password.input.value },
        });
        toast(`Welcome, ${firstName(user)}! Your account is ready.`);
        afterLogin(user);
      } catch (error) {
        setBusy(submit, false);
        showFormError(error, { invalid_email: email, email_taken: email, invalid_name: name, weak_password: password }, banner);
      }
    },
  }, banner, name.wrap, email.wrap, password.wrap, submit);

  show(authLayout(el('div', {},
    el('h1', { text: 'Create your account' }),
    el('p', { class: 'auth-sub', text: 'Start tracking errors in your apps. It only takes a minute.' }),
    form,
    el('p', { class: 'auth-switch' }, 'Already have an account? ', el('a', { href: '#/login', text: 'Log in' })))));
  name.input.focus();
}

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------

function settingsCard(title, description, ...content) {
  return el('section', { class: 'card settings-card' },
    el('div', { class: 'settings-head' }, el('h3', { text: title }), description ? el('p', { class: 'muted', text: description }) : null),
    el('div', { class: 'settings-body' }, ...content));
}

async function accountPage() {
  setNav('account');
  setCrumbs(el('span', { text: 'Account' }));
  loading();
  const { user, usage } = await cachedGet('/api/account');
  me = user;
  updateChrome();

  const name = field({ label: 'Name', value: user.name, autocomplete: 'name', maxLength: 80 });
  const email = field({ label: 'Email', value: user.email, type: 'email', readOnly: true, hint: 'Your email is your login and cannot be changed.' });
  const saveName = el('button', { class: 'primary', type: 'submit', text: 'Save changes' });
  const profileForm = el('form', {
    class: 'settings-form',
    noValidate: true,
    onsubmit: action(async (event) => {
      event.preventDefault();
      if (!name.input.value.trim()) { name.setError('Enter your name'); name.input.focus(); return; }
      setBusy(saveName, true);
      try {
        const res = await api('/api/account', { method: 'PATCH', body: { name: name.input.value } });
        me = res.user;
        updateChrome();
        name.input.value = res.user.name;
        toast('Profile saved');
      } catch (error) {
        if (error.code === 'invalid_name') name.setError(error.message);
        else toast(error.message, 'error');
      } finally {
        setBusy(saveName, false);
      }
    }),
  }, name.wrap, email.wrap, el('div', { class: 'form-actions' }, saveName));

  const current = passwordField({ label: 'Current password', autocomplete: 'current-password' });
  const next = passwordField({ label: 'New password', autocomplete: 'new-password', hint: `At least ${MIN_PASSWORD_LENGTH} characters.` });
  next.wrap.append(strengthMeter(next.input));
  const repeat = passwordField({ label: 'Confirm new password', autocomplete: 'new-password' });
  const savePassword = el('button', { class: 'primary', type: 'submit', text: 'Update password' });
  const passwordForm = el('form', {
    class: 'settings-form',
    noValidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      const problems = [
        [repeat, repeat.input.value === next.input.value ? null : 'Passwords do not match'],
        [next, newPasswordProblem(next.input.value, user.email)],
        [current, current.input.value ? null : 'Enter your current password'],
      ].filter(([, problem]) => problem);
      for (const [f, problem] of problems) f.setError(problem);
      if (problems.length > 0) { problems.at(-1)[0].input.focus(); return; }
      setBusy(savePassword, true);
      try {
        await api('/api/account', { method: 'PATCH', body: { currentPassword: current.input.value, newPassword: next.input.value } });
        passwordForm.reset();
        next.input.dispatchEvent(new Event('input'));
        toast('Password updated. Other devices were logged out.');
      } catch (error) {
        if (error.code === 'wrong_password') current.setError(error.message);
        else if (error.code === 'weak_password') next.setError(error.message);
        else toast(error.message, 'error');
      } finally {
        setBusy(savePassword, false);
      }
    },
  }, current.wrap, next.wrap, repeat.wrap, el('div', { class: 'form-actions' }, savePassword));

  const logoutOthers = el('button', {
    text: 'Log out other devices',
    onclick: action(async () => {
      const ok = await openDialog({
        title: 'Log out other devices?',
        message: 'Every other browser where you are logged in will be signed out. You stay logged in here.',
        confirmText: 'Log out others',
        onConfirm: () => api('/api/account?action=logout-others', { method: 'POST' }),
      });
      if (ok) toast('Other devices were logged out');
    }),
  });

  const deleteAccount = el('button', {
    class: 'danger solid',
    text: 'Delete account',
    onclick: action(async () => {
      const done = await openDialog({
        title: 'Delete your account?',
        message: `This permanently deletes your account and ${usage.projects} project(s) with all their issues and events. Apps using your API keys will stop reporting. This can't be undone.`,
        confirmText: 'Delete my account',
        danger: true,
        input: { label: 'Enter your password to confirm', type: 'password', autocomplete: 'current-password' },
        onConfirm: (password) => api('/api/account', { method: 'DELETE', body: { password } }),
      });
      if (done === null) return;
      forgetSession();
      toast('Your account was deleted');
      go('#/signup');
    }),
  });

  show(
    el('div', { class: 'page-head' }, el('h1', { text: 'Account' })),
    el('p', { class: 'page-sub', text: 'Manage your profile, password and sessions.' }),
    el('div', { class: 'settings' },
      settingsCard('Profile', null,
        el('div', { class: 'profile-row' }, avatar(user.name, true),
          el('div', {}, el('b', { text: user.name }), el('div', { class: 'muted small', text: `${user.role === 'admin' ? 'Admin · ' : ''}Member since ${new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}` })),
          el('span', { class: 'spacer' }),
          el('div', { class: 'usage' },
            el('b', { text: usage.projectLimit === null ? String(usage.projects) : `${usage.projects} / ${usage.projectLimit}` }),
            el('span', { class: 'muted small', text: usage.projectLimit === null ? 'projects' : 'projects used' }))),
        profileForm),
      settingsCard('Password', 'Changing your password logs you out on every other device.', passwordForm),
      settingsCard('Sessions', 'Signed in on a shared or lost device? End those sessions here.', el('div', { class: 'row' }, logoutOthers)),
      el('section', { class: 'card settings-card danger-zone' },
        el('div', { class: 'settings-head' }, el('h3', { text: 'Delete account' }), el('p', { class: 'muted', text: 'Permanently remove your account, your projects and all of their data.' })),
        el('div', { class: 'settings-body' }, el('div', { class: 'row' }, deleteAccount)))),
  );
}

// ---------------------------------------------------------------------------
// Admin console
// ---------------------------------------------------------------------------

async function adminPage(query) {
  setNav('admin');
  setCrumbs(el('span', { text: 'Admin' }));
  if (me && me.role !== 'admin') {
    // The role may have changed since the last session check (e.g. just promoted): ask the server.
    sessionCheckedAt = 0;
    await ensureSession();
  }
  if (!me || me.role !== 'admin') {
    show(emptyState('folder', 'Admins only', 'You need admin rights to open this page.'));
    return;
  }
  loading();
  const q = (query.get('q') || '').trim();
  const data = await cachedGet(`/api/admin${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const { totals } = data;

  const kpi = (label, value, note) => el('section', { class: 'panel kpi' },
    el('div', { class: 'panel-head' }, el('span', { text: label })),
    el('div', { class: 'big', text: value.toLocaleString() }),
    note ? el('div', { class: 'delta', text: note }) : null);

  const search = el('input', { type: 'search', placeholder: 'Search by name or email…', value: q, attrs: { 'aria-label': 'Search users' } });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(`#/admin${search.value.trim() ? `?q=${encodeURIComponent(search.value.trim())}` : ''}`); });

  const CHANGES = {
    disable: { body: { status: 'disabled' }, title: (u) => `Disable ${u.name}?`, confirm: 'Disable account', done: (u) => `${u.name} was disabled`, danger: true,
      message: (u) => `${u.email} will be logged out everywhere and can't log in. Their projects stop accepting events until the account is enabled again.` },
    enable: { body: { status: 'active' }, title: (u) => `Enable ${u.name}?`, confirm: 'Enable account', done: (u) => `${u.name} was enabled`,
      message: (u) => `${u.email} can log in again and their projects accept events again.` },
    promote: { body: { role: 'admin' }, title: (u) => `Make ${u.name} an admin?`, confirm: 'Make admin', done: (u) => `${u.name} is now an admin`,
      message: (u) => `${u.email} will be able to manage every account, including yours.` },
    demote: { body: { role: 'user' }, title: (u) => `Remove admin rights from ${u.name}?`, confirm: 'Remove admin', done: (u) => `${u.name} is no longer an admin`,
      message: (u) => `${u.email} keeps their account and projects, but can no longer open this page.` },
  };
  const change = (user, kind) => action(async () => {
    const c = CHANGES[kind];
    const ok = await openDialog({
      title: c.title(user),
      message: c.message(user),
      confirmText: c.confirm,
      danger: Boolean(c.danger),
      onConfirm: () => api(`/api/admin?id=${user.id}`, { method: 'PATCH', body: c.body }),
    });
    if (ok) { toast(c.done(user)); render(); }
  });
  const remove = (user) => action(async () => {
    const ok = await openDialog({
      title: `Delete ${user.name}?`,
      message: `This permanently deletes ${user.email}, their ${user.projects} project(s) and all issues and events in them. This can't be undone.`,
      confirmText: 'Delete user',
      danger: true,
      input: { label: `Type “${user.email}” to confirm`, autocomplete: 'off' },
      onConfirm: async (typed) => {
        if (typed.trim().toLowerCase() !== user.email) throw new Error('The email does not match');
        await api(`/api/admin?id=${user.id}`, { method: 'DELETE' });
      },
    });
    if (ok !== null) { toast(`${user.email} deleted`); render(); }
  });

  const rows = data.users.map((u) => {
    const self = u.id === me.id;
    return el('tr', { class: u.status === 'disabled' ? 'is-disabled' : '' },
      el('td', {}, el('div', { class: 'user-cell' }, avatar(u.name), el('div', {}, el('b', { text: u.name }), self ? badge('you', 'info') : null, el('div', { class: 'muted small', text: u.email })))),
      el('td', {}, badge(u.role, u.role === 'admin' ? 'open' : 'info')),
      el('td', {}, badge(u.status, u.status === 'active' ? 'resolved' : 'error')),
      el('td', { class: 'num', text: u.projects.toLocaleString() }),
      el('td', { class: 'num', text: u.events24h.toLocaleString() }),
      el('td', { class: 'muted', text: new Date(u.createdAt).toLocaleDateString(), title: formatDate(u.createdAt) }),
      el('td', { class: 'muted', text: u.lastLoginAt ? timeAgo(u.lastLoginAt) : '–', title: formatDate(u.lastLoginAt) }),
      el('td', { class: 'actions' }, self ? el('span', { class: 'muted small', text: 'Use Account page' }) : el('div', { class: 'row nowrap' },
        u.status === 'active'
          ? el('button', { class: 'sm', text: 'Disable', onclick: change(u, 'disable') })
          : el('button', { class: 'sm', text: 'Enable', onclick: change(u, 'enable') }),
        u.role === 'admin'
          ? el('button', { class: 'sm', text: 'Remove admin', onclick: change(u, 'demote') })
          : el('button', { class: 'sm', text: 'Make admin', onclick: change(u, 'promote') }),
        el('button', { class: 'sm danger', text: 'Delete', onclick: remove(u) }))),
    );
  });

  show(
    el('div', { class: 'page-head' }, el('h1', { text: 'Admin' })),
    el('p', { class: 'page-sub', text: 'Accounts and usage across the whole installation. Admins manage accounts; they cannot read other users’ issues.' }),
    el('div', { class: 'kpi-grid' },
      kpi('Users', totals.users, `${totals.disabledUsers} disabled · ${totals.admins} admin(s)`),
      kpi('Projects', totals.projects, totals.unownedProjects > 0 ? `${totals.unownedProjects} without an owner` : 'All owned'),
      kpi('Events (24h)', totals.events24h, 'Across all projects'),
      kpi('Avg. projects / user', totals.users === 0 ? 0 : Math.round((totals.projects / totals.users) * 10) / 10, null)),
    el('div', { class: 'filters section' }, search),
    data.users.length === 0
      ? emptyState('search', 'No users found', q ? `Nobody matches “${q}”.` : 'No accounts yet.')
      : el('div', { class: 'card table-wrap' },
          el('table', { class: 'table' },
            el('thead', {}, el('tr', {}, ['User', 'Role', 'Status', 'Projects', 'Events 24h', 'Joined', 'Last login', ''].map((h, i) =>
              el('th', { class: i === 3 || i === 4 ? 'num' : '', text: h })))),
            el('tbody', {}, rows))),
    data.truncated ? el('p', { class: 'muted small section', text: 'Showing the newest 500 accounts. Search to find others.' }) : null,
  );
  if (q) search.focus();
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
    show(welcome());
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
}

/** First-run guide for an account with no projects yet. */
function welcome() {
  const step = (n, title, text, ...extra) => el('li', { class: 'step' },
    el('span', { class: 'step-n', text: String(n) }),
    el('div', {}, el('b', { text: title }), el('p', { class: 'muted', text }), ...extra));
  return el('div', { class: 'card welcome' },
    el('p', { class: 'eyebrow', text: 'Getting started' }),
    el('h1', { text: `Welcome, ${firstName(me)}` }),
    el('p', { class: 'muted welcome-sub', text: 'Three steps to your first tracked error. Charts and issues appear here as soon as events arrive.' }),
    el('ol', { class: 'steps' },
      step(1, 'Create a project', 'Each app gets its own project and API key.',
        el('button', { class: 'primary', text: 'Create a project', onclick: () => go('#/projects?new=1') })),
      step(2, 'Install the SDK', 'Add the package and call init() as early as possible in your app.',
        el('div', { class: 'key-box' }, el('pre', { text: `npm install ${SDK_PACKAGE}` }))),
      step(3, 'Watch errors arrive', 'Errors, slow pages, failed requests and crashes show up grouped into issues, with stack traces and breadcrumbs.')));
}

// ---------------------------------------------------------------------------
// Performance (page views sent by SDK 0.5.0+ as transaction events)
// ---------------------------------------------------------------------------

/** Web Vitals in display order, with how to show their value. */
const PERF_VITALS = [
  { key: 'lcp', label: 'LCP', name: 'Largest Contentful Paint', format: 'ms' },
  { key: 'inp', label: 'INP', name: 'Interaction to Next Paint', format: 'ms' },
  { key: 'cls', label: 'CLS', name: 'Cumulative Layout Shift', format: 'cls' },
  { key: 'fcp', label: 'FCP', name: 'First Contentful Paint', format: 'ms' },
  { key: 'ttfb', label: 'TTFB', name: 'Time to First Byte', format: 'ms' },
  { key: 'load', label: 'Load', name: 'Page load (load event)', format: 'ms' },
];
const RATING_TEXT = { good: 'Good', 'needs-improvement': 'Needs work', poor: 'Poor' };
/** [good up to, poor above] for table dots; mirrors VITAL_THRESHOLDS in lib/constants.js. */
const VITAL_LIMITS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] };
const MS_PER_SECOND = 1000;
/** Durations from this many ms up are shown in seconds. */
const SECONDS_FROM_MS = 1000;
/** Charts that span the full content width. */
const CHART_WIDE = { width: 1100, height: 240 };
const ENDPOINT_SORTS = ['count', 'p50', 'p75', 'p95', 'errorRate', 'avgServer'];
const PAGE_SORTS = ['views', 'load', 'lcp', 'inp', 'cls'];

function formatMs(value) {
  if (value === null || value === undefined) return '–';
  return value >= SECONDS_FROM_MS ? `${(value / MS_PER_SECOND).toFixed(value >= 10 * SECONDS_FROM_MS ? 0 : 1)} s` : `${Math.round(value)} ms`;
}

function formatVital(vital, value) {
  if (value === null || value === undefined) return '–';
  return vital.format === 'cls' ? value.toFixed(3) : formatMs(value);
}

function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.01 ? 1 : 0)}%`;
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '–';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

function ratingBadge(rating) {
  return rating ? el('span', { class: `rating ${rating}`, text: RATING_TEXT[rating] }) : null;
}

function vitalCard(vital, summary) {
  return el('section', { class: 'panel kpi', title: vital.name },
    el('div', { class: 'panel-head' }, el('span', { text: vital.label }), ratingBadge(summary.rating)),
    el('div', { class: 'big', text: formatVital(vital, summary.p75) }),
    el('div', { class: 'delta neutral', text: summary.samples === 0 ? 'No samples yet' : `p75 · ${summary.samples.toLocaleString()} page view(s)` }));
}

/** A sortable table header cell: clicking it re-sorts by that column (largest first). */
function sortHeader(text, key, current, onSort, numeric = true) {
  return el('th', { class: numeric ? 'num' : '' },
    el('button', { class: `th-sort${current === key ? ' active' : ''}`, text: `${text}${current === key ? ' ↓' : ''}`, onclick: () => onSort(key) }));
}

function sortRows(rows, key) {
  return rows.slice().sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
}

async function performancePage(query) {
  setNav('performance');
  loading();
  const range = query.get('range') === '7d' ? '7d' : '24h';
  const projects = await getProjects();
  const projectId = projects.some((p) => p.id === query.get('project')) ? query.get('project') : '';
  const environment = query.get('env') || '';
  const endpoint = query.get('endpoint');
  const page = query.get('page');

  const state = { range, project: projectId, env: environment };
  const link = (changes) => {
    const next = new URLSearchParams({ ...state, ...changes });
    for (const [key, value] of [...next]) if (value === '' || value === null) next.delete(key);
    return `#/performance?${next}`;
  };
  const base = `/api/stats?view=performance&range=${range}${projectId ? `&projectId=${projectId}` : ''}${environment ? `&environment=${encodeURIComponent(environment)}` : ''}`;

  if (projects.length === 0) {
    setCrumbs(el('span', { text: 'Performance' }));
    show(welcome());
    return;
  }

  const overview = await cachedGet(base);
  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Time range' } },
      Object.entries(RANGE_LABELS).map(([key, text]) => el('button', { class: range === key ? 'active' : '', text, onclick: () => go(link({ range: key, endpoint, page })) }))),
    el('select', { attrs: { 'aria-label': 'Project' }, onchange: (e) => go(link({ project: e.target.value })) },
      el('option', { value: '', text: 'All projects' }),
      projects.map((p) => el('option', { value: p.id, text: p.name, selected: p.id === projectId }))),
    el('select', { attrs: { 'aria-label': 'Environment' }, onchange: (e) => go(link({ env: e.target.value, endpoint, page })) },
      el('option', { value: '', text: 'All environments' }),
      overview.environments.map((env) => el('option', { value: env, text: env, selected: env === environment }))),
  );

  if (endpoint) return endpointDetail(toolbar, link, `${base}&endpoint=${encodeURIComponent(endpoint)}`, endpoint);
  if (page) return pageDetail(toolbar, link, `${base}&page=${encodeURIComponent(page)}`, page);

  setCrumbs(el('span', { text: 'Performance' }));
  if (overview.totals.views === 0 && overview.totals.requests === 0) {
    show(toolbar, emptyState('inbox', 'No performance data yet',
      `Page views appear here once your app runs ${SDK_PACKAGE} 0.5.0 or later. Each page view sends its Web Vitals and the timing of every request.`));
    return;
  }

  const labels = overview.series.map((b) => bucketLabel(b.start, range));
  const sideLabel = RANGE_LABELS[range];
  const endpointSort = ENDPOINT_SORTS.includes(query.get('sort')) ? query.get('sort') : 'count';
  const pageSort = PAGE_SORTS.includes(query.get('psort')) ? query.get('psort') : 'views';

  const requests = panel('span-2', 'Request latency · p75', sideLabel,
    el('div', { class: 'big' }, formatMs(overview.totals.p75), el('small', { text: `p95 ${formatMs(overview.totals.p95)}` })),
    el('div', { class: 'delta neutral', text: `${overview.totals.requests.toLocaleString()} request(s) · ${formatPercent(overview.totals.errorRate)} failed` }),
    el('div', { class: 'section' }, columnChart(overview.series.map((b) => b.p75 || 0), labels, { size: CHART_LARGE, axis: true })));
  const views = panel('', 'Page views', sideLabel,
    el('div', { class: 'big' }, overview.totals.views.toLocaleString(), el('small', { text: `${overview.totals.loads.toLocaleString()} full load(s)` })),
    el('div', { class: 'section' }, columnChart(overview.series.map((b) => b.views), labels, { size: CHART_SMALL })));

  const endpointRows = sortRows(overview.endpoints, endpointSort).map((e) =>
    el('tr', {},
      el('td', { class: 'wrap' }, el('a', { href: link({ endpoint: e.key }), title: e.key },
        el('span', { class: 'method', text: e.method }), el('span', { class: 'muted', text: e.origin }), el('span', { text: e.path }))),
      el('td', { class: 'num', text: e.count.toLocaleString() }),
      el('td', { class: 'num', text: formatMs(e.p50) }),
      el('td', { class: 'num', text: formatMs(e.p75) }),
      el('td', { class: `num${e.p95 !== null && e.p95 >= SECONDS_FROM_MS ? ' warn' : ''}`, text: formatMs(e.p95) }),
      el('td', { class: `num${e.errorRate > 0 ? ' warn' : ''}`, text: formatPercent(e.errorRate) }),
      el('td', { class: 'num muted', text: formatMs(e.avgServer) }),
      el('td', { class: 'num muted', text: formatMs(e.avgDownload) })));
  const endpointsTable = el('section', { class: 'card table-wrap section' },
    el('div', { class: 'table-title' }, el('h3', { text: 'Endpoints' }),
      el('span', { class: 'muted small', text: 'Server = time to first byte, from the browser. Requests made while the tab was hidden are counted but not timed.' })),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Endpoint' }),
        sortHeader('Calls', 'count', endpointSort, (s) => go(link({ sort: s, psort: pageSort }))),
        sortHeader('p50', 'p50', endpointSort, (s) => go(link({ sort: s, psort: pageSort }))),
        sortHeader('p75', 'p75', endpointSort, (s) => go(link({ sort: s, psort: pageSort }))),
        sortHeader('p95', 'p95', endpointSort, (s) => go(link({ sort: s, psort: pageSort }))),
        sortHeader('Failed', 'errorRate', endpointSort, (s) => go(link({ sort: s, psort: pageSort }))),
        sortHeader('Server', 'avgServer', endpointSort, (s) => go(link({ sort: s, psort: pageSort }))),
        el('th', { class: 'num', text: 'Download' }))),
      el('tbody', {}, endpointRows)));

  const pageRows = sortRows(overview.pages, pageSort).map((p) =>
    el('tr', {},
      el('td', { class: 'wrap' }, el('a', { href: link({ page: p.name }), text: p.name })),
      el('td', { class: 'num', text: p.views.toLocaleString() }),
      el('td', { class: 'num', text: formatMs(p.load) }),
      el('td', { class: 'num' }, formatMs(p.lcp), ' ', ratingDot('lcp', p.lcp)),
      el('td', { class: 'num' }, formatMs(p.inp), ' ', ratingDot('inp', p.inp)),
      el('td', { class: 'num' }, p.cls === null ? '–' : p.cls.toFixed(3), ' ', ratingDot('cls', p.cls)),
      el('td', { class: 'num muted', text: formatMs(p.ttfb) })));
  const pagesTable = el('section', { class: 'card table-wrap section' },
    el('div', { class: 'table-title' }, el('h3', { text: 'Pages' }), el('span', { class: 'muted small', text: 'p75 per route, or per screen when the app names screens (setScreen). IDs in paths are grouped as {id}.' })),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Route / screen' }),
        sortHeader('Views', 'views', pageSort, (s) => go(link({ psort: s, sort: endpointSort }))),
        sortHeader('Load', 'load', pageSort, (s) => go(link({ psort: s, sort: endpointSort }))),
        sortHeader('LCP', 'lcp', pageSort, (s) => go(link({ psort: s, sort: endpointSort }))),
        sortHeader('INP', 'inp', pageSort, (s) => go(link({ psort: s, sort: endpointSort }))),
        sortHeader('CLS', 'cls', pageSort, (s) => go(link({ psort: s, sort: endpointSort }))),
        el('th', { class: 'num', text: 'TTFB' }))),
      el('tbody', {}, pageRows)));

  show(toolbar,
    el('div', { class: 'vitals-grid' }, PERF_VITALS.map((vital) => vitalCard(vital, overview.vitals[vital.key]))),
    el('div', { class: 'dash-grid section' }, requests, views),
    endpointsTable,
    pagesTable);
}

/** A small coloured dot for a table cell, using the same thresholds as the server. */
function ratingDot(vital, value) {
  if (value === null || value === undefined) return null;
  const limits = VITAL_LIMITS[vital];
  const rating = value <= limits[0] ? 'good' : value > limits[1] ? 'poor' : 'needs-improvement';
  return el('i', { class: `dot ${rating}`, title: RATING_TEXT[rating] });
}

async function endpointDetail(toolbar, link, path, key) {
  setCrumbs(el('a', { href: link({}), text: 'Performance' }), el('span', { text: key }));
  const data = await cachedGet(path);
  const s = data.summary;
  const labels = data.series.map((b) => bucketLabel(b.start, data.range));
  const kpi = (label, value, note) => el('section', { class: 'panel kpi' },
    el('div', { class: 'panel-head' }, el('span', { text: label })), el('div', { class: 'big', text: value }), note ? el('div', { class: 'delta neutral', text: note }) : null);

  const samples = data.samples.map((row) =>
    el('tr', {},
      el('td', { class: 'num', text: formatMs(row.duration_ms) }),
      el('td', { class: 'num muted', text: formatMs(row.server_ms) }),
      el('td', { class: 'num muted', text: formatMs(row.download_ms) }),
      el('td', { class: 'num muted', text: formatBytes(row.size_bytes) }),
      el('td', {}, badge(row.failure || String(row.status), row.failed ? 'error' : 'info')),
      el('td', { class: 'wrap' }, el('a', { href: link({ page: row.page }), text: row.page })),
      el('td', { class: 'muted', text: [row.browser, row.os].filter(Boolean).join(' · ') || '–' }),
      el('td', { class: 'muted', text: timeAgo(row.receivedAt), title: formatDate(row.receivedAt) })));

  show(toolbar,
    el('div', { class: 'page-head perf-head' }, el('h1', { class: 'endpoint-title' }, el('span', { class: 'method', text: s.method }), el('span', { text: `${s.origin}${s.path}` }))),
    el('div', { class: 'kpi-grid' },
      kpi('p50 · p75', `${formatMs(s.p50)} · ${formatMs(s.p75)}`, null),
      kpi('p95', formatMs(s.p95), null),
      kpi('Calls', s.count.toLocaleString(), `${formatPercent(s.errorRate)} failed`),
      kpi('Server · download (avg)', `${formatMs(s.avgServer)} · ${formatMs(s.avgDownload)}`, s.avgServer === null ? 'Not exposed by the browser (cross-origin)' : 'Time to first byte · body')),
    panel('section', 'Latency per bucket', RANGE_LABELS[data.range],
      el('div', { class: 'legend' }, el('span', {}, el('i'), `p75 per ${data.range === '7d' ? 'day' : 'hour'}`)),
      columnChart(data.series.map((b) => b.p75 || 0), labels, { size: CHART_WIDE, axis: true })),
    el('section', { class: 'card table-wrap section' },
      el('div', { class: 'table-title' }, el('h3', { text: 'Slowest calls' }), el('span', { class: 'muted small', text: 'From the last 7 days at most; hidden-tab calls are left out.' })),
      data.samples.length === 0
        ? el('p', { class: 'muted pad', text: 'No recent calls kept for this endpoint.' })
        : el('table', { class: 'table' },
            el('thead', {}, el('tr', {}, ['Duration', 'Server', 'Download', 'Size', 'Status', 'Page', 'Browser', 'When'].map((h, i) =>
              el('th', { class: i < 4 ? 'num' : '', text: h })))),
            el('tbody', {}, samples))));
}

async function pageDetail(toolbar, link, path, route) {
  setCrumbs(el('a', { href: link({}), text: 'Performance' }), el('span', { text: route }));
  const data = await cachedGet(path);
  const labels = data.series.map((b) => bucketLabel(b.start, data.range));
  const samples = data.samples.map((row) =>
    el('tr', {},
      el('td', { class: 'num', text: formatMs(row.vitals.page_load_ms) }),
      el('td', { class: 'num', text: formatMs(row.vitals.lcp_ms) }),
      el('td', { class: 'num', text: formatMs(row.vitals.fcp_ms) }),
      el('td', { class: 'num muted', text: formatMs(row.vitals.ttfb_ms) }),
      el('td', { class: 'num muted', text: (row.long_tasks && row.long_tasks.blocking_ms) ? formatMs(row.long_tasks.blocking_ms) : '–' }),
      el('td', { class: 'num muted', text: String(row.spanCount) }),
      el('td', { class: 'wrap muted', text: row.name }),
      el('td', { class: 'muted', text: [row.browser, row.os].filter(Boolean).join(' · ') || '–' }),
      el('td', { class: 'muted', text: timeAgo(row.receivedAt), title: formatDate(row.receivedAt) })));

  show(toolbar,
    el('div', { class: 'page-head perf-head' }, el('h1', { class: 'endpoint-title', text: route })),
    el('div', { class: 'vitals-grid' }, PERF_VITALS.map((vital) => vitalCard(vital, data.vitals[vital.key]))),
    // Routes reached only by in-app navigation have no full page loads: chart their views instead.
    data.summary.loads > 0
      ? panel('section', 'Page load · p75', RANGE_LABELS[data.range],
          el('div', { class: 'delta neutral', text: `${data.summary.views.toLocaleString()} view(s), ${data.summary.loads.toLocaleString()} full load(s)` }),
          el('div', { class: 'section' }, columnChart(data.series.map((b) => b.load || 0), labels, { size: CHART_WIDE, axis: true })))
      : panel('section', 'Views', RANGE_LABELS[data.range],
          el('div', { class: 'delta neutral', text: `${data.summary.views.toLocaleString()} view(s), all from in-app navigation (no full page loads)` }),
          el('div', { class: 'section' }, columnChart(data.series.map((b) => b.views), labels, { size: CHART_WIDE, axis: true }))),
    el('section', { class: 'card table-wrap section' },
      el('div', { class: 'table-title' }, el('h3', { text: 'Slowest page loads' }), el('span', { class: 'muted small', text: 'From the last 7 days at most; loads in a hidden tab are left out.' })),
      data.samples.length === 0
        ? el('p', { class: 'muted pad', text: 'No recent full page loads kept for this route.' })
        : el('table', { class: 'table' },
            el('thead', {}, el('tr', {}, ['Load', 'LCP', 'FCP', 'TTFB', 'Blocking', 'Requests', 'URL path', 'Browser', 'When'].map((h, i) =>
              el('th', { class: i < 6 ? 'num' : '', text: h })))),
            el('tbody', {}, samples))));
}

async function projectsPage(query) {
  setNav('projects');
  setCrumbs(el('span', { text: 'Projects' }));
  loading();
  const { projects, limit } = await cachedGet('/api/projects');
  // `limit` is null when accounts may have any number of projects.
  const atLimit = limit !== null && projects.length >= limit;

  const createArea = el('div');
  const newButton = el('button', {
    class: 'primary',
    text: 'New project',
    disabled: atLimit,
    title: atLimit ? `You can have at most ${limit} projects` : undefined,
    onclick: () => showCreateForm(createArea, newButton),
  });

  const cards = projects.map((p) =>
    el('div', { class: 'card project' },
      el('a', { class: 'project-card', href: `#/p/${p.id}` },
        el('div', { class: 'project-top' }, avatar(p.name), el('h2', { text: p.name })),
        el('div', { class: 'stats' },
          el('div', { class: `stat${p.openIssues > 0 ? ' alert' : ''}` }, el('b', { text: p.openIssues.toLocaleString() }), el('span', { class: 'muted small', text: 'open issues' })),
          el('div', { class: 'stat' }, el('b', { text: p.events24h.toLocaleString() }), el('span', { class: 'muted small', text: 'events (24h)' })),
        ),
        el('div', { class: 'key-hint mono', text: `Key: ${p.apiKeyHint} · ${p.allowedOrigins.length === 0 ? 'any origin' : `${p.allowedOrigins.length} origin(s)`}` }),
      ),
    ),
  );

  show(
    el('div', { class: 'page-head' }, el('h1', { text: 'Projects' }), el('span', { class: 'spacer' }),
      el('span', { class: `usage-pill${atLimit ? ' full' : ''}`, text: limit === null ? `${projects.length} project(s)` : `${projects.length} / ${limit} projects` }), newButton),
    el('p', { class: 'page-sub', text: atLimit
      ? `You have reached the limit of ${limit} projects. Delete a project to create another.`
      : 'Each app that sends errors is a project with its own API key.' }),
    createArea,
    projects.length > 0 ? el('div', { class: 'grid section' }, cards) : emptyState('folder', 'No projects yet', 'Create your first project to get an API key and start tracking errors.'),
  );
  if (pendingKey) {
    const { title, apiKey } = pendingKey;
    pendingKey = null;
    createArea.replaceChildren(keyBox(title, apiKey, () => { createArea.replaceChildren(); window.scrollTo(0, 0); }));
  } else if (query && query.get('new') === '1' && !atLimit) {
    showCreateForm(createArea, newButton);
  }
}

function showCreateForm(area, newButton) {
  newButton.disabled = true;
  const name = field({ label: 'Project name', placeholder: 'e.g. Web shop', maxLength: 80, autocomplete: 'off', hint: 'Usually the name of the app or website that will send errors.' });
  const submit = el('button', { class: 'primary', type: 'submit', text: 'Create project' });
  const form = el('form', {
    class: 'create-form',
    noValidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      if (!name.input.value.trim()) { name.setError('Enter a project name'); name.input.focus(); return; }
      setBusy(submit, true);
      try {
        const { project, apiKey } = await api('/api/projects', { method: 'POST', body: { name: name.input.value } });
        // Redraw the list (it now includes the project) with the one-time key on top.
        pendingKey = { title: `Project "${project.name}" created`, apiKey };
        if (location.hash === '#/projects') await render(); else go('#/projects');
      } catch (e) {
        setBusy(submit, false);
        name.setError(e.message);
      }
    },
  }, name.wrap, el('div', { class: 'form-actions' },
    el('button', { type: 'button', text: 'Cancel', onclick: () => { area.replaceChildren(); newButton.disabled = false; } }), submit));
  area.replaceChildren(el('div', { class: 'card card-body section' }, el('h3', { class: 'card-title', text: 'New project' }), form));
  name.input.focus();
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

/** Same rules as the server's normalizeOrigin (lib/origins.js): `{ origin }` or `{ error }`. */
function parseOrigin(text) {
  const value = text.trim();
  if (value === '') return { error: 'Enter an origin, e.g. https://myapp.com' };
  if (value.includes('*')) return { error: 'Wildcards are not supported; add each origin' };
  if (!value.includes('://')) return { error: 'Include http:// or https://, e.g. http://localhost:3000' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: 'Not a valid origin; use the form https://myapp.com' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http:// and https:// origins' };
  return { origin: url.origin };
}

function originsLabel(origins) {
  return origins.length === 0 ? 'Allowed origins: any' : `Allowed origins: ${origins.length}`;
}

/**
 * The websites whose pages may send events with this project's key. Each add
 * or remove saves the whole list at once; `onChange(origins)` runs after a save.
 */
function originsPanel(project, onChange) {
  let origins = [...project.allowedOrigins];
  const status = el('div');
  const list = el('div', { class: 'origin-list' });
  const origin = field({
    label: 'Add an origin',
    placeholder: 'https://myapp.com',
    autocomplete: 'off',
    attrs: { spellcheck: 'false', autocapitalize: 'off' },
    maxLength: 200,
    hint: 'Scheme, host and port as in the address bar, e.g. http://localhost:3000. A pasted URL is cut down to its origin.',
  });
  const addButton = el('button', { class: 'primary', type: 'submit', text: 'Add' });

  async function save(next) {
    const res = await api(`/api/projects?id=${project.id}`, { method: 'PATCH', body: { allowedOrigins: next } });
    origins = res.project.allowedOrigins;
    project.allowedOrigins = origins;
    draw();
    onChange(origins);
  }

  function removeButton(value) {
    return el('button', {
      class: 'ghost danger',
      type: 'button',
      text: 'Remove',
      attrs: { 'aria-label': `Remove ${value}` },
      onclick: action(async (event) => {
        const next = origins.filter((o) => o !== value);
        if (next.length === 0) {
          const ok = await openDialog({
            title: 'Remove the last origin?',
            message: "With no origins listed, any website can send events with this project's key.",
            confirmText: 'Remove',
            danger: true,
            onConfirm: () => save(next),
          });
          if (ok) toast(`Removed ${value}`);
          return;
        }
        const button = event.currentTarget;
        setBusy(button, true);
        try {
          await save(next);
          toast(`Removed ${value}`);
        } finally {
          setBusy(button, false);
        }
      }),
    });
  }

  function draw() {
    status.replaceChildren(origins.length === 0
      ? el('p', { class: 'notice warn', text: 'Any website can send events with this key. Add the origins of your app, local and production, to accept events only from them.' })
      : el('p', { class: 'muted small', text: 'Only these websites can send events. Server-side and mobile apps (no Origin header) are always accepted. Changes apply within a minute.' }));
    list.replaceChildren(...origins.map((value) =>
      el('div', { class: 'origin-row' }, el('code', { text: value }), el('span', { class: 'spacer' }), removeButton(value))));
  }

  const form = el('form', {
    class: 'origin-form',
    noValidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      const typed = origin.input.value.trim();
      const parsed = parseOrigin(typed);
      if (parsed.error) { origin.setError(parsed.error); origin.input.focus(); return; }
      if (origins.includes(parsed.origin)) { origin.setError(`${parsed.origin} is already in the list`); origin.input.focus(); return; }
      setBusy(addButton, true);
      try {
        await save([...origins, parsed.origin]);
        const cut = typed.replace(/\/$/, '').toLowerCase() !== parsed.origin;
        toast(cut ? `Added ${parsed.origin} (cut down to its origin)` : `Added ${parsed.origin}`);
        origin.input.value = '';
        origin.input.focus();
      } catch (error) {
        origin.setError(error.message);
      } finally {
        setBusy(addButton, false);
      }
    },
  }, origin.wrap, el('div', { class: 'form-actions' }, addButton));

  draw();
  return el('div', { class: 'section' },
    settingsCard('Allowed origins', 'Websites whose pages may send events with this key. Browsers set the Origin header, so other sites cannot use a key copied from your page.',
      status, list, form));
}

/** Labelled textarea with a hint, for one-entry-per-line settings. */
function textareaField({ label, hint, value, placeholder, rows }) {
  const id = `f${++fieldSeq}`;
  const input = el('textarea', { id, value, placeholder, rows, attrs: { spellcheck: 'false', autocapitalize: 'off' } });
  return {
    input,
    wrap: el('div', { class: 'field' },
      el('label', { class: 'field-label', text: label, attrs: { for: id } }),
      input,
      el('p', { class: 'field-hint', text: hint })),
  };
}

const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const HINT_SEPARATOR = '=>';

/**
 * How the issue page reads this project's errors (public/insights.js):
 * library paths, frames to hide and the team's own hints. `onChange(settings)`
 * runs after a save.
 */
function insightsPanel(project, onChange) {
  const s = insightSettings(project.insights);
  const libraries = textareaField({
    label: 'Library paths',
    hint: `One per line. A stack frame whose file URL contains this text is library code: folded away, never "where to look". Start a line with ${APP_PATH_PREFIX} to mark files as your code instead, overriding the built-in list: ${BUILT_IN_LIBRARY_NAMES.join(', ')}.`,
    value: s.libraryPaths.join('\n'),
    placeholder: `/vendor/\n${APP_PATH_PREFIX}/js/app/`,
    rows: 4,
  });
  const hidden = textareaField({
    label: 'Frames to hide',
    hint: 'One per line: function names of wrappers such as a tracking snippet ("wrapped" also hides "Object.wrapped"), or a path containing / to hide every frame from that file.',
    value: s.hiddenFrames.join('\n'),
    placeholder: 'serverError\nwrapped',
    rows: 3,
  });
  const hints = textareaField({
    label: 'Team hints',
    hint: `One per line: match ${HINT_SEPARATOR} hint. Shown on an issue when "match" appears in its error type, message or a context value (such as an error code).`,
    value: s.hints.map((h) => `${h.match} ${HINT_SEPARATOR} ${h.text}`).join('\n'),
    placeholder: `AppzillonServerError ${HINT_SEPARATOR} An Appzillon server call failed; check the iface and error code under Context.`,
    rows: 5,
  });
  const error = el('p', { class: 'field-error', hidden: true });
  const saveButton = el('button', { class: 'primary', type: 'submit', text: 'Save' });

  const form = el('form', {
    class: 'origin-form',
    noValidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      error.hidden = true;
      // Line numbers count blank lines too, so they match what the user sees.
      const rawLines = hints.input.value.split(/\r?\n/);
      const bad = rawLines.findIndex((l) => l.trim() !== '' && (!l.includes(HINT_SEPARATOR)
        || !l.slice(0, l.indexOf(HINT_SEPARATOR)).trim() || !l.slice(l.indexOf(HINT_SEPARATOR) + HINT_SEPARATOR.length).trim()));
      if (bad !== -1) {
        error.textContent = `Team hints, line ${bad + 1}: write it as match ${HINT_SEPARATOR} hint`;
        error.hidden = false;
        hints.input.focus();
        return;
      }
      const hintLines = lines(hints.input.value);
      const settings = {
        libraryPaths: lines(libraries.input.value),
        hiddenFrames: lines(hidden.input.value),
        hints: hintLines.map((l) => {
          const at = l.indexOf(HINT_SEPARATOR);
          return { match: l.slice(0, at).trim(), text: l.slice(at + HINT_SEPARATOR.length).trim() };
        }),
      };
      setBusy(saveButton, true);
      try {
        const res = await api(`/api/projects?id=${project.id}`, { method: 'PATCH', body: { insights: settings } });
        project.insights = res.project.insights;
        toast('Issue insights saved');
        onChange(project.insights);
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
      } finally {
        setBusy(saveButton, false);
      }
    },
  }, libraries.wrap, hidden.wrap, hints.wrap, error, el('div', { class: 'form-actions' }, saveButton));

  return el('div', { class: 'section' },
    settingsCard('Issue insights', "How the issue page reads this project's errors: which code is a library, which wrapper frames to skip, and what your team already knows about certain errors. Applies to every issue at once.",
      form));
}

function insightsLabel(raw) {
  const settings = insightSettings(raw);
  const n = settings.libraryPaths.length + settings.hiddenFrames.length + settings.hints.length;
  return n === 0 ? 'Issue insights' : `Issue insights: ${n}`;
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
  deleteSelected.addEventListener('click', action(async () => {
    const count = selected.size;
    const ok = await openDialog({
      title: `Delete ${count} issue(s)?`,
      message: "The selected issues and all their events will be deleted. This can't be undone.",
      confirmText: 'Delete',
      danger: true,
      onConfirm: () => api(`/api/issues?projectId=${projectId}`, { method: 'DELETE', body: { ids: [...selected] } }),
    });
    if (!ok) return;
    toast(`Deleted ${count} issue(s)`);
    render();
  }));
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
    onclick: action(async () => {
      let apiKey = null;
      const ok = await openDialog({
        title: 'Rotate the API key?',
        message: `"${project.name}" gets a new key and the current one stops working immediately. Apps using it stop sending errors until you update them.`,
        confirmText: 'Rotate key',
        onConfirm: async () => { apiKey = (await api(`/api/projects?id=${projectId}&action=rotate-key`, { method: 'POST' })).apiKey; },
      });
      if (ok) show(keyBox(`New API key for "${project.name}"`, apiKey, () => go(`#/p/${projectId}`)));
    }),
  });

  const clearLabel = filters.status === 'all' ? 'all' : filters.status;
  const clearCount = filters.status === 'all' ? allCount : data.counts[filters.status];
  const clearAll = el('button', {
    class: 'danger',
    text: filters.status === 'all' ? `Delete everything (${clearCount})` : `Delete all ${clearLabel} (${clearCount})`,
    disabled: clearCount === 0,
    onclick: action(async () => {
      const ok = await openDialog({
        title: `Delete ${clearCount} ${filters.status === 'all' ? '' : clearLabel + ' '}issue(s)?`,
        message: `All ${filters.status === 'all' ? '' : clearLabel + ' '}issues of "${project.name}" and their events will be deleted. This can't be undone.`,
        confirmText: 'Delete all',
        danger: true,
        onConfirm: () => api(`/api/issues?projectId=${projectId}&status=${filters.status}`, { method: 'DELETE' }),
      });
      if (!ok) return;
      toast(`Deleted ${clearCount} issue(s)`);
      render();
    }),
  });
  const originsArea = el('div');
  const originsButton = el('button', {
    class: `ghost${project.allowedOrigins.length === 0 ? ' warn' : ''}`,
    type: 'button',
    text: originsLabel(project.allowedOrigins),
    attrs: { 'aria-expanded': 'false' },
    onclick: () => toggleOrigins(originsOpenFor !== projectId),
  });
  function toggleOrigins(open) {
    originsOpenFor = open ? projectId : null;
    originsButton.setAttribute('aria-expanded', String(open));
    originsArea.replaceChildren(open
      ? originsPanel(project, (origins) => {
          originsButton.textContent = originsLabel(origins);
          originsButton.classList.toggle('warn', origins.length === 0);
        })
      : '');
  }
  const insightsArea = el('div');
  const insightsButton = el('button', {
    class: 'ghost',
    type: 'button',
    text: insightsLabel(project.insights),
    attrs: { 'aria-expanded': 'false' },
    onclick: () => toggleInsights(insightsOpenFor !== projectId),
  });
  function toggleInsights(open) {
    insightsOpenFor = open ? projectId : null;
    insightsButton.setAttribute('aria-expanded', String(open));
    insightsArea.replaceChildren(open
      ? insightsPanel(project, (settings) => { insightsButton.textContent = insightsLabel(settings); })
      : '');
  }

  const deleteProject = el('button', {
    class: 'ghost danger',
    text: 'Delete project',
    onclick: action(async () => {
      const typed = await openDialog({
        title: `Delete "${project.name}"?`,
        message: "The project, every issue and event in it, and its API key will be deleted. Apps using the key stop reporting. This can't be undone.",
        confirmText: 'Delete project',
        danger: true,
        input: { label: `Type “${project.name}” to confirm`, autocomplete: 'off' },
        onConfirm: async (value) => {
          if (value.trim() !== project.name) throw new Error('The name does not match');
          await api(`/api/projects?id=${projectId}`, { method: 'DELETE' });
        },
      });
      if (typed === null) return;
      toast(`Project "${project.name}" deleted`);
      go('#/projects');
    }),
  });

  show(
    el('div', { class: 'page-head' }, avatar(project.name, true), el('h1', { text: project.name }), el('span', { class: 'spacer' }), originsButton, insightsButton, rotate, deleteProject),
    el('p', { class: 'page-sub', text: `${data.total} issue(s)` }),
    originsArea,
    insightsArea,
    tabs, filterBar,
    data.issues.length > 0 ? el('div', { class: 'row bulk' }, deleteSelected, el('span', { class: 'spacer' }), clearAll) : null,
    list, pager,
  );
  // Keep the search box focused across auto-refreshes.
  if (query.get('q')) search.focus();
  if (originsOpenFor === projectId) toggleOrigins(true);
  if (insightsOpenFor === projectId) toggleInsights(true);
  guardRedraw(() => selected.size === 0);
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

  const STATUS_TOASTS = { resolved: 'Issue resolved', ignored: 'Issue ignored', open: 'Issue reopened' };
  const setStatus = (status) => action(async (event) => {
    setBusy(event.currentTarget, true);
    await api(`/api/issue?id=${issueId}`, { method: 'PATCH', body: { status } });
    toast(STATUS_TOASTS[status]);
    render();
  });
  const actions = el('div', { class: 'row' },
    issue.status !== 'resolved' ? el('button', { class: 'primary', text: 'Resolve', onclick: setStatus('resolved') }) : null,
    issue.status !== 'ignored' ? el('button', { text: 'Ignore', onclick: setStatus('ignored') }) : null,
    issue.status !== 'open' ? el('button', { text: 'Reopen', onclick: setStatus('open') }) : null,
    el('button', {
      class: 'danger',
      text: 'Delete',
      onclick: action(async () => {
        const ok = await openDialog({
          title: 'Delete this issue?',
          message: `The issue and its ${issue.count.toLocaleString()} event(s) will be deleted. If the error happens again, it comes back as a new issue.`,
          confirmText: 'Delete issue',
          danger: true,
          onConfirm: () => api(`/api/issue?id=${issueId}`, { method: 'DELETE' }),
        });
        if (!ok) return;
        toast('Issue deleted');
        go(data.project ? `#/p/${data.project.id}` : '#/projects');
      }),
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
      el('div', { class: 'muted small', text: [e.screen, e.environment, e.browser, e.userId ? `user ${e.userId}` : null].filter(Boolean).join(' · ') }),
    )),
  );

  show(header, el('div', { class: 'detail' },
    el('div', {}, el('h2', { text: `Latest events (${data.events.length})` }), eventsList),
    event ? eventDetail(event, data.project && data.project.insights) : emptyState('inbox', 'No events stored', 'Older events are deleted after 30 days.'),
  ));
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

/** "What happened": the facts, where to look, and hints (public/insights.js). */
function summarySection(insight) {
  const look = insight.whereToLook;
  return section('What happened',
    insight.facts.length > 0
      ? el('dl', { class: 'facts' }, insight.facts.flatMap((f) => [
          el('dt', { text: f.label }),
          el('dd', { class: f.tone ? `tone-${f.tone}` : '', text: f.text }),
        ]))
      : el('p', { class: 'muted', text: 'Not enough data in this event for a summary.' }),
    look ? el('div', { class: 'look' },
      el('span', { class: 'look-label', text: 'Where to look' }),
      el('code', { text: frameLabel(look.frame) }),
      look.frame.filename ? el('div', { class: 'muted small mono', text: look.frame.filename }) : null,
    ) : null,
    insight.hints.map((h) => el('div', { class: 'hint' },
      el('span', { class: 'look-label', text: h.source === 'project' ? 'Team hint' : 'Hint' }),
      el('p', { text: h.text }))),
  );
}

/** The breadcrumbs just before the error, oldest first, ending with the error itself. */
function momentsSection(insight, p) {
  if (insight.moments.length === 0) return null;
  const errorText = p.error ? `${p.error.type}: ${p.error.message}` : p.event_type;
  // Newest first: the error on top, then what led up to it, going back in time.
  return section('Last moments (newest first)',
    el('ol', { class: 'timeline moments' },
      el('li', { class: 'moment-error' },
        el('span', { class: 'mono small', text: '0 s' }),
        el('span', { class: 'bc-type' }, badge(p.event_type, 'error')),
        el('span', { class: 'moment-msg', text: errorText })),
      insight.moments.slice().reverse().map((m) => el('li', { class: m.tone ? `tone-${m.tone}` : '' },
        el('span', { class: 'muted mono small', text: m.when || (m.at ? new Date(m.at).toLocaleTimeString() : '') }),
        el('span', { class: 'bc-type' }, badge(m.type, 'info')),
        el('span', { class: 'moment-msg', text: m.message })))),
  );
}

const FRAME_KIND_LABELS = { app: 'your code', native: 'browser', hidden: 'hidden' };

function frameRow(c, focus) {
  return el('div', { class: `frame mono${focus ? ' focus' : ''}${c.kind === 'app' ? '' : ' dim'}` },
    el('span', { class: 'fn', text: c.frame.function }), ' ',
    el('span', { class: 'muted', text: `${c.frame.filename || '?'}${c.frame.lineno !== null ? ':' + c.frame.lineno : ''}${c.frame.colno !== null ? ':' + c.frame.colno : ''}` }),
    el('span', { class: 'frame-tag', text: c.library || FRAME_KIND_LABELS[c.kind] }));
}

/** The whole error as the browser console prints it, ready to paste into a ticket or chat. */
function stackTextBlock(payload) {
  const text = stackText(payload.error, payload.stacktrace);
  return el('details', { class: 'stack-text' },
    el('summary', { text: 'Raw Error' }),
    el('div', { class: 'row stack-text-bar' },
      el('span', { class: 'muted small', text: 'Every frame, nothing folded.' }),
      el('span', { class: 'spacer' }),
      el('button', { text: 'Copy', onclick: (e) => copy(text, e.currentTarget) })),
    el('pre', { text }));
}

/** Stack trace with your code shown and runs of library/browser/hidden frames folded away, plus the plain-text version. */
function stackSection(insight, payload) {
  const frames = insight.frames;
  const focus = insight.whereToLook;
  // A stack with no frames of your code is shown whole: folding everything would hide it all.
  if (!frames.some((c) => c.kind === 'app')) {
    return section('Stack trace', el('div', { class: 'frames' }, frames.map((c, i) => frameRow(c, i === 0))), stackTextBlock(payload));
  }
  const groups = [];
  for (const c of frames) {
    const last = groups[groups.length - 1];
    if (c.kind === 'app') groups.push(c);
    else if (Array.isArray(last)) last.push(c);
    else groups.push([c]);
  }
  return section('Stack trace',
    el('div', { class: 'frames' }, groups.map((g) => {
      if (!Array.isArray(g)) return frameRow(g, g === focus);
      const names = [...new Set(g.map((c) => c.library || FRAME_KIND_LABELS[c.kind]))].join(', ');
      return el('details', { class: 'frame-group' },
        el('summary', { text: `${g.length} frame${g.length === 1 ? '' : 's'}: ${names}` }),
        g.map((c) => frameRow(c, false)));
    })),
    stackTextBlock(payload),
  );
}

function eventDetail(event, insightSettings) {
  const p = event.payload;
  const parts = [];
  let insight = null;
  try {
    insight = analyzeEvent(p, insightSettings, event.receivedAt);
  } catch (error) {
    // The summary is a convenience: an unexpected event shape must never break the issue page.
    console.warn('Issue insights failed for this event', error);
  }

  if (insight) {
    parts.push(summarySection(insight));
    parts.push(momentsSection(insight, p));
  }
  if (p.stacktrace.length > 0) {
    parts.push(stackSection(insight || { frames: p.stacktrace.map((frame) => ({ frame, kind: 'app', library: null })), whereToLook: null }, p));
  }

  parts.push(section('Event',
    kv([
      ['Time', formatDate(p.timestamp)],
      ['Received', formatDate(event.receivedAt)],
      ['Environment', p.environment],
      ['App version', p.app_version],
      ['Level', p.level],
      ['Handled', p.error ? (p.error.handled ? 'yes' : 'no') : null],
      // One-URL apps (Appzillon) name their screens: the screen says where the user was, the URL doesn't.
      ['Page', [p.screen, p.device.url].filter(Boolean).join('  ·  ')],
      ['User', [p.user.id, p.user.name, p.user.email].filter(Boolean).join(' · ')],
      ['SDK', `${p.sdk.name} ${p.sdk.version || ''}`],
    ]),
  ));

  if (p.breadcrumbs.length > 0) {
    parts.push(el('div', { class: 'card card-body section' },
      el('details', {},
        el('summary', { text: `All breadcrumbs (${p.breadcrumbs.length}), newest first` }),
        el('ul', { class: 'timeline' },
          p.breadcrumbs.slice().reverse().map((b) => el('li', {},
            el('span', { class: 'muted mono small', text: b.timestamp ? new Date(b.timestamp).toLocaleTimeString() : '' }),
            el('span', { class: 'bc-type' }, badge(b.type, 'info')),
            el('span', { text: b.message }),
          )),
        ),
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
  clearTimeout(loadingTimer);
  activeKeys = new Set();
  pageGuard = () => true;
  rendering = true;
  const { parts, query } = parseHash();
  try {
    if (AUTH_ROUTES.includes(parts[0])) {
      // Already logged in: skip the form.
      if (await ensureSession()) return go(returnTo || '#/dashboard');
      setShell(false);
      return parts[0] === 'signup' ? signupPage() : loginPage();
    }
    if (!(await ensureSession())) {
      returnTo = location.hash && location.hash !== '#/dashboard' ? location.hash : null;
      return go('#/login');
    }
    setShell(true);
    if (parts[0] === 'projects') return await projectsPage(query);
    if (parts[0] === 'p' && parts[1]) return await issuesPage(parts[1], query);
    if (parts[0] === 'i' && parts[1]) return await issuePage(parts[1], query);
    if (parts[0] === 'performance') return await performancePage(query);
    if (parts[0] === 'account') return await accountPage();
    if (parts[0] === 'admin') return await adminPage(query);
    return await dashboardPage(query);
  } catch (error) {
    showError(error);
  } finally {
    rendering = false;
  }
}

/** True when logged in. The server is asked at most every SESSION_RECHECK_MS. */
async function ensureSession() {
  if (me && Date.now() - sessionCheckedAt < SESSION_RECHECK_MS) return true;
  const session = await api('/api/auth');
  me = session.authenticated ? session.user : null;
  sessionCheckedAt = me ? Date.now() : 0;
  if (me) updateChrome();
  return me !== null;
}

/** Sidebar + header for the app pages; a full-screen layout for login and sign-up. */
function setShell(visible) {
  topbar.hidden = !visible;
  sidebar.hidden = !visible;
  document.body.classList.toggle('auth-mode', !visible);
}

/** Shows the logged-in user in the sidebar, and the Admin link to admins. */
function updateChrome() {
  if (!me) return;
  document.getElementById('nav-admin').hidden = me.role !== 'admin';
  document.getElementById('user-name').textContent = me.name;
  document.getElementById('user-email').textContent = me.email;
  document.getElementById('user-initial').textContent = (me.name.trim()[0] || '?').toUpperCase();
}

document.getElementById('logout').addEventListener('click', action(async () => {
  await api('/api/auth?action=logout', { method: 'POST' }).catch(() => {});
  forgetSession();
  returnTo = null;
  go('#/login');
}));

function bindThemeButton(button) {
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
for (const button of document.querySelectorAll('[data-theme-set]')) bindThemeButton(button);
syncThemeButtons();
window.addEventListener('hashchange', render);
const refreshButton = document.getElementById('refresh');
refreshButton.addEventListener('click', () => refreshNow(refreshButton));
render();
