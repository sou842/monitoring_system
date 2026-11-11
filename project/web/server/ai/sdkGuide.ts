import ErrorTracker from '@sourav732/error-tracker-js';
import { tool } from 'ai';
import { z } from 'zod';

/**
 * The SDK integration guide the AI assistants read on demand (`read_sdk_guide`
 * tool), so setup knowledge doesn't sit in every prompt. The version comes from
 * the SDK package this app is built with, so it can't go stale.
 *
 * Keep it in step with error-tracking-sdk/js/README.md when the SDK changes.
 */
export const SDK_VERSION: string = ErrorTracker.version;

/**
 * Every JS SDK release published on npm, newest first (`npm view @sourav732/error-tracker-js versions`,
 * without the `0.0.0-stage` test upload). Add each new release here: tests/sdkGuide.test.ts fails while
 * the bundled SDK version is not the first entry.
 */
export const PUBLISHED_RELEASES: readonly string[] = [
  '0.12.0', '0.11.1', '0.11.0', '0.10.0', '0.9.0', '0.8.0', '0.7.1', '0.7.0',
  '0.6.2', '0.6.1', '0.6.0', '0.5.0', '0.3.1', '0.3.0', '0.2.0', '0.1.0',
];
const PKG = '@sourav732/error-tracker-js';
const DASHBOARD = 'https://monitoringsystem-backend.vercel.app';
const ENDPOINT = `${DASHBOARD}/api/v1/events`;
const CDN = `https://cdn.jsdelivr.net/npm/${PKG}@${SDK_VERSION}/dist/index.mjs`;

