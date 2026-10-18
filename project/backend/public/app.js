/**
 * Error Tracker dashboard: a small single-page app with hash routes.
 *
 *   #/login            shared-password login
 *   #/projects         projects, create project / API key
 *   #/p/<projectId>    issues of a project (filters in the hash query)
 *   #/i/<issueId>      one issue with its events
 *
 * All event data comes from end users' browsers and is untrusted: the UI is
 * built from DOM nodes with textContent only, never innerHTML.
 */

const REFRESH_MS = 15000;
const SDK_PACKAGE = '@sourav732/error-tracker-js';
const SCREENSHOT_HOST = 'https://res.cloudinary.com/';
const STATUSES = ['open', 'resolved', 'ignored', 'all'];
const EVENT_TYPES = ['error', 'message', 'performance', 'crash'];

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const crumbs = document.getElementById('crumbs');
let refreshTimer = null;
let projectsCache = null;

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
    go('#/login');
    throw new ApiError('Session expired');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError((data.error && data.error.message) || `Request failed (${response.status})`);
  return data;
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function parseHash() {
  const raw = location.hash.slice(1) || '/projects';
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

function setCrumbs(...items) {
  const present = nodes(items);
  crumbs.replaceChildren(...present.flatMap((item, i) => (i > 0 ? [el('span', { text: '/' }), item] : [item])));
}

/** Replaces the page content, ignoring absent (null) sections. */
function show(...items) {
  app.replaceChildren(...nodes(items));
}

function loading() {
  show(el('p', { class: 'muted', text: 'Loading…' }));
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

async function getProjects(force = false) {
  if (force || projectsCache === null) projectsCache = (await api('/api/projects')).projects;
  return projectsCache;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function loginPage() {
  topbar.hidden = true;
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
        go('#/projects');
      } catch (error) {
        message.textContent = error.message;
        message.hidden = false;
        submit.disabled = false;
        input.select();
      }
    },
  }, input, submit, message);

  show(el('div', { class: 'login card card-body' },
    el('h1', { text: 'Error Tracker' }),
    el('p', { class: 'muted', text: 'Log in to see your projects and issues.' }),
    form,
  ));
  input.focus();
}

