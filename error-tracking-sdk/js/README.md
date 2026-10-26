# Error Tracker — JavaScript SDK

Client-side error, performance and memory monitoring for browser apps (vanilla JS, React, Vue, Next.js, …).
The SDK captures problems in the page and sends them to the **Error Tracker dashboard**, where they are grouped into issues with stack traces, breadcrumbs, screenshots and charts.

**Dashboard: [monitoringsystem-backend.vercel.app](https://monitoringsystem-backend.vercel.app/)**. Free to sign up, and your projects are visible only to your account.

- **Zero runtime dependencies.** ES5 output, ESM and CommonJS builds, TypeScript types included.
- **Never breaks the host app.** Every hook is guarded. SDK failures are swallowed and logged only when `debug: true`.
- **Silent by default.** Nothing is written to the console unless `debug: true`.
- **Supported environments:** Chrome 60+, Safari 12+, Firefox 60+, and Node.js 14+ (manual capture only; Node needs a global `fetch`, i.e. 18+, to deliver events).

## Get your API key

1. Open **[monitoringsystem-backend.vercel.app](https://monitoringsystem-backend.vercel.app/)** and create an account.
2. Go to **Projects → New project**, give it your app's name, and copy the API key (`et_…`). It is shown only once; if you lose it, use **Rotate API key** on the project page.
3. Install the SDK and call `init()` with that key (below). Errors appear in the dashboard within seconds.

One project per app or website. Each account can have up to 10 projects.

## Installation

```bash
npm install @sourav732/error-tracker-js
```

## Quick start

Initialise as early as possible, before the rest of your app code runs:

```ts
import ErrorTracker from '@sourav732/error-tracker-js';

ErrorTracker.init({
  apiKey: 'et_your_project_key',                                     // from the dashboard
  endpoint: 'https://monitoringsystem-backend.vercel.app/api/v1/events',
  environment: 'production',
  appVersion: '2.1.4',
  sampleRate: 1.0,
  maxBreadcrumbs: 30,
  maskSelectors: ['.credit-card', '[data-private]', '#ssn'],
  debug: false,
});
```

Uncaught errors, unhandled promise rejections, failed resource loads, slow page loads, slow API calls and suspected memory leaks are all reported automatically. You can also report things yourself:

```ts
try {
  await submitPayment(cart);
} catch (err) {
  ErrorTracker.captureError(err, { cartId: cart.id, step: 'payment' });
}

ErrorTracker.captureMessage('Checkout started', 'info'); // 'info' | 'warning' | 'error'

ErrorTracker.setUser({ id: 'usr_8821', email: 'jane@example.com', name: 'Jane' });
ErrorTracker.setUser(null); // on logout

ErrorTracker.addBreadcrumb({ type: 'cart', message: 'Applied coupon', data: { code: 'SPRING' } });
```

You can call any method before `init()`. Up to 100 calls are buffered and replayed once the SDK starts.

Open your project in the [dashboard](https://monitoringsystem-backend.vercel.app/) to see the issues: filter by type, environment and status, resolve or ignore them, and inspect each event's stack trace, breadcrumbs, device and performance data. A resolved issue reopens automatically if the error comes back.

**Your own backend instead:** `endpoint` can be any server that accepts the batch format described under [Delivery](#delivery).

### React

```tsx
import ErrorTracker from '@sourav732/error-tracker-js';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    ErrorTracker.captureError(error, { componentStack: info.componentStack });
  }
  render() {
    return this.state.failed ? <p>Something went wrong.</p> : this.props.children;
  }
}
```

### Vue 3

```ts
app.config.errorHandler = (err, instance, info) => {
  ErrorTracker.captureError(err, { info, component: instance?.$options.name });
};
```

### Script tag (no bundler)

```html
<script type="module">
  import ErrorTracker from '/vendor/error-tracker/index.mjs';
  ErrorTracker.init({ apiKey: 'et_your_project_key', endpoint: 'https://monitoringsystem-backend.vercel.app/api/v1/events' });
</script>
```

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | required | Sent in the `X-API-Key` header. Kept in memory only, never written to storage. |
| `endpoint` | `string` | required | Ingestion URL. Batches are POSTed here. For the hosted dashboard: `https://monitoringsystem-backend.vercel.app/api/v1/events`. |
| `environment` | `string` | `'production'` | Free-form, e.g. `staging`. |
| `appVersion` | `string` | `null` | Your app's version. |
| `sampleRate` | `number` | `1.0` | 0–1. Each event is dropped when `Math.random() > sampleRate`. |
| `maxBreadcrumbs` | `number` | `30` | Size of the breadcrumb ring buffer (max 100). |
| `maskSelectors` | `string[]` | `[]` | Elements to black out in screenshots and hide in click breadcrumbs. `input[type="password"]` is always masked. |
| `debug` | `boolean` | `false` | Log SDK diagnostics to the console. |
| `captureHttpErrors` | `boolean` | `true` | Report fetch/XHR responses whose status is in `httpErrorStatuses` as `HttpError` events. |
| `httpErrorStatuses` | `Array<number \| [min, max]>` | `[400, 404, 405, 413, [500, 599]]` | Which statuses count as errors. See [Which HTTP statuses are reported](#which-http-statuses-are-reported). *Added in 0.6.0;* earlier versions reported every 4xx and 5xx. |
| `captureNetworkErrors` | `boolean` | `true` | Report fetch/XHR requests that got no response (offline, timeout, refused, DNS/SSL, CORS) as `NetworkError`. Requests the app aborts are never reported. |
| `captureConsoleErrors` | `boolean` | `false` | Report each `console.error(...)` call as an event. Off by default because libraries log a lot of noise there. |
| `captureScreenshots` | `boolean` | `false` | Attach a viewport screenshot to **unhandled** errors (`handled: false`). *Off by default since 0.6.2*: rendering one freezes the page (see [Screenshots](#screenshots-and-content-security-policy)). |
| `detectPageNotFound` | `boolean` | `true` | Report a `PageNotFound` event when the page itself was served with a 404 or 410 status. See [Missing pages](#missing-pages-404). |
| `html2canvasUrl` | `string` | cdnjs html2canvas 1.4.1 | Where the screenshot library is loaded from. |
| `html2canvasIntegrity` | `string` | SRI hash of the default URL | SRI hash for `html2canvasUrl`. Defaults to `''` (no check) when you set a custom URL. |
| `beforeSend` | `(event) => event \| null` | — | Scrub or drop events before they are queued. If the hook throws, the original event is sent. Not called for page views; see `beforeSendTransaction`. |
| `performanceSampleRate` | `number` | `1.0` | 0–1. Share of page loads whose page views are recorded. See [Performance monitoring](#performance-monitoring). *Added in 0.5.0.* |
| `beforeSendTransaction` | `(event) => event \| null` | — | Like `beforeSend`, for page-view (`transaction`) events, e.g. to scrub URLs. *Added in 0.5.0.* |
| `captureSlowEvents` | `boolean` | `false` | Also report each slow API call and slow page load as its own issue. *Changed in 0.5.0:* off by default, since slow requests and pages show up in the Performance view. |
| `slowApiCallMs` | `number` | `2000` | See [Performance thresholds](#performance-thresholds). |
| `slowPageLoadMs` | `number` | `3000` | See [Performance thresholds](#performance-thresholds). |
| `mainThreadBlockedMs` | `number` | `1000` | See [Performance thresholds](#performance-thresholds). |
| `lowFrameRateFps` | `number` | `20` | See [Performance thresholds](#performance-thresholds). |
| `memoryPollIntervalMs` | `number` | `30000` | See [Performance thresholds](#performance-thresholds). |
| `memoryLeakGrowth` | `number` | `0.2` | See [Performance thresholds](#performance-thresholds). |
| `memoryLeakMinGrowthMb` | `number` | `10` | See [Performance thresholds](#performance-thresholds). |
| `memoryLeakReadings` | `number` | `4` | See [Performance thresholds](#performance-thresholds). |

An invalid `apiKey` or `endpoint` leaves the SDK disabled. It never throws.

### Performance thresholds

*Added in 0.3.0.* By default the SDK decides what counts as "slow" for you. If your app has different expectations, for example a reporting API that normally takes 2.5 s, pass your own limits to `init()`:

```ts
ErrorTracker.init({
  apiKey: 'et_your_project_key',
  endpoint: 'https://monitoringsystem-backend.vercel.app/api/v1/events',
  slowApiCallMs: 3000,  // report API calls slower than 3 s (default 2 s)
  slowPageLoadMs: 5000, // report page loads slower than 5 s (default 3 s)
});
```

Every option is optional. Leave one out to keep its default.

| Option | Default | Allowed range | Reported as | Meaning |
| --- | --- | --- | --- | --- |
| `slowApiCallMs` | `2000` | 100 – 600000 | `SlowApiCall`\* | A fetch/XHR call that takes longer than this many ms. |
| `slowPageLoadMs` | `3000` | 100 – 600000 | `SlowPageLoad`\* | A page load (navigation start → `load` event) longer than this many ms. |
| `mainThreadBlockedMs` | `1000` | 50 – 60000 | `MainThreadBlocked` | One main-thread task freezing the page longer than this many ms. Chromium only. |
| `lowFrameRateFps` | `20` | 1 – 60 | `LowFrameRate` | A sampled frame rate below this many frames per second. |
| `memoryPollIntervalMs` | `30000` | 5000 – 3600000 | — | How often the JS heap size is read. Chromium only. |
| `memoryLeakGrowth` | `0.2` | 0.01 – 10 | `MemoryLeakSuspected` | How much the heap floor must grow over the lowest floor seen, as a ratio (`0.2` = 20%). See [How memory leaks are detected](#how-memory-leaks-are-detected). |
| `memoryLeakMinGrowthMb` | `10` | 1 – 4096 | `MemoryLeakSuspected` | How much the heap floor must grow in MB, on top of the ratio, so small heaps can't trip it. *Added in 0.4.0.* |
| `memoryLeakReadings` | `4` | 2 – 20 | `MemoryLeakSuspected` | How many heap floors in a row must each be higher than the one before. Each floor covers 4 polls, so the default spans 8 minutes. |

A value outside the allowed range is moved to the nearest limit, so `slowApiCallMs: 10` behaves like `100`. A value that isn't a number (a string, `NaN`, `Infinity`) is ignored and the default is used. Neither case throws.

`MainThreadBlocked` and `LowFrameRate` are each reported at most once every 30 s, whatever thresholds you set. *Since 0.6.1* their `context` says how bad it was and whether the page was still loading, so startup freezes can be told apart from freezes during use:

```json
{ "duration_ms": 1570, "threshold_ms": 1000, "started_at_ms": 2101, "during_page_load": true }
{ "fps": 12, "threshold_fps": 20, "during_page_load": false }
```

`started_at_ms` is milliseconds since the page started loading; `during_page_load` is `true` when the freeze began before the window `load` event ended.

\* *Changed in 0.5.0:* slow calls and slow pages are reported as issues only with `captureSlowEvents: true`, and then at most once per endpoint every 5 minutes, with the duration in `context` so repeats group together. Without it, the two thresholds still mark `performance.slow_api_calls` and `slow_screen` in error payloads, and every request and page is timed in the [Performance view](#performance-monitoring). Calls and loads that overlapped a hidden tab are never judged slow.

### Which HTTP statuses are reported

*Added in 0.6.0.* Many 4xx responses are normal app behaviour, not bugs: `401` when a session expires, `403` for a missing permission, `409`/`422` for validation errors, `429` for rate limiting. Reporting them fills the dashboard with issues nobody will fix, so by default the SDK reports only:

- **500–599**: the server broke.
- **400, 404, 405, 413**: usually a bug in the client (malformed request, wrong URL, wrong method, payload too large).

Change the list with `httpErrorStatuses`, using single codes and inclusive `[min, max]` ranges:

```js
ErrorTracker.init({
  // ...
  httpErrorStatuses: [[400, 599]], // every 4xx and 5xx (the behaviour before 0.6.0)
  // httpErrorStatuses: [[500, 599]], // server errors only
  // httpErrorStatuses: [],          // none (same as captureHttpErrors: false)
});
```

Entries that aren't whole numbers between 100 and 599, or ranges with `min > max`, are ignored. Every request still appears in breadcrumbs and in the Performance view whatever its status.

### Missing pages (404)

*Added in 0.3.0.* When a visitor opens a page that doesn't exist, e.g. types `/abouts` instead of `/about` or follows an old link, the SDK sends a `PageNotFound` event:

```json
{
  "event_type": "error",
  "level": "warning",
  "error": { "type": "PageNotFound", "message": "Page not found: /abouts", "handled": true },
  "context": { "url": "https://app.example.com/abouts", "path": "/abouts", "status": 404, "referrer": "https://app.example.com/", "source": "http-status" }
}
```

`referrer` tells you which page holds the broken link. Query strings are removed from both URLs.

**Automatic:** if the server answers the page with **404 or 410**, the SDK reports it on its own. This needs no code, but the SDK must be loaded on your 404 page too. It works in Chromium 109+ (Chrome, Edge, Opera) and Firefox, while Safari doesn't expose a page's HTTP status.

**From your router:** single-page apps often show a "not found" screen without any HTTP request, and Safari can't be detected automatically. To cover both, call `capturePageNotFound()` from your not-found page:

```jsx
// Next.js (App Router): app/not-found.js
'use client';
import { useEffect } from 'react';
import ErrorTracker from '@sourav732/error-tracker-js';

export default function NotFound() {
  useEffect(() => { ErrorTracker.capturePageNotFound(); }, []);
  return <h1>Page not found</h1>;
}

// React Router: <Route path="*" element={<NotFound />} /> with the same useEffect
// Vue Router: { path: '/:pathMatch(.*)*', component: NotFound } and call it in onMounted()
```

`capturePageNotFound(url?)` uses the current page URL when called without an argument. On a page the SDK already reported automatically, the second report is dropped, so you get exactly one event. Turn off automatic detection with `detectPageNotFound: false`. Manual calls still work.

### Performance monitoring

*Added in 0.5.0.* Every page view is recorded and sent as one `transaction` event. The dashboard's **Performance** page turns them into Web Vitals at the 75th percentile (rated good / needs improvement / poor, as Google does), p50/p75/p95 latency per endpoint, timings per route, and the slowest recent calls and page loads. Nothing is reported as an issue: performance is judged from percentiles, not from single slow requests.

A page view holds:

- **The route** (`location.pathname`). The dashboard groups IDs in paths, so `/orders/42` and `/orders/97` are both `/orders/{id}`.
- **Web Vitals** for the first view after a page load: TTFB, FCP, LCP, CLS and load time, plus **INP** (how fast the page responds to clicks and key presses) for every view.
- **Every fetch/XHR request** as a span: method, URL, status, start and duration. From the browser's Resource Timing it also gets **server time** (request sent → first response byte), **download time** and **size**. That splits "the server was slow" from "the network was slow". For APIs on another origin the browser shares these only if the API sends a `Timing-Allow-Origin` header naming your site; otherwise they are `null`.
- **Long tasks:** how many, and the total blocking time.

A view ends when the app changes route (`pushState`, `replaceState`, `popstate`), when the tab is hidden or closed, or after 30 minutes (it then continues as a new view). Time in a hidden tab is never part of a view, and requests that overlapped a hidden period are flagged `background` and kept out of percentiles: browsers hold background tabs back, so those timings say nothing about your app.

Sampling is decided once per page load with `performanceSampleRate` (default `1.0`, every page view), so a visitor's views are either all recorded or none are. It is separate from `sampleRate`, which applies to errors. Lower it for high-traffic apps:

```ts
ErrorTracker.init({ apiKey, endpoint, performanceSampleRate: 0.2 }); // record 1 page load in 5
```

Page views have their own budget (30 per minute in the SDK, separate limits on the server), so they never crowd out errors. They include `device`, `user` and `app_version` but no breadcrumbs or screenshots.

Other public methods: `flush(): Promise<void>` sends everything now (and never rejects). `close(): Promise<void>` flushes, removes every hook and persists anything unsent. `isInitialized(): boolean`.

## What is collected

| Collector | Captures |
| --- | --- |
| **Errors** | `error` events (capture phase) and `unhandledrejection`. Stack traces are parsed from V8, Firefox and Safari formats into `{ filename, lineno, colno, function }` (max 50 frames, no source maps applied). Errors from other-origin scripts loaded without CORS are labelled `CrossOriginScriptError` (see below). |
| **Network** | `HttpError` for fetch/XHR responses with an error status (all 5xx plus 400, 404, 405 and 413 by default, e.g. `GET https://app.example.com/api/cart → 500`; see [Which HTTP statuses are reported](#which-http-statuses-are-reported)). `NetworkError` for requests that got no response: offline, timeout, connection refused, DNS/SSL failure, CORS (`context.failure` says which, as far as the browser reveals). Requests the app aborts itself are not reported. `InvalidJsonResponse` when `response.json()` fails, even if the app catches it. The stack trace of all three points at the app code that made the request. |
| **Missing pages** | `PageNotFound` (level `warning`) when the page itself was served with 404/410 (Chromium 109+, Firefox), or when the app calls `capturePageNotFound()`. See [Missing pages](#missing-pages-404). |
| **Resources** | `ResourceError` for failed `<img>`/`<script>`/`<link>` loads, web fonts (`document.fonts`), and CSS background images / `@import`s with a 4xx/5xx status. Failures that happened while the HTML was still loading, before the SDK started, are picked up from Resource Timing. Failed `<link rel="preload">` hints are skipped, since the element using the file reports it. CSS-image and pre-start checks are Chromium 109+ only, and same-origin (or `Timing-Allow-Origin`) only. |
| **Security & workers** | `CspViolation` for Content-Security-Policy violations, both enforced and report-only. In Chromium a buffered `ReportingObserver` also catches violations from before the SDK started. Violations caused by the SDK's own screenshot library are ignored. `WorkerError` for uncaught errors inside dedicated Web Workers, and workers that fail to start. |
| **Console** | Opt-in (`captureConsoleErrors: true`): each `console.error(...)` becomes a `ConsoleError` event, or the passed Error's own type. Errors the SDK has already reported are skipped. |
| **Breadcrumbs** | Clicks (tag, visible text, CSS path; form values are never read), `pushState`/`replaceState`/`popstate` navigation, page visibility changes, `console.warn`/`console.error`, and every `fetch`/XHR call (URL, method, status or failure, duration). |
| **Performance** | One `transaction` event per page view with Web Vitals, INP and every request's timing (see [Performance monitoring](#performance-monitoring)). Error payloads also carry page load, TTFB (Navigation Timing L2, with an L1 fallback), FCP, LCP and CLS, plus the last 20 API calls. Browsers hold back background tabs, so when the page was hidden before its first paint, FCP and LCP are `null`, and a load or request that overlapped a hidden period is not judged slow. |
| **Responsiveness** | `MainThreadBlocked` when one task freezes the page for more than 1 s (Long Tasks API, Chromium only; at most one report per 30 s). The frame rate is sampled for 1 s, 5 s after start and then every 30 s while the page is visible. It fills `performance.frame_rate_fps`, and a sample under 20 fps is reported as `LowFrameRate`. Adjustable with `mainThreadBlockedMs` / `lowFrameRateFps`. |
| **Memory** | `performance.memory` (Chromium only), polled every 30 s. Sets `leak_suspected` and sends a `MemoryLeakSuspected` event when the memory kept after garbage collection grows steadily. See [How memory leaks are detected](#how-memory-leaks-are-detected). |
| **Screenshots** | **Opt-in** (`captureScreenshots: true`), and only for unhandled errors: uncaught exceptions and rejections, failed resources, CSP violations and worker errors. Handled errors (`captureError`, HTTP errors, network failures, `console.error`, performance issues) never get one. The visible viewport as a compressed JPEG: at most 1280 px wide, quality 0.5, typically around 50 KB, capped at ~370 KB. Only taken when the page is visible, at most one every 10 s, with a 3 s time budget. |

Query strings and fragments are stripped from every recorded URL, because they often carry tokens.

**One failure, one event.** Error objects the SDK has reported are remembered. For example, a failed `fetch` reported as `NetworkError` is not reported again when the app leaves the rejected promise uncaught, or when a framework logs it with `console.error`.

### How memory leaks are detected

*Changed in 0.4.0.* Memory going up is not a leak by itself: apps load screens and caches, and garbage piles up until the browser collects it. The SDK reports `MemoryLeakSuspected` only when the memory the page **keeps after garbage collection** grows steadily:

1. **Warm-up.** Readings from the first minute after `init()` are ignored, since apps load most of their screens at startup.
2. **Floors.** Readings are grouped into windows of 4 polls (2 minutes by default). Only each window's lowest reading, its *floor*, is used, so garbage the browser clears later doesn't count.
3. **Trend.** The last `memoryLeakReadings` floors (4) must each be higher than the one before **by at least 0.5 MB** (or half the average step that `memoryLeakMinGrowthMb` spread over `memoryLeakReadings` implies, if that is smaller), and **no single step may be more than 70%** of their total rise. A screen that loads once raises one floor in one big step, and the floors around it stay level or only creep by a few KB. *(Changed in 0.6.1: before, tiny creep counted as "rising", so creep plus one big step was reported as a leak.)*
4. **Size.** The newest floor must be above the lowest floor seen by `memoryLeakGrowth` (20%) **and** by `memoryLeakMinGrowthMb` (10 MB).

With the defaults, the earliest possible report comes about 10 minutes after the page opens. Navigation doesn't reset anything, because a screen that isn't cleaned up when the user leaves it is the most common single-page-app leak. One event is sent per page load, and its `context` holds the measurements:

```json
{ "baseline_mb": 50, "current_mb": 65, "growth_mb": 15, "growth_percent": 30, "observed_minutes": 8, "floors_mb": [50, 55, 60, 65], "heap_total_mb": 512 }
```

### Start the SDK as early as possible

Errors that happen before `init()` runs are not captured, apart from the resource and CSP failures recovered from browser buffers (see above). In particular, calling `init()` inside a React `useEffect` misses errors during the first render and hydration. In Next.js 15.3+, put `init()` in `instrumentation-client.js`, which runs before React starts. Otherwise, import and initialise the SDK at the very top of your entry file.

### Cross-origin scripts ("Script error.")

Browsers hide the message and stack of errors thrown by scripts from another origin, such as a CDN or third-party widget. All that arrives is `Script error.`, which the SDK reports as `CrossOriginScriptError`, with a hint in `context`. To get the real error, load the script with `crossorigin="anonymous"` and serve it with an `Access-Control-Allow-Origin` header.

### Not covered

- Errors the app catches and swallows (`catch {}` without `captureError`).
- Service Worker internals, and iframes from other origins.
- Memory data in Firefox and Safari: they expose no API, so the memory fields are `null` there.
- Tab crashes and out-of-memory kills: the page dies without any signal, so `oom_kill` is always `null`.
- A page stuck in an infinite loop: the task never ends, so it can't be reported from inside the page.
- Layout bugs that never throw.

### Screenshots and Content Security Policy

**Cost:** html2canvas copies and draws the page on the main thread, so the page freezes while a screenshot renders. Measured on a page with about 1,500 elements: **~0.4 s on a desktop and ~3–4 s on a mid-range phone** (Chrome at 4× CPU slowdown). That is why screenshots are off by default (0.6.2) and limited to unhandled errors and one every 10 s. Enable them where the picture is worth the freeze, e.g. internal tools or desktop apps.

html2canvas is **not bundled**. It is loaded on demand the first time a screenshot is needed, with Subresource Integrity checking. If your site uses a CSP, allow the script origin (`script-src https://cdnjs.cloudflare.com`). Alternatively, self-host the file and set `html2canvasUrl` (and `html2canvasIntegrity`). If the library can't load, error events are sent without a screenshot. html2canvas also draws `data:` images, so a policy that restricts `img-src` needs `data:` for screenshots to render. The SDK does not report the violations its own library causes.

Masking works in two layers. Masked elements are painted black in html2canvas's cloned DOM (form values are blanked and their children hidden). Then, after rendering, black rectangles are drawn over their on-screen bounds. If the canvas can't be drawn on, the screenshot is discarded rather than sent unmasked.

## Delivery

- Events are batched (up to 10 per request, and at most ~1 MB per request so serverless hosts such as Vercel accept it) and sent 2 s after the first event, or immediately once 10 are waiting.
- The request is `POST <endpoint>`, with headers `Content-Type: application/json` and `X-API-Key: <apiKey>`, and the body `{ "events": [ ... ] }`.
- **Retries:** network errors, 5xx, 408 and 429 are retried 3 times, after 1 s, 2 s and 4 s. Other 4xx responses (bad payload, invalid key) are dropped without retrying, since resending can't succeed.
- **Offline:** when `navigator.onLine === false`, or once retries are exhausted, events are stored in `localStorage["_et_queue"]` (newest 50, with the API key removed). The stored queue is flushed on the `online` event, when the tab becomes visible again, and on the next `init()`. If storage is full, screenshots are dropped first, then the oldest events.
- **Leaving the page:** when the tab is hidden or the page unloads, queued events are sent with `fetch(…, { keepalive: true })`, which the browser finishes after the page is gone. Only batches up to ~60 KB use it (browsers cap keepalive bodies); larger ones, and browsers that refuse keepalive, fall back to `localStorage` and the next visit. *Added in 0.5.0.*
- **Error storms:** identical events (same type, message and top frame) are deduplicated within 5 s. After that, at most 100 events per rolling minute are accepted. When the limit drops events, one `EventsDropped` summary (`context.dropped_count`) is sent 10 s later, so a storm is never silent.

## Payload

Every event follows the shared cross-platform schema. Every field is always present, and values the browser can't provide are `null`:

```json
{
  "sdk": { "name": "error-tracker-js", "version": "1.0.0" },
  "api_key": "et_your_project_key",
  "event_type": "error",
  "level": "error",
  "timestamp": "2026-10-17T10:42:15.000Z",
  "environment": "production",
  "app_version": "2.1.4",
  "user": { "id": "usr_8821", "email": null, "name": null },
  "error": { "message": "Cannot read properties of undefined (reading 'price')", "type": "TypeError", "handled": false },
  "stacktrace": [{ "filename": "https://app.example.com/static/cart.js", "lineno": 142, "colno": 12, "function": "handlePayment" }],
  "breadcrumbs": [{ "timestamp": "2026-10-17T10:42:14.100Z", "type": "click", "message": "Clicked Pay Now", "data": { "tag": "button", "text": "Pay Now", "selector": "form#checkout > button.primary" } }],
  "screenshot": "data:image/jpeg;base64,...",
  "performance": {
    "page_load_ms": 4200, "ttfb_ms": 320, "fcp_ms": 1800, "lcp_ms": 2400, "cls": 0.02,
    "startup_ms": null, "frame_rate_fps": null, "slow_screen": true,
    "api_calls": [{ "url": "https://app.example.com/api/cart", "method": "POST", "status": 200, "duration_ms": 230 }],
    "slow_api_calls": []
  },
  "memory": { "used_mb": 142.3, "total_mb": 256, "leak_suspected": false, "oom_kill": null },
  "device": {
    "platform": "js", "os": "Windows 11", "os_version": "15.0.0", "manufacturer": null, "model": null,
    "browser": "Chrome", "browser_version": "124.0", "screen_width": 1920, "screen_height": 1080,
    "url": "https://app.example.com/checkout", "referrer": null, "locale": "en-IN"
  },
  "context": null,
  "transaction": null
}
```

A page view (`event_type: "transaction"`, level `info`) has `error: null`, empty `stacktrace` and `breadcrumbs`, an empty `performance` block, and its data in `transaction`:

```json
"transaction": {
  "name": "/orders/42", "kind": "pageload", "start": "2026-10-23T10:00:00.000Z", "duration_ms": 5000, "background": false,
  "vitals": { "ttfb_ms": 120, "fcp_ms": 800, "lcp_ms": 1400, "cls": 0.05, "inp_ms": 96, "page_load_ms": 1900 },
  "long_tasks": { "count": 2, "blocking_ms": 80 },
  "spans": [{ "op": "http", "method": "GET", "url": "https://app.example.com/api/orders/42", "status": 200, "failure": null,
              "start_ms": 100, "duration_ms": 600, "server_ms": 500, "download_ms": 80, "size_bytes": 2048, "background": false }],
  "dropped_spans": 0
}
```

`kind` is `pageload` (first view after a page load), `navigation` (route change) or `continued` (the same page after the tab came back, or a view split after 30 minutes). At most 100 spans are kept per view; the rest are counted in `dropped_spans`.

**JS-specific fields** that are not part of the shared schema: `level` (severity of `captureMessage`), `context` (the second argument to `captureError`), `performance.cls`, and `device.referrer`. `transaction` is part of the shared schema from 0.5.0.

**Event types:**
- `error` covers uncaught and captured errors, plus `HttpError`, `NetworkError`, `InvalidJsonResponse`, `ResourceError`, `CspViolation`, `WorkerError`, `ConsoleError`, `CrossOriginScriptError` and `PageNotFound` in `error.type`.
- `message` comes from `captureMessage`, and also carries the `EventsDropped` summary.
- `performance` carries `MemoryLeakSuspected`, `MainThreadBlocked` and `LowFrameRate` in `error.type`, and `SlowPageLoad` / `SlowApiCall` with `captureSlowEvents`.
- `transaction` is one page view (see [Performance monitoring](#performance-monitoring)). It never becomes an issue.
- `crash` is unused on the web.

**`handled`:** `false` when something broke without app code getting a chance to react (uncaught exceptions and rejections, failed resources, CSP blocks, worker errors). `true` when the problem was handed back to the app: an HTTP error status, a rejected request, a JSON parse error thrown to the caller, `console.error`, performance issues, and `captureError`. Most events built by the SDK put extra detail in `context`.

## Development

```bash
npm install
npm run typecheck   # strict TypeScript over src + tests
npm test            # Vitest (jsdom)
npm run build       # dist/index.mjs, dist/index.cjs, dist/types
```

All thresholds, timeouts and limits live in [`src/constants.ts`](src/constants.ts).

### Releasing

```bash
npm version patch     # or minor / major; bumps package.json and creates a git tag
# then set SDK_VERSION in src/constants.ts to the same version (a test fails if they differ)
npm publish           # runs typecheck, tests and build first (prepublishOnly), then uploads
git push --follow-tags
```

The package is public (`publishConfig.access`). Check what will be uploaded with `npm publish --dry-run`.