const GUIDE = {
  overview: {
    title: 'What the SDK is, current version, where to start',
    body: `# Error Tracker JS SDK (current version ${SDK_VERSION})
In-house error, performance and memory monitoring for browser apps (and manual capture in Node). npm package \`${PKG}\`, zero runtime dependencies, ES5 code shipped as ESM (\`dist/index.mjs\`) and CommonJS (\`dist/index.cjs\`) with TypeScript types. There is no UMD/global build: plain pages load it as an ES module.
- Dashboard: ${DASHBOARD} (sign up, Projects → New project, copy the \`et_…\` API key; it is shown once, "Rotate API key" makes a new one). No limit on projects per account.
- Ingestion endpoint for \`init()\`: \`${ENDPOINT}\`.
- Browsers: Chrome 60+, Safari 12+, Firefox 60+ (some collectors are Chromium-only: long tasks, memory, page HTTP status in Safari). Node 18+ for manual capture (needs global fetch); automatic collectors only install where \`window\` exists, so importing it during SSR is safe.
- Golden rules: call \`init()\` once, as early as possible (before app code, not in a React useEffect); never throws, never logs unless \`debug: true\`; the API key is public in a browser app, so protect the project with Allowed origins (topic privacy_security).
Topics: install, html, react, nextjs, vue_angular_other, appzillon, appzillon_adapt, configuration, api, privacy_security, csp_cors, troubleshooting, versions, delivery.`,
  },
  install: {
    title: 'Installing: npm, CDN, self-hosted file',
    body: `# Installing (version ${SDK_VERSION})
- **npm / yarn / pnpm:** \`npm install ${PKG}\` then \`import ErrorTracker from '${PKG}'\` (default export) or named imports \`import { init, captureError } from '${PKG}'\`. CommonJS: \`const ErrorTracker = require('${PKG}').default\` (named exports also work).
- **CDN (no build step):** \`${CDN}\`, loaded as an ES module (\`<script type="module">\` or dynamic \`import()\`). Always pin the exact version in the URL: an unpinned URL changes behaviour under you and is cached by browsers for days. The file is minified; its source map (\`index.mjs.map\`) sits next to it.
- **Self-hosted:** copy \`node_modules/${PKG}/dist/index.mjs\` (and \`index.mjs.map\` if wanted) to your static folder and import it from there. Best for strict CSPs or networks that block CDNs.
- **Very old browsers** (no ES modules, e.g. IE11): the code is ES5 but only ships as ESM/CJS, so bundle it into your app with webpack/Rollup/Vite instead of loading the .mjs directly.
- Upgrading: read topic \`versions\` for behaviour changes between versions; the payload schema is backwards compatible.`,
  },
  html: {
    title: 'Plain HTML / multi-page sites / jQuery, with edge cases',
    body: `# Plain HTML pages
Put this as the FIRST script in \`<head>\` of every page (errors before \`init()\` are missed, except failed resources and CSP violations, which are recovered from browser buffers):
\`\`\`html
<script type="module">
  import ErrorTracker from '${CDN}';
  ErrorTracker.init({
    apiKey: 'et_your_project_key',
    endpoint: '${ENDPOINT}',
    environment: 'production',
    appVersion: '1.4.0',
  });
  window.ErrorTracker = ErrorTracker; // so classic (non-module) scripts can call it
</script>
\`\`\`
Edge cases:
- **Classic scripts calling it:** module scripts run deferred, after classic scripts in the body. Code that runs before the module finishes can't see \`window.ErrorTracker\`; guard calls (\`window.ErrorTracker && window.ErrorTracker.captureError(e)\`) or load the SDK with dynamic import from a classic script and keep a tiny queue:
\`\`\`html
<script>
  window.etQueue = [];
  window.et = function (method) { var args = [].slice.call(arguments, 1); window.ErrorTracker ? window.ErrorTracker[method].apply(null, args) : window.etQueue.push([method, args]); };
  import('${CDN}').then(function (m) {
    var ET = m.default;
    ET.init({ apiKey: 'et_your_project_key', endpoint: '${ENDPOINT}' });
    window.ErrorTracker = ET;
    window.etQueue.forEach(function (c) { ET[c[0]].apply(null, c[1]); });
  });
</script>
<!-- later: et('setUser', { id: 'u1' }); et('captureError', err, { step: 'pay' }); -->
\`\`\`
  (Inside the SDK, calls made before \`init()\` are already buffered, up to 100, but only once the module itself has loaded.)
- **Multi-page sites:** every page load is a new SDK instance; include the snippet on every page, including the 404 page (automatic PageNotFound needs it there). Unsent events are kept in localStorage and sent on the next page.
- **Single-URL apps that swap screens** (jQuery apps, wizards): call \`ErrorTracker.setScreen('Name')\` whenever a screen is shown (topic api, appzillon).
- **jQuery $.ajax / XHR:** captured automatically (the SDK wraps XMLHttpRequest and fetch); nothing to add.
- **file:// pages:** module scripts don't load from file:// in Chrome; serve the page over http(s) (even \`npx serve\`).
- **CSP:** allow the CDN in \`script-src\` and the endpoint origin in \`connect-src\` (topic csp_cors).`,
  },
  react: {
    title: 'React (Vite, Create React App, React Router), React 18 and 19',
    body: `# React
**1. Initialise at the top of the entry file, before rendering** (not in a component, not in useEffect: that misses errors in the first render):
\`\`\`tsx
// src/main.tsx (Vite) or src/index.tsx (CRA)
import ErrorTracker from '${PKG}';
ErrorTracker.init({
  apiKey: import.meta.env.VITE_ET_API_KEY,          // CRA: process.env.REACT_APP_ET_API_KEY
  endpoint: '${ENDPOINT}',
  environment: import.meta.env.MODE,
  appVersion: import.meta.env.VITE_APP_VERSION,
});
import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
\`\`\`
(Imports are hoisted; if init must run before other modules execute, put it in its own \`src/monitoring.ts\` and make that the first import.)
**2. Errors React catches itself.** An error thrown while rendering is caught by React and never reaches \`window.onerror\` when an error boundary handles it, so report it there:
\`\`\`tsx
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    ErrorTracker.captureError(error, { componentStack: info.componentStack });
  }
  render() { return this.state.failed ? <p>Something went wrong.</p> : this.props.children; }
}
\`\`\`
React 19 alternative without a boundary class: \`createRoot(el, { onCaughtError: (e, info) => ErrorTracker.captureError(e, { componentStack: info.componentStack }), onRecoverableError: (e) => ErrorTracker.captureError(e, { recoverable: true }) })\`. Uncaught render errors (no boundary) unmount the app and are reported automatically; the SDK reports one event per error object, so a boundary + global handler won't double-count the same error.
**3. React Router:** route changes (pushState/popstate) are tracked automatically as navigation breadcrumbs and page views. For data routers use \`errorElement\` and report in it: \`const error = useRouteError(); useEffect(() => { ErrorTracker.captureError(error) }, [error]);\`. Not-found route: \`<Route path="*" element={<NotFound/>} />\` with \`useEffect(() => ErrorTracker.capturePageNotFound(), [])\`.
**4. Users:** \`ErrorTracker.setUser({ id, email, name })\` after login, \`setUser(null)\` on logout. Prefer an id over email if emails are sensitive.
Edge cases: StrictMode double-invokes effects in dev, which is harmless for module-level init (a second \`init()\` is ignored with a debug warning). Event handlers/async code errors are not caught by boundaries but are caught globally (uncaught/unhandledrejection). Errors you catch yourself need \`captureError\`. Hydration warnings (SSR React) are console errors: enable \`captureConsoleErrors: true\` if you want them.`,
  },
  nextjs: {
    title: 'Next.js (App Router and Pages Router, client + server errors)',
    body: `# Next.js
**Client, Next 15.3+ (App Router or Pages Router): \`instrumentation-client.ts\`** at the project root (next to \`app/\`), runs in the browser before React hydrates, so hydration and first-render errors are captured:
\`\`\`ts
// instrumentation-client.ts
import ErrorTracker from '${PKG}';
const apiKey = process.env.NEXT_PUBLIC_ET_API_KEY;
if (apiKey) {
  ErrorTracker.init({
    apiKey,
    endpoint: process.env.NEXT_PUBLIC_ET_ENDPOINT || '${ENDPOINT}',
    environment: process.env.NODE_ENV,
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
  });
}
\`\`\`
\`NEXT_PUBLIC_*\` values are baked in at build time: rebuild after changing them.
**Older Next (< 15.3):** App Router: a client component with module-level init, rendered in the root layout: \`'use client'; import ET from '${PKG}'; if (typeof window !== 'undefined') ET.init({...}); export default function Monitoring() { return null; }\`. Pages Router: init at module level in \`pages/_app.tsx\` (guarded by \`typeof window !== 'undefined'\`).
**Error pages (App Router)** catch render errors, so report them there:
\`\`\`tsx
// app/error.tsx (and app/global-error.tsx, which must render its own <html><body>)
'use client';
import { useEffect } from 'react';
import ErrorTracker from '${PKG}';
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { ErrorTracker.captureError(error, { digest: error.digest ?? null }); }, [error]);
  return <button onClick={reset}>Try again</button>;
}
\`\`\`
In production, server-component errors arrive in the browser with a generic message and a \`digest\`; the real error is reported by the server part below, and the \`digest\` links the two.
**Not found:** \`app/not-found.tsx\` (client) with \`useEffect(() => ErrorTracker.capturePageNotFound(), [])\`. Pages Router: \`pages/404.tsx\` the same way.
**Server errors on Next 13/14** (no \`onRequestError\` hook there): report where you catch them, with a small helper, and \`await ErrorTracker.flush()\` before returning:
\`\`\`ts
// lib/reportServerError.ts (server only)
import ErrorTracker from '${PKG}';
export async function reportServerError(error: unknown, context: Record<string, unknown> = {}) {
  if (!ErrorTracker.isInitialized()) ErrorTracker.init({ apiKey: process.env.ET_API_KEY!, endpoint: '${ENDPOINT}', environment: process.env.NODE_ENV });
  ErrorTracker.captureError(error, { source: 'server', ...context });
  await ErrorTracker.flush();
}
// app/api/orders/route.ts
export async function GET(req: Request) {
  try { /* … */ } catch (e) { await reportServerError(e, { path: new URL(req.url).pathname }); return Response.json({ error: 'failed' }, { status: 500 }); }
}
\`\`\`
Server-component render errors on 13/14 can only be seen in the browser (\`app/error.tsx\`, with a \`digest\`) unless you wrap the data-loading code the same way; upgrading to Next 15 gives the automatic hook below.
**Server errors, Next 15+** (API routes, server components, SSR, server actions, middleware): \`instrumentation.ts\` (\`onRequestError\` is Next 15+ only)
\`\`\`ts
// instrumentation.ts
import type { Instrumentation } from 'next';
export function register() {}
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return; // Edge runtime: not supported/verified
  const { default: ErrorTracker } = await import('${PKG}');
  if (!ErrorTracker.isInitialized()) {
    ErrorTracker.init({ apiKey: process.env.ET_API_KEY!, endpoint: '${ENDPOINT}', environment: process.env.NODE_ENV });
  }
  const err = error instanceof Error ? error : new Error(String(error));
  ErrorTracker.captureError(err, { source: 'server', method: request.method, path: request.path, route: context.routePath, route_type: context.routeType, digest: (err as { digest?: string }).digest ?? null });
  await ErrorTracker.flush(); // serverless functions may freeze right after the response
};
\`\`\`
Server-side notes: the endpoint must be absolute (a relative \`/api/...\` works only in the browser); Node 18+; only \`captureError\`/\`captureMessage\` work there (no automatic collectors); server events have no \`Origin\` header, so Allowed origins never blocks them. Use a separate project (or \`environment\`) if you want server and browser errors apart.
**CSP:** if you set a CSP (middleware or next.config headers), add the endpoint origin to \`connect-src\`. Route changes in App Router are tracked automatically (pushState).`,
  },
  vue_angular_other: {
    title: 'Vue 3, Angular, Svelte, other frameworks',
    body: `# Other frameworks
**Vue 3** (main.ts, init before \`createApp\`):
\`\`\`ts
import ErrorTracker from '${PKG}';
ErrorTracker.init({ apiKey: import.meta.env.VITE_ET_API_KEY, endpoint: '${ENDPOINT}' });
const app = createApp(App);
app.config.errorHandler = (err, instance, info) => ErrorTracker.captureError(err, { info, component: instance?.$options.name });
app.mount('#app');
\`\`\`
Vue's errorHandler swallows component errors, so without it they're missed. Vue Router not-found: \`{ path: '/:pathMatch(.*)*', component: NotFound }\`, call \`capturePageNotFound()\` in \`onMounted\`.
**Angular:** init in \`main.ts\` before \`bootstrapApplication\`/\`platformBrowserDynamic\`, and replace the ErrorHandler (Angular catches zone errors itself):
\`\`\`ts
@Injectable()
export class TrackerErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    // HTTP failures are already reported by the SDK as HttpError/NetworkError; skip them to avoid duplicates.
    if (error instanceof HttpErrorResponse) { console.error(error); return; }
    ErrorTracker.captureError(error);
    console.error(error);
  }
}
// providers: [{ provide: ErrorHandler, useClass: TrackerErrorHandler }]
\`\`\`
Never pass an \`HttpErrorResponse\` object as context: its \`url\` may contain tokens and \`error\` holds the raw response body (the SDK itself only reads an allowlist of error fields).
**Svelte/SvelteKit:** init in the client entry (\`hooks.client.ts\`), report in \`handleError\`. **Server-rendered apps** in general: init only in the browser bundle; for server errors use the Node pattern from topic nextjs.
**Micro-frontends / several bundles on one page:** init once (in the shell); a second \`init()\` is ignored. Different teams wanting separate projects need separate pages, not two instances.`,
  },
  appzillon: {
    title: 'Appzillon: the reference integration (tracker block, helpers, server-call wrapper, screens, login/logout)',
    body: `# Appzillon integration (reference, as used in a real admin app)
Appzillon (low-code banking platform, jQuery SPAs: screens change without URL changes, server calls go through \`apz.server.*\` with a \`callBack\`) can't be modified by the team, so the SDK is added as one self-contained block in an app-level script that loads first. It is loaded from jsDelivr with an exact version. Projects differ in names (see topic appzillon_adapt) but follow this shape. Replace \`et_your_project_key\` with the project's key and add the app's origins to the project's Allowed origins.
\`\`\`js
// ---- Error tracker ----
(function () {
    var SDK_URL = '${CDN}'; // always an exact version
    var DEV = location.hostname === 'localhost';

    // Appzillon error codes that are normal business outcomes (wrong password, validation, ...), not bugs.
    var IGNORED_ERROR_CODES = ['$APZ-SMS-EX-003', 'APZ-FM-EX-038', 'APZ_FM_EX_038'];

    var cfg = {
        apiKey: 'et_your_project_key',
        endpoint: '${ENDPOINT}',
        environment: DEV ? 'development' : 'production',
        appVersion: (window.apz && apz.appVersion) || '2.0.0',
        debug: DEV
    };

    // Calls made before the SDK has loaded are kept here and replayed after init.
    var MAX_PENDING = 50;
    var pending = [];
    function withTracker(fn) {
        if (window.ErrorTracker) { try { fn(window.ErrorTracker); } catch (e) { /* never break the app */ } }
        else if (pending.length < MAX_PENDING) { pending.push(fn); }
    }

    // Start loading as early as possible so fewer startup errors are missed.
    import(SDK_URL).then(function (m) {
        m.default.init(cfg);
        window.ErrorTracker = m.default;
        var queued = pending; pending = []; queued.forEach(withTracker);
    }).catch(function (e) { pending = []; if (DEV) { console.log('Error tracker failed to load: ' + e); } });

    // Safe helpers for the rest of the app: never throw, queue until the tracker has loaded.
    apz.admin.track = {
        error:   function (e, ctx)   { withTracker(function (t) { t.captureError(e, ctx); }); },
        message: function (msg, lvl) { withTracker(function (t) { t.captureMessage(msg, lvl || 'info'); }); },
        user:    function (id)       { withTracker(function (t) { t.setUser(id ? { id: String(id), name: String(id), email: null } : null); }); },
        crumb:   function (msg, type){ withTracker(function (t) { t.addBreadcrumb({ type: type || 'log', message: msg }); }); },
        screen:  function (name)     { withTracker(function (t) { t.setScreen(name || null); }); }
    };

    // captureMessage can't carry context, so server failures are sent as a named error.
    function serverError(msg, ctx) {
        var err = new Error(msg);
        err.name = 'AppzillonServerError';
        apz.admin.track.error(err, ctx);
    }

    // Wrap every server call's callBack: report failed responses, and errors thrown inside the callback
    // (Appzillon catches callback errors itself and only console.logs them, so the tracker never sees them otherwise).
    function wrapCallBack(params, fnName) {
        if (!params || typeof params.callBack !== 'function' || params.callBack.__tracked) { return; }
        var original = params.callBack;
        var iface = params.ifaceName || fnName;
        var wrapped = function (res) {
            try {
                if (res && res.status === false) {
                    serverError('Server call failed: ' + iface, { iface: iface });
                } else if (res && res.resFull && res.resFull.appzillonHeader && res.resFull.appzillonHeader.status === false) {
                    var errs = res.resFull.appzillonErrors || [];
                    var code = errs.length ? errs[0].errorCode : null;
                    if (IGNORED_ERROR_CODES.indexOf(code) === -1) {
                        serverError('Server returned error: ' + iface, {
                            iface: iface, errorCode: code, errorMessage: errs.length ? errs[0].errorMessage || null : null
                        });
                    }
                }
            } catch (trackErr) { /* tracking must never break the callback */ }
            try {
                return original.apply(this, arguments);
            } catch (e) {
                apz.admin.track.error(e, { iface: iface, callback: original.name || null });
                throw e; // keep Appzillon's own behaviour
            }
        };
        wrapped.__tracked = true;
        params.callBack = wrapped;
    }
    ['callServer', 'sendReq', 'login', 'logout', 'changePassword'].forEach(function (name) {
        var original = apz.server[name];
        if (typeof original !== 'function') { return; }
        apz.server[name] = function (params) {
            if (name === 'logout') { apz.admin.track.user(null); } // next user's errors must not carry this user's id
            wrapCallBack(params, name);
            return original.apply(this, arguments);
        };
    });

    // Screens: tell the tracker which one is showing (setScreen also leaves a "Screen: X" breadcrumb).
    ['launchScreen', 'launchSubScreen'].forEach(function (name) {
        var original = apz[name];
        if (typeof original !== 'function') { return; }
        apz[name] = function (obj) {
            try { if (obj && typeof obj.scr === 'string' && obj.scr) { apz.admin.track.screen(obj.scr); } } catch (e) { /* never break navigation */ }
            return original.apply(this, arguments);
        };
    });
})();
// ---- End error tracker ----
\`\`\`
**Login: attach the user** in the login callback, right after success (the user id only; no names/emails if they're customers):
\`\`\`js
apz.admin.LoginScreen.LgCB = function (params) {
    if (params.status && params.resFull.appzillonHeader.status && params.res.loginResponse.status) {
        apz.admin.appglobals.userId = params.req.loginRequest.userId;
        apz.admin.track.user(apz.admin.appglobals.userId);   // attach logged-in user to tracker events
        // ...rest of the app's own login code unchanged
    }
};
\`\`\`
Logout needs no extra code: the \`apz.server.logout\` wrapper above calls \`track.user(null)\`.
What this gives: the \`AppzillonServerError\` events (message \`Server call failed: <iface>\` or \`Server returned error: <iface>\`, context \`iface\`, \`errorCode\`, \`errorMessage\`), callback exceptions with the interface name, every event tagged with the screen (\`obj.scr\`) and user id, plus the automatic ones: real HTTP 5xx on \`POST /AppzillonWeb\`, failed \`scrdef\`/\`ifacedef\` loads, JS errors, slow calls, page views per screen.
Notes: the project's pinned SDK version should be **0.11.1 or newer** (0.11.0 could report false \`BlankPage\` events because Appzillon keeps earlier screens hidden in the DOM). \`IGNORED_ERROR_CODES\` is per project: add the codes that are normal outcomes (wrong password, validation, expired password); keep real failures reportable. Never put request/response bodies in the context (customer data).`,
  },
  appzillon_adapt: {
    title: 'Appzillon: adapting the reference to a different project, questions to ask, Appzillon-specific troubleshooting',
    body: `# Adapting the Appzillon integration to another project
Appzillon projects are similar but not identical. Start from the reference in topic \`appzillon\` and check each item below against the user's code; ask the user to paste the relevant lines when you can't tell. Never assume names.
**1. Namespace for the helpers.** The reference uses \`apz.admin.track\` because that app's namespace is \`apz.admin\`. Other apps use their own (\`apz.<appId>\`, \`apz.app\`…). Use any object that exists when the block runs, or create one (\`window.tracker = {...}\`). Everything else only calls \`track.error/user/screen/crumb/message\`.
**2. Where the block goes.** It must run before the app's screens and before login: the first script the app loads (an app-level JS file loaded by index/landing HTML). Several apps/modules on one page or in iframes: initialise once in the shell; a second \`init()\` is ignored.
**3. Screen id.** Reference apps call \`apz.launchScreen({ scr: 'Landing' })\` so the id is \`obj.scr\`. Others use \`screenId\`, \`id\` or \`scrName\`; look at one real call. If the screen is only a sub-screen of a parent, \`launchSubScreen\` can be wrapped the same way (the last call wins). Don't build names from data (\`Order 42\`): the screen name groups issues and page views.
**4. Server-call functions.** The reference wraps \`callServer, sendReq, login, logout, changePassword\` on \`apz.server\`. Other projects may use a subset, different names, or call \`apz.server.callServer\` with different parameters. Check the real names in the app's scripts (grep \`apz.server.\`) and where the callback property lives (\`callBack\` here; could be \`callback\`/\`successCB\`). Functions that don't exist are skipped safely.
**5. Failure shapes inside the callback.** Two seen: \`res.status === false\` (call failed at transport/platform level) and \`res.resFull.appzillonHeader.status === false\` with \`res.resFull.appzillonErrors[0].errorCode/errorMessage\` (business failure delivered as HTTP 200). Confirm the project's callbacks receive the same \`res\` shape; if their callbacks get the raw response, adapt the paths.
**6. Business codes vs real failures.** Normal outcomes (wrong password, validation, "password expired", session timeout handled by the app) must not become issues. Ask the user which error codes the app already handles with \`apz.dispMsg\`/custom messages and put them in \`IGNORED_ERROR_CODES\`. In the reference app, codes starting with \`$\` (e.g. \`$APZ-SMS-EX-003\`) are handled as messages by the login code; confirm what \`$\` means in the user's project before ignoring them all. Too many \`AppzillonServerError\` issues = the ignore list is too short; too few = it is too broad.
**7. Login/logout.** Call \`track.user(userId)\` in the login success callback (whatever function it is in that project) and \`track.user(null)\` on logout, session expiry or relogin. Use the stable user id, not names/emails.
**8. Config.** \`environment\` from hostname or an Appzillon config value (development/uat/production); \`appVersion\` from \`apz.appVersion\` if present; \`debug\` only on localhost. Allowed origins in the dashboard must list the app's real origins (scheme + host + port), for example \`http://localhost:8080\` and the UAT/prod hosts.
**9. Hosting the SDK.** CDN import needs \`https://cdn.jsdelivr.net\` reachable and allowed by the app's CSP, and \`connect-src\` for the endpoint. In networks that block CDNs, self-host \`index.mjs\` (topic install) and change \`SDK_URL\`. Pin an exact version; bump it deliberately.
**Appzillon-specific troubleshooting**
- *Nothing arrives:* \`debug\` is on only for localhost; open the console for "Error tracker failed to load" (CDN blocked/CSP) and check the Network tab for the POST to the endpoint (403 \`origin_not_allowed\` = add the origin). Then topic \`troubleshooting\`.
- *Events have no screen:* the \`launchScreen\` wrapper isn't running (wrong property name, wrapper installed after the first screen) or \`obj.scr\` isn't the field the app uses.
- *Events have no user / wrong user:* login callback not calling \`track.user\`, or logout paths that bypass \`apz.server.logout\` (session timeout).
- *Callback errors missing:* the call wasn't made through a wrapped \`apz.server\` function, or the callback was assigned after the call.
- *Server failures reported twice/noisy:* the same failure may arrive as HttpError (real HTTP status) and as \`AppzillonServerError\` (callback); that's expected only for real HTTP failures. Business failures are only seen as \`AppzillonServerError\`.
- *False \`BlankPage\` events:* upgrade the SDK to 0.11.1+ (hidden earlier screens).
- *Stack frames:* \`appzillon/scripts/appzillon/*.js\` are platform, \`jquery\`/\`fusioncharts\` are libraries; app code is the screen's own scripts and callbacks. Source maps aren't supported, so minified app files show minified frames.
- *Can't change the Appzillon platform itself:* everything above is done in app-level scripts; don't suggest patching \`appzillon.js\`.`,
  },
  configuration: {
    title: 'All init() options with defaults and limits',
    body: `# init() options
Required: \`apiKey\` (string, \`et_…\`), \`endpoint\` (ingestion URL). Invalid ones leave the SDK disabled (never throws).
| Option | Default | Notes |
|---|---|---|
| environment | 'production' | free text: staging, uat, development… |
| appVersion | null | your app's version; shown per event and in the issue breakdown, so you can tell which build is affected |
| sampleRate | 1.0 | 0–1, share of error events kept |
| maxBreadcrumbs | 30 | max 100 |
| maskSelectors | [] | CSS selectors whose text is replaced by [masked] in click breadcrumbs; password inputs always masked |
| trackDevice | true | random anonymous \`device.id\` kept in localStorage (\`_et_device\`) so events from one browser can be linked; false = \`device.id\` null (the per-tab \`session_id\` is still sent) |
| debug | false | log SDK diagnostics to the console |
| captureHttpErrors | true | fetch/XHR error statuses → HttpError |
| httpErrorStatuses | [400, 404, 405, 413, [500, 599]] | codes and inclusive [min,max] ranges; 401/403/409/422/429 not reported by default; [] = none |
| captureNetworkErrors | true | no response (offline, DNS, CORS, timeout) → NetworkError; app aborts never reported |
| captureConsoleErrors | false | every console.error → event (noisy) |
| detectPageNotFound | true | page served with 404/410 → PageNotFound |
| detectBlankPage | true | BlankPage detection |
| beforeSend | — | (event) => event or null; scrub or drop; if it throws, the original is sent |
| performanceSampleRate | 1.0 | share of page loads whose page views (transactions) are sent |
| beforeSendTransaction | — | like beforeSend for page views |
| captureSlowEvents | false | also report each slow call/page as an issue (5 min cooldown per endpoint) |
| slowApiCallMs | 2000 | 100–600000 |
| slowPageLoadMs | 3000 | 100–600000 |
| mainThreadBlockedMs | 1000 | 50–60000, Chromium only |
| lowFrameRateFps | 20 | 1–60 |
| memoryPollIntervalMs | 30000 | 5000–3600000, Chromium only |
| memoryLeakGrowth | 0.2 | 0.01–10 (ratio) |
| memoryLeakMinGrowthMb | 10 | 1–4096 |
| memoryLeakReadings | 4 | 2–20 |
Out-of-range numbers are clamped to the nearest limit; non-numbers are ignored (default used). Transport, dedup and rate limits are deliberately not configurable.`,
  },
  api: {
    title: 'Public methods and their exact behaviour',
    body: `# Public API (default export ErrorTracker, also named exports)
- \`init(config)\`: once; later calls are ignored. Calls made before init are buffered (max 100) and replayed.
- \`captureError(error, context?)\`: report a caught error (\`handled: true\`). Non-Error values work (\`thrown_kind\` notes it; no stack). \`context\` = JSON-serialisable object; keep it small and free of secrets.
- \`captureMessage(message, level?)\`: level 'info' | 'warning' | 'error' (default info), event_type message.
- \`capturePageNotFound(url?)\`: report a missing route (SPA not-found screens; Safari). Defaults to the current URL; deduplicated with the automatic 404 report.
- \`setUser({ id, email?, name? } | null)\`: attached to every later event.
- \`setScreen(name | null)\`: current screen for single-URL apps; trimmed, max 200 chars, repeats ignored; adds a "Screen: X" breadcrumb and starts a new page view. Use stable names ("OrderDetails", not "Order 42").
- \`addBreadcrumb({ type, message, data? })\`: your own trail entries (type is free text, e.g. 'cart').
- \`flush(): Promise<void>\`: send now (never rejects). Use before a serverless function returns.
- \`close(): Promise<void>\`: flush, remove every hook, persist anything unsent.
- \`isInitialized(): boolean\`, \`ErrorTracker.version\` (string).
Automatic (no code): uncaught errors and rejections, fetch/XHR failures and timings, failed scripts/images/styles/fonts, CSP violations, worker errors, PageNotFound, BlankPage, slow pages, long tasks, low FPS, memory leaks, page views with Web Vitals, click/navigation/API breadcrumbs.`,
  },
  privacy_security: {
    title: 'API key exposure, Allowed origins, PII, scrubbing',
    body: `# Privacy and security
- The browser API key is public (anyone can read it from the page). Protect the project in the dashboard: project page → Settings → **Allowed origins** (exact scheme+host+port, e.g. \`https://app.example.com\`, \`http://localhost:3000\`; no wildcards; max 20; empty = any origin). Requests from other origins get 403 \`origin_not_allowed\`. Requests without an Origin header (server SDK, mobile) are always allowed. There is also a per-IP limit (150 events/min and 150 page views/min per project).
- The key is kept in memory and in the request header only; never stored (the offline queue in localStorage has it removed). Rotate it on the project page if it leaks.
- Never collected: screenshots or screen recordings, HTML, form values, request/response bodies, cookies. URL query strings and fragments are stripped everywhere (tokens often live there). Click text from \`maskSelectors\` elements and password fields is masked.
- Device and session ids (0.12.0+): \`device.id\` is a random id in localStorage (\`_et_device\`), \`session_id\` a random id in sessionStorage (\`_et_session\`). Neither is derived from the person, the browser or the hardware (no fingerprinting); clearing site data gives a new device id. Turn the device id off with \`trackDevice: false\`. The server stores a keyed hash of the sender's IP network per project (\`networkId\`), never the IP.
- What you add yourself (\`setUser\`, \`captureError\` context, breadcrumbs) is sent as is: prefer ids over emails/names when users are customers; never put tokens, card numbers or bodies in context.
- Last line of defence: \`beforeSend\`
\`\`\`ts
beforeSend(event) {
  if (event.user) event.user.email = null;
  if (event.error && /password|token/i.test(event.error.message)) return null; // drop
  return event;
}
\`\`\``,
  },
  csp_cors: {
    title: 'Content Security Policy, CORS, cross-origin scripts and timing headers',
    body: `# CSP and CORS
- **CSP:** \`connect-src\` must include the endpoint origin (e.g. \`${DASHBOARD}\`), and \`script-src\` the CDN (\`https://cdn.jsdelivr.net\`) if loaded from there. Blocked sends fail silently (debug log only); violations of your own CSP are reported as \`CspViolation\`.
- **CORS to the endpoint** is handled by the dashboard server (it answers preflights; \`X-API-Key\` and \`Content-Type\` are allowed). Nothing to configure in the app.
- **"Script error." (CrossOriginScriptError):** scripts from another origin (CDN, widgets) hide their errors. Load them with \`crossorigin="anonymous"\` and serve them with \`Access-Control-Allow-Origin\`; the event's \`context.scripts_without_crossorigin\` lists candidate hosts.
- **Your own APIs on another origin:** server/download time in page views needs \`Timing-Allow-Origin: <your site>\`; request-id headers in HttpError context need \`Access-Control-Expose-Headers: x-request-id\` (or your header). Without them the fields are null; nothing breaks.`,
  },
  troubleshooting: {
    title: 'No events / too many events / wrong data: step-by-step checks',
    body: `# Troubleshooting
**Nothing arrives in the dashboard:**
1. Set \`debug: true\` and reload: the console says whether init succeeded ("invalid config … SDK disabled" = bad apiKey/endpoint) and logs failed sends with the HTTP status only ("endpoint rejected batch with status 403"). The reason code is in the response body, see step 2.
2. DevTools → Network, filter \`events\`: a POST to the endpoint about 2 s after an event; open it and read the JSON response (\`{ "error": "<code>", … }\`). Status/code: 401 \`invalid_api_key\` → wrong or rotated key (the server caches key lookups ~60 s, so a brand-new key may take a minute); 403 \`origin_not_allowed\` → add this origin to Allowed origins (exact scheme/host/port); 403 \`project_disabled\` → the owner's account is disabled; 429 \`rate_limited_ip\` → more than 150 events/min from one IP; (blocked:csp) → add the endpoint to connect-src; (blocked:other)/ERR_BLOCKED_BY_CLIENT → an ad blocker or corporate proxy (proxy the endpoint through your own domain, or allow-list it). A 401/403 is not retried, so those events are lost, not queued.
3. Is init running at all? \`ErrorTracker.isInitialized()\` in the console (needs \`window.ErrorTracker = ErrorTracker\`). In Next.js check \`NEXT_PUBLIC_\` env vars were set at build time.
4. \`sampleRate\` below 1, or \`beforeSend\` returning null, drops events.
5. Test: \`ErrorTracker.captureMessage('hello', 'info')\` then \`await ErrorTracker.flush()\`.
**Errors missing:** errors before init (move init earlier); errors caught by framework boundaries/handlers (React boundary, Vue errorHandler, Angular ErrorHandler: report there); errors swallowed by \`catch {}\`; errors inside cross-origin iframes.
**Too many / noisy events:** narrow \`httpErrorStatuses\`, leave \`captureConsoleErrors\` off, drop known noise in \`beforeSend\` (e.g. browser-extension frames), raise thresholds. Identical events within 5 s are merged and at most 100/min are sent (then one \`EventsDropped\`).
**"Script error." only:** see topic csp_cors. **Minified stack frames:** source maps are not supported yet; set \`appVersion\` so you can match the build.
**Events from development polluting production:** set \`environment\` and filter by it, or use separate projects/keys.
**BlankPage false alarms on 0.11.0:** upgrade (topic versions).`,
  },
  versions: {
    title: 'Version history and upgrade notes',
    body: `# Versions (current: ${SDK_VERSION})
Published releases on npm (\`@sourav732/error-tracker-js\`), **${PUBLISHED_RELEASES.length} in total**, newest first: ${PUBLISHED_RELEASES.join(', ')}. (0.4.0 was never published: its changes shipped in 0.5.0. \`0.0.0-stage\` on npm is a test upload, not a release.) Only the JavaScript SDK exists; iOS and Android are not built yet.

## What changed
- **0.12.0** – Device and session ids: every event carries \`device.id\` (random, kept in localStorage, same for one browser; \`trackDevice: false\` turns it off) and \`session_id\` (random, per tab, survives reloads, new after 30 min idle). The dashboard adds a hashed sender network (never the IP), shows Devices / sessions / networks on the issue page, and the issue search finds issues by any of these ids.
- **0.11.1** – BlankPage false-alarm fixes: hidden subtrees skipped, three checks over 3 s, full confirmation check, text and user-activity vetoes, \`context.confidence\` / \`samples\` / \`deep_check\`. Recommended for apps that keep hidden screens in the DOM (Appzillon).
- **0.11.0** – Diagnostic context on events (\`situation\`, \`error_causes\`, \`error_fields\`, ResourceError/HttpError/InvalidJsonResponse causes, server request-id headers).
- **0.10.0** – BlankPage detection (\`detectBlankPage\`).
- **0.9.0** – Unique \`_id\` on every API call (search an id in the dashboard).
- **0.8.0** – \`setScreen()\` and top-level \`screen\` field.
- **0.7.x** – XHR timing fix (0.7.1: requests recorded before app callbacks run).
- **0.6.0** – \`httpErrorStatuses\`; 401/403/409/422/429 no longer reported by default (behaviour change). 0.6.1: MainThreadBlocked/LowFrameRate context, memory-leak false-positive fix.
- **0.5.0** – Performance monitoring (page views as \`transaction\` events), \`captureSlowEvents\` now off by default (behaviour change), keepalive delivery on page leave.
- **0.4.0** (never published, shipped in 0.5.0) – Memory-leak detector rewrite (\`memoryLeakMinGrowthMb\`), background-tab Web Vitals fix.
- **0.3.0** – PageNotFound, configurable thresholds. 0.3.1: fixes.
- **0.2.0**, **0.1.0** – First releases: error, HTTP/network, resource, CSP, performance and memory collectors, offline queue.
Upgrading is a version bump (npm or the CDN URL); no code changes are required between any of these versions.`,
  },
  delivery: {
    title: 'How events are sent; using your own backend',
    body: `# Delivery
- Batches of up to 10 events (≤ ~1 MB) are POSTed 2 s after the first event: \`POST <endpoint>\`, headers \`Content-Type: application/json\` and \`X-API-Key\`, body \`{ "events": [ ... ] }\`.
- Retries: network errors, 5xx, 408, 429 → 3 retries after 1/2/4 s; other 4xx are dropped.
- Offline or retries exhausted → stored in \`localStorage["_et_queue"]\` (newest 50, key removed), resent on \`online\`, tab visible, or next page load.
- Page leave/hide → sent with \`fetch keepalive\` (batches ≤ 60 KB), else stored.
- Error storms: identical events (type + message + top frame) merged within 5 s; max 100 events/min, then one \`EventsDropped\` message.
- Own backend: any HTTPS endpoint accepting that body; every schema field is always present (null when unknown). Page views are separate \`event_type: "transaction"\` events.`,
  },
} as const;

