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
| `captureScreenshots` | `boolean` | `true` | Attach a viewport screenshot to error events. |
| `html2canvasUrl` | `string` | cdnjs html2canvas 1.4.1 | Where the screenshot library is loaded from. |
| `html2canvasIntegrity` | `string` | SRI hash of the default URL | SRI hash for `html2canvasUrl`. Defaults to `''` (no check) when you set a custom URL. |
| `beforeSend` | `(event) => event \| null` | — | Scrub or drop events before they are queued. If the hook throws, the original event is sent. |

An invalid `apiKey` or `endpoint` leaves the SDK disabled. It never throws.

Other public methods: `flush(): Promise<void>` sends everything now (and never rejects). `close(): Promise<void>` flushes, removes every hook and persists anything unsent. `isInitialized(): boolean`.

## What is collected

| Collector | Captures |
| --- | --- |
| **Errors** | `error` events (capture phase) and `unhandledrejection`. Stack traces are parsed from V8, Firefox and Safari formats into `{ filename, lineno, colno, function }` (max 50 frames, no source maps applied). Failed `<img>`/`<script>`/`<link>` loads are reported as `ResourceError`. fetch/XHR responses with a 4xx/5xx status are reported as `HttpError` (e.g. `GET https://app.example.com/api/cart → 500`). |
| **Breadcrumbs** | Clicks (tag, visible text, CSS path; form values are never read), `pushState`/`replaceState`/`popstate` navigation, page visibility changes, `console.warn`/`console.error`, and every `fetch`/XHR call (URL, method, status, duration). |
| **Performance** | Page load, TTFB (Navigation Timing L2, with an L1 fallback), FCP, LCP and CLS (via `PerformanceObserver`), plus the last 20 API calls. A page load over 3000 ms or an API call over 2000 ms is flagged and also sent as its own `performance` event. |
| **Memory** | `performance.memory` (Chromium only), polled every 30 s. Sets `leak_suspected` and sends a `performance` event when the heap grows by more than 20% across 3 consecutive rising readings with no navigation in between. |
| **Screenshots** | The visible viewport as a JPEG (quality 0.6), only when the page is visible. At most one every 10 s, with a 3 s time budget and a ~750 KB size cap. |

Query strings and fragments are stripped from every recorded URL, because they often carry tokens.

### Screenshots and Content Security Policy

html2canvas is **not bundled**. It is loaded on demand the first time a screenshot is needed, with Subresource Integrity checking. If your site uses a CSP, allow the script origin (`script-src https://cdnjs.cloudflare.com`). Alternatively, self-host the file and set `html2canvasUrl` (and `html2canvasIntegrity`). If the library can't load, error events are sent without a screenshot.

Masking works in two layers. Masked elements are painted black in html2canvas's cloned DOM (form values are blanked and their children hidden). Then, after rendering, black rectangles are drawn over their on-screen bounds. If the canvas can't be drawn on, the screenshot is discarded rather than sent unmasked.

## Delivery

- Events are batched (up to 10 per request) and sent 2 s after the first event, or immediately once 10 are waiting.
- The request is `POST <endpoint>`, with headers `Content-Type: application/json` and `X-API-Key: <apiKey>`, and the body `{ "events": [ ... ] }`.
- **Retries:** network errors, 5xx, 408 and 429 are retried 3 times, after 1 s, 2 s and 4 s. Other 4xx responses (bad payload, invalid key) are dropped without retrying, since resending can't succeed.
- **Offline:** when `navigator.onLine === false`, or once retries are exhausted, events are stored in `localStorage["_et_queue"]` (newest 50, with the API key removed). The stored queue is flushed on the `online` event, when the tab becomes visible again, and on the next `init()`. If storage is full, screenshots are dropped first, then the oldest events.
- **Error storms:** identical events (same type, message and top frame) are deduplicated within 5 s. After that, at most 100 events per rolling minute are accepted.

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

**Event types:** `error` covers uncaught and captured errors. `message` comes from `captureMessage`. `performance` is used for `SlowPageLoad`, `SlowApiCall` and `MemoryLeakSuspected`, with the issue name in `error.type`. `crash` is unused on the web.

## Development

```bash
npm install
npm run typecheck   # strict TypeScript over src + tests
npm test            # Vitest (jsdom)
npm run build       # dist/index.mjs, dist/index.cjs, dist/types
```

All thresholds, timeouts and limits live in [`src/constants.ts`](src/constants.ts).