async function projectsPage() {
  setCrumbs(el('span', { text: 'Projects' }));
  loading();
  const projects = await getProjects(true);

  const createArea = el('div');
  const newButton = el('button', { class: 'primary', text: 'New project', onclick: () => showCreateForm(createArea, newButton) });

  const cards = projects.map((p) =>
    el('div', { class: 'card' },
      el('a', { class: 'project-card', href: `#/p/${p.id}` },
        el('h2', { text: p.name }),
        el('div', { class: 'muted small mono', text: `Key: ${p.apiKeyHint}` }),
        el('div', { class: 'stats' },
          el('div', { class: 'stat' }, el('b', { text: p.openIssues }), el('span', { class: 'muted small', text: 'open issues' })),
          el('div', { class: 'stat' }, el('b', { text: p.events24h }), el('span', { class: 'muted small', text: 'events (24h)' })),
        ),
      ),
    ),
  );

  show(
    el('div', { class: 'row' }, el('h1', { text: 'Projects' }), el('span', { class: 'spacer' }), newButton),
    el('p', { class: 'muted', text: 'Each app that sends errors is a project with its own API key.' }),
    createArea,
    projects.length > 0 ? el('div', { class: 'grid section' }, cards) : el('div', { class: 'card empty section', text: 'No projects yet. Create one to get an API key.' }),
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
        projectsCache = null;
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
  const data = await api(`/api/issues?${params}`);

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
    projectsCache = null;
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
      ? el('div', { class: 'card card-body' },
          el('h2', { text: 'No issues yet' }),
          el('p', { class: 'muted', text: `Errors appear here as soon as an app using this project's key (${project.apiKeyHint}) sends them. Setup:` }),
          el('div', { class: 'key-box' }, el('pre', { text: setupSnippet('<your API key>') })))
      : el('div', { class: 'card empty', text: 'No issues match these filters.' });
  } else {
    list = el('div', { class: 'card' },
      el('div', { class: 'list-head' }, selectAll, el('span', { text: 'Issue' }), el('span', { text: 'Events' }), el('span', { text: 'Last seen' })),
      data.issues.map((issue) => {
        const box = el('input', { type: 'checkbox', attrs: { 'aria-label': 'Select issue' } });
        box.addEventListener('change', () => { if (box.checked) selected.add(issue.id); else selected.delete(issue.id); updateSelection(); });
        box.addEventListener('click', (e) => e.stopPropagation());
        boxes.push(box);
        return el('a', { class: 'issue-row', href: `#/i/${issue.id}` },
          box,
          el('div', { attrs: { style: 'min-width:0' } },
            el('div', { class: 'issue-title' }, badge(issue.eventType), ' ', issue.errorType,
              issue.status !== 'open' ? [' ', badge(issue.status)] : null,
              issue.regressedAt && issue.status === 'open' ? [' ', badge('regressed', 'error')] : null),
            el('div', { class: 'issue-msg', text: issue.message || '(no message)' }),
            el('div', { class: 'muted small', text: [issue.culprit, issue.environments.join(', ')].filter(Boolean).join(' · ') }),
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
      projectsCache = null;
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
      projectsCache = null;
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
      projectsCache = null;
      go('#/projects');
    },
  });

  show(
    el('div', { class: 'row' }, el('h1', { text: project.name }), el('span', { class: 'spacer' }), rotate, deleteProject),
    el('p', { class: 'muted small', text: `${data.total} issue(s) · refreshes every ${REFRESH_MS / 1000}s` }),
    tabs, filterBar,
    data.issues.length > 0 ? el('div', { class: 'row bulk' }, deleteSelected, el('span', { class: 'spacer' }), clearAll) : null,
    list, pager,
  );
  // Keep the search box focused across auto-refreshes.
  if (query.get('q')) search.focus();
  refreshTimer = setInterval(() => { if (document.activeElement !== search && selected.size === 0) render(); }, REFRESH_MS);
}

async function issuePage(issueId, query) {
  loading();
  const data = await api(`/api/issue?id=${issueId}`);
  const { issue } = data;
  const selectedId = query.get('event') || (data.latestEvent && data.latestEvent.id);
  const event = !selectedId ? null
    : data.latestEvent && data.latestEvent.id === selectedId ? data.latestEvent
    : (await api(`/api/event?id=${selectedId}`)).event;

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
        projectsCache = null;
        go(data.project ? `#/p/${data.project.id}` : '#/projects');
      },
    }),
  );

  const header = el('div', { class: 'card card-body' },
    el('div', { class: 'issue-header' },
      el('div', { class: 'title' },
        el('div', { class: 'row' }, badge(issue.eventType), badge(issue.status), issue.regressedAt && issue.status === 'open' ? badge('regressed', 'error') : null),
        el('h1', { class: 'section', text: issue.errorType }),
        el('div', { class: 'message', text: issue.message || '(no message)' }),
        issue.culprit ? el('div', { class: 'muted mono small section', text: issue.culprit }) : null,
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
    event ? eventDetail(event) : el('div', { class: 'card empty', text: 'No events stored (older events are deleted after 30 days).' }),
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
  const { parts, query } = parseHash();
  try {
    if (parts[0] === 'login') return loginPage();
    const session = await api('/api/auth/session');
    if (!session.authenticated) return go('#/login');
    topbar.hidden = false;
    if (parts[0] === 'p' && parts[1]) return await issuesPage(parts[1], query);
    if (parts[0] === 'i' && parts[1]) return await issuePage(parts[1], query);
    return await projectsPage();
  } catch (error) {
    showError(error);
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  projectsCache = null;
  go('#/login');
});
window.addEventListener('hashchange', render);
render();