export type SdkGuideTopic = keyof typeof GUIDE;
export const SDK_GUIDE_TOPICS = Object.keys(GUIDE) as SdkGuideTopic[];

/** One topic's text, for the `read_sdk_guide` tool. */
export function sdkGuide(topic: SdkGuideTopic): string {
  return GUIDE[topic].body;
}

/** "topic: title" lines for the tool description. */
export function sdkGuideIndex(): string {
  return SDK_GUIDE_TOPICS.map((t) => `${t}: ${GUIDE[t].title}`).join('; ');
}

/** The `read_sdk_guide` tool, given to both assistants. Reads static text only. */
export function sdkGuideTools() {
  return {
    read_sdk_guide: tool({
      description: `Reads one topic of the Error Tracker JS SDK guide (current version ${SDK_VERSION}). Call it before answering any question about installing, integrating, configuring, upgrading or troubleshooting the SDK, and quote its code. Topics: ${sdkGuideIndex()}.`,
      inputSchema: z.object({ topic: z.enum(SDK_GUIDE_TOPICS as [SdkGuideTopic, ...SdkGuideTopic[]]).describe('The topic to read.') }),
      execute: async (input) => ({ topic: input.topic, version: SDK_VERSION, text: sdkGuide(input.topic) }),
    }),
  };
}
