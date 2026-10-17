# Error Tracker — JavaScript SDK

Client-side error, performance and memory monitoring for browser apps (vanilla JS, React, Vue, …).
The SDK captures problems in the page and POSTs structured JSON events to your ingestion endpoint.

- **Zero runtime dependencies.** ES5 output, ESM and CommonJS builds, TypeScript types included.
- **Never breaks the host app.** Every hook is guarded. SDK failures are swallowed and logged only when `debug: true`.
- **Silent by default.** Nothing is written to the console unless `debug: true`.
- **Supported environments:** Chrome 60+, Safari 12+, Firefox 60+, and Node.js 14+ (manual capture only; Node needs a global `fetch`, i.e. 18+, to deliver events).

## Installation

```bash
npm install @company/error-tracker-js
```

## Quick start

Initialise as early as possible, before the rest of your app code runs:

```ts
import ErrorTracker from '@company/error-tracker-js';

ErrorTracker.init({
  apiKey: 'pk_live_xxx',
  endpoint: 'https://api.yourcompany.com/v1/events',
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

### React

```tsx
import ErrorTracker from '@company/error-tracker-js';

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
  ErrorTracker.init({ apiKey: 'pk_live_xxx', endpoint: 'https://api.yourcompany.com/v1/events' });
</script>
```

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | required | Sent in the `X-API-Key` header. Kept in memory only, never written to storage. |
| `endpoint` | `string` | required | Ingestion URL. Batches are POSTed here. |
| `environment` | `string` | `'production'` | Free-form, e.g. `staging`. |
| `appVersion` | `string` | `null` | Your app's version. |
| `sampleRate` | `number` | `1.0` | 0–1. Each event is dropped when `Math.random() > sampleRate`. |
| `maxBreadcrumbs` | `number` | `30` | Size of the breadcrumb ring buffer (max 100). |
| `maskSelectors` | `string[]` | `[]` | Elements to black out in screenshots and hide in click breadcrumbs. `input[type="password"]` is always masked. |
| `debug` | `boolean` | `false` | Log SDK diagnostics to the console. |
| `captureHttpErrors` | `boolean` | `true` | Report every fetch/XHR response with a 4xx or 5xx status as an `HttpError` event. |
| `captureNetworkErrors` | `boolean` | `true` | Report fetch/XHR requests that got no response (offline, timeout, refused, DNS/SSL, CORS) as `NetworkError`. Requests the app aborts are never reported. |
| `captureConsoleErrors` | `boolean` | `false` | Report each `console.error(...)` call as an event. Off by default because libraries log a lot of noise there. |
| `captureScreenshots` | `boolean` | `true` | Attach a viewport screenshot to error events. |
| `html2canvasUrl` | `string` | cdnjs html2canvas 1.4.1 | Where the screenshot library is loaded from. |
| `html2canvasIntegrity` | `string` | SRI hash of the default URL | SRI hash for `html2canvasUrl`. Defaults to `''` (no check) when you set a custom URL. |
| `beforeSend` | `(event) => event \| null` | — | Scrub or drop events before they are queued. If the hook throws, the original event is sent. |

An invalid `apiKey` or `endpoint` leaves the SDK disabled. It never throws.

Other public methods: `flush(): Promise<void>` sends everything now (and never rejects). `close(): Promise<void>` flushes, removes every hook and persists anything unsent. `isInitialized(): boolean`.

## What is collected

| Collector | Captures |
| --- | --- |
| **Errors** | `error` events (capture phase) and `unhandledrejection`. Stack traces are parsed from V8, Firefox and Safari formats into `{ filename, lineno, colno, function }` (max 50 frames, no source maps applied). Errors from other-origin scripts loaded without CORS are labelled `CrossOriginScriptError` (see below). |
| **Network** | `HttpError` for fetch/XHR responses with a 4xx/5xx status (e.g. `GET https://app.example.com/api/cart → 500`). `NetworkError` for requests that got no response: offline, timeout, connection refused, DNS/SSL failure, CORS (`context.failure` says which, as far as the browser reveals). Requests the app aborts itself are not reported. `InvalidJsonResponse` when `response.json()` fails, even if the app catches it. The stack trace of all three points at the app code that made the request. |
| **Resources** | `ResourceError` for failed `<img>`/`<script>`/`<link>` loads, web fonts (`document.fonts`), and CSS background images / `@import`s with a 4xx/5xx status. Failures that happened while the HTML was still loading, before the SDK started, are picked up from Resource Timing. Failed `<link rel="preload">` hints are skipped, since the element using the file reports it. CSS-image and pre-start checks are Chromium 109+ only, and same-origin (or `Timing-Allow-Origin`) only. |
| **Security & workers** | `CspViolation` for Content-Security-Policy violations, both enforced and report-only. In Chromium a buffered `ReportingObserver` also catches violations from before the SDK started. Violations caused by the SDK's own screenshot library are ignored. `WorkerError` for uncaught errors inside dedicated Web Workers, and workers that fail to start. |
| **Console** | Opt-in (`captureConsoleErrors: true`): each `console.error(...)` becomes a `ConsoleError` event, or the passed Error's own type. Errors the SDK has already reported are skipped. |
| **Breadcrumbs** | Clicks (tag, visible text, CSS path; form values are never read), `pushState`/`replaceState`/`popstate` navigation, page visibility changes, `console.warn`/`console.error`, and every `fetch`/XHR call (URL, method, status or failure, duration). |
| **Performance** | Page load, TTFB (Navigation Timing L2, with an L1 fallback), FCP, LCP and CLS (via `PerformanceObserver`), plus the last 20 API calls. A page load over 3000 ms or an API call over 2000 ms is flagged and also sent as its own `performance` event. |
| **Responsiveness** | `MainThreadBlocked` when one task freezes the page for more than 1 s (Long Tasks API, Chromium only; at most one report per 30 s). The frame rate is sampled for 1 s, 5 s after start and then every 30 s while the page is visible. It fills `performance.frame_rate_fps`, and a sample under 20 fps is reported as `LowFrameRate`. |
| **Memory** | `performance.memory` (Chromium only), polled every 30 s. Sets `leak_suspected` and sends a `performance` event when the heap grows by more than 20% across 3 consecutive rising readings with no navigation in between. |
| **Screenshots** | The visible viewport as a JPEG (quality 0.6), only when the page is visible. At most one every 10 s, with a 3 s time budget and a ~750 KB size cap. |

Query strings and fragments are stripped from every recorded URL, because they often carry tokens.

**One failure, one event.** Error objects the SDK has reported are remembered. For example, a failed `fetch` reported as `NetworkError` is not reported again when the app leaves the rejected promise uncaught, or when a framework logs it with `console.error`.

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

html2canvas is **not bundled**. It is loaded on demand the first time a screenshot is needed, with Subresource Integrity checking. If your site uses a CSP, allow the script origin (`script-src https://cdnjs.cloudflare.com`). Alternatively, self-host the file and set `html2canvasUrl` (and `html2canvasIntegrity`). If the library can't load, error events are sent without a screenshot. html2canvas also draws `data:` images, so a policy that restricts `img-src` needs `data:` for screenshots to render. The SDK does not report the violations its own library causes.

Masking works in two layers. Masked elements are painted black in html2canvas's cloned DOM (form values are blanked and their children hidden). Then, after rendering, black rectangles are drawn over their on-screen bounds. If the canvas can't be drawn on, the screenshot is discarded rather than sent unmasked.

## Delivery

- Events are batched (up to 10 per request) and sent 2 s after the first event, or immediately once 10 are waiting.
- The request is `POST <endpoint>`, with headers `Content-Type: application/json` and `X-API-Key: <apiKey>`, and the body `{ "events": [ ... ] }`.
- **Retries:** network errors, 5xx, 408 and 429 are retried 3 times, after 1 s, 2 s and 4 s. Other 4xx responses (bad payload, invalid key) are dropped without retrying, since resending can't succeed.
- **Offline:** when `navigator.onLine === false`, or once retries are exhausted, events are stored in `localStorage["_et_queue"]` (newest 50, with the API key removed). The stored queue is flushed on the `online` event, when the tab becomes visible again, and on the next `init()`. If storage is full, screenshots are dropped first, then the oldest events.
- **Error storms:** identical events (same type, message and top frame) are deduplicated within 5 s. After that, at most 100 events per rolling minute are accepted. When the limit drops events, one `EventsDropped` summary (`context.dropped_count`) is sent 10 s later, so a storm is never silent.

## Payload

Every event follows the shared cross-platform schema. Every field is always present, and values the browser can't provide are `null`:

```json
{
  "sdk": { "name": "error-tracker-js", "version": "1.0.0" },
  "api_key": "pk_live_xxx",
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
  "context": null
}
```

**JS-specific fields** that are not part of the shared schema: `level` (severity of `captureMessage`), `context` (the second argument to `captureError`), `performance.cls`, and `device.referrer`.

**Event types:**
- `error` covers uncaught and captured errors, plus `HttpError`, `NetworkError`, `InvalidJsonResponse`, `ResourceError`, `CspViolation`, `WorkerError`, `ConsoleError` and `CrossOriginScriptError` in `error.type`.
- `message` comes from `captureMessage`, and also carries the `EventsDropped` summary.
- `performance` carries `SlowPageLoad`, `SlowApiCall`, `MemoryLeakSuspected`, `MainThreadBlocked` and `LowFrameRate` in `error.type`.
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
