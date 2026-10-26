# Protocol and Technical Approach

This document covers the SDK ↔ backend wire protocol and the technical rules that every SDK (JS, iOS, Android) and the backend follow.
For the component diagrams, see [ARCHITECTURE.md](ARCHITECTURE.md). For the original requirements, see [SPEC.md](SPEC.md).

All numbers below come from `error-tracking-sdk/js/src/constants.ts` (SDK) and `project/backend/lib/constants.js` (backend). If this document and those files disagree, the constants files are correct.

---

## 1. Ingestion protocol

### Request

```http
POST /api/v1/events HTTP/1.1
Host: monitoringsystem-backend.vercel.app
Content-Type: application/json
X-API-Key: et_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

{ "events": [ { ...event }, { ...event } ] }
```

| Rule | Value |
| --- | --- |
| Transport | HTTPS, JSON, UTF-8 |
| Authentication | `X-API-Key` header (project key, prefix `et_`). The server stores only the SHA-256 hash of each key. |
| Body | `{ "events": [ ... ] }` with 1–50 events per request. The SDK sends batches of up to 10 events and at most ~1 MB. |
| Max body size | 4 MB (Vercel's hard cap is 4.5 MB) |
| CORS | `Access-Control-Allow-Origin: *`, methods `POST, OPTIONS`, headers `Content-Type, X-API-Key`, preflight cached 24 h. The API key, not the origin, identifies the project. Refusals keep these headers so the browser lets the SDK read the status. |
| Allowed origins | Optional per-project list (set in the dashboard). See [Allowed origins and per-IP limit](#allowed-origins-and-per-ip-limit). |

### Responses

| Status | Body / meaning | What the SDK does |
| --- | --- | --- |
| `202` | `{ "accepted": n, "rejected": [{ "index": i, "reason": "..." }] }`. Valid events are stored even when others in the same batch are rejected. | Done |
| `400` | `invalid_body`: not `{ events: [...] }`, or bad JSON | Drop |
| `401` | `missing_api_key` / `invalid_api_key` | Drop |
| `403` | `project_disabled`: the owning account is disabled. `origin_not_allowed`: the browser's `Origin` is not in the project's allowed origins. | Drop |
| `413` | Body too large, or more than 50 events | Drop |
| `429` | `rate_limited_ip`, with a `Retry-After` header: over 150 events per minute from one IP to this project. There is no per-project limit on errors. | Retry |
| `408`, `5xx`, network error | — | Retry |

Error bodies have the shape `{ "error": { "code": "<code>", "message": "<human text>" } }`.

### Retry policy (the same on all SDKs)

```
attempt 1 ── fail ──► wait 1 s ──► attempt 2 ── fail ──► wait 2 s ──► attempt 3 ── fail ──► wait 4 s ──► attempt 4
                                                                                                          │
                                                                              still failing ──► persist offline ( localStorage )
```

- **Retried:** network errors, `5xx`, `408`, `429`.
- **Not retried:** any other `4xx`. The request will never succeed, so the events are dropped.
- Request timeout: 30 s.

---

## 2. Event schema (shared by all SDKs)

**Every field is always present.** A value the platform can't provide is sent as `null` (or `[]` for lists), and fields are never omitted.

```jsonc
{
  "sdk": { "name": "error-tracker-js", "version": "0.6.1" },  // -ios / -android
  "api_key": "et_...",          // also in the header; the server ignores this field and never stores it
  "event_type": "error",        // error | message | performance | crash | transaction
  "level": "error",             // info | warning | error            (JS extension*)
  "timestamp": "2026-10-17T10:42:15.000Z",
  "environment": "production",
  "app_version": "2.1.4",
  "user": { "id": "usr_8821", "email": null, "name": null },
  "error": { "message": "Cannot read property 'price' of undefined", "type": "TypeError", "handled": false },
  "stacktrace": [ { "filename": "cart.js", "lineno": 142, "colno": 12, "function": "handlePayment" } ],
  "breadcrumbs": [ { "timestamp": "ISO8601", "type": "click", "message": "button#pay", "data": {} } ],
  "screenshot": "data:image/jpeg;base64,...",   // or null
  "context": { },               // per-error-type detail, or null   (JS extension*)
  "performance": {
    "page_load_ms": 4200, "ttfb_ms": 320, "fcp_ms": 1800, "lcp_ms": 2400,
    "cls": 0.05,                // (JS extension*)
    "startup_ms": null, "frame_rate_fps": 58, "slow_screen": false,
    "api_calls": [ { "url": "/api/cart", "method": "POST", "status": 200, "duration_ms": 230 } ],
    "slow_api_calls": []
  },
  "memory": { "used_mb": 142, "total_mb": 256, "leak_suspected": false, "oom_kill": null },
  "device": {
    "platform": "js", "os": "Windows", "os_version": "11", "manufacturer": null, "model": null,
    "browser": "Chrome", "browser_version": "124.0", "screen_width": 1920, "screen_height": 1080,
    "url": "https://app.example.com/checkout",
    "referrer": null,           // (JS extension*)
    "locale": "en-IN"
  },
  "transaction": null           // filled only on event_type "transaction"
}
```

\* `level`, `context`, `performance.cls` and `device.referrer` go beyond the original spec and still need backend sign-off. The iOS and Android SDKs should send `level` and `context` too.

### Event types

| `event_type` | `error.type` values | `handled` |
| --- | --- | --- |
| `error` | Native types (`TypeError`, …), plus SDK-built types: `HttpError`, `NetworkError`, `InvalidJsonResponse`, `ResourceError`, `CspViolation`, `WorkerError`, `ConsoleError`, `CrossOriginScriptError`, `PageNotFound` | See the rule below |
| `performance` | `SlowPageLoad`, `SlowApiCall`, `MemoryLeakSuspected`, `MainThreadBlocked`, `LowFrameRate` | always `true` |
| `message` | From `captureMessage`, or `EventsDropped` (with `context.dropped_count`) | `true` |
| `crash` | Native crashes (mobile) | `false` |
| `transaction` | One page view (see below). `error: null`. | — |

**`handled` rule:**
- `false`: the error broke something before app code had a chance to deal with it (uncaught exceptions and rejections, failed resources, CSP violations, workers).
- `true`: the error was handed back to the app (HTTP error status, rejected request, JSON parse error, `console.error`, performance issues, `captureError`).

### Transaction (page view) events

Each page view sends one `transaction` event (a web route, iOS view controller or Android Activity/Fragment). On these events `error` is `null`, `stacktrace` and `breadcrumbs` are `[]`, and `screenshot` is `null`.

```jsonc
"transaction": {
  "name": "/orders/42",
  "kind": "pageload",              // pageload | navigation | continued
  "start": "ISO8601",
  "duration_ms": 5000,
  "background": false,
  "vitals": { "ttfb_ms": 300, "fcp_ms": 900, "lcp_ms": 1500, "cls": 0.02, "inp_ms": 120, "page_load_ms": 2100 },
  "long_tasks": { "count": 2, "blocking_ms": 140 },
  "spans": [ { "op": "http", "method": "GET", "url": "https://api.example.com/orders/42", "status": 200,
               "failure": null, "start_ms": 100, "duration_ms": 600, "server_ms": 500,
               "download_ms": 80, "size_bytes": 2048, "background": false } ],
  "dropped_spans": 0
}
```

- **When a view ends:** on a route change, when the tab or app goes to the background, on page unload, or after 30 minutes (the view then continues as `kind: "continued"`).
- **Span limits:** at most 100 spans per view; any further requests are only counted in `dropped_spans`.
- **Sampling:** `performanceSampleRate` (default 1.0) is decided once per page load and is separate from `sampleRate`.
- **Rate limits:** the SDK sends at most 30 transactions per minute; the server accepts 1000 page views per project per minute.

---

## 3. SDK technical approach

### Event pipeline

```
collector / capture* ─► sample ─► dedup ─► rate limit ─► build payload ─► screenshot ─► beforeSend ─► queue ─► transport
```

| Stage | Rule |
| --- | --- |
| Sample | `sampleRate` (0–1, default 1.0) |
| One failure, one event | Remembers reported error objects (WeakSet) and short-lived text signatures for 2 s, so the same failure arriving by a second route (rejection + `console.error`, worker error re-dispatched on `window`) is reported once |
| Dedup | Identical events (type + message + top frame) within 5 s are dropped (up to 200 fingerprints remembered) |
| Rate limit | 100 events per rolling minute. When events are dropped, one `EventsDropped` summary is sent 10 s later. |
| Build | Fills every schema field. Stacks are capped at 50 frames, strings at 1000 characters, messages at 2000. Objects are serialized to depth 5 with at most 50 keys. |
| Screenshot | **Opt-in** (`captureScreenshots: true`, off by default since JS 0.6.2) and only for unhandled errors (`handled: false`), because rendering freezes the page (~0.4 s desktop, ~3–4 s mid-range phone). At most one every 10 s, with a 3 s budget; on timeout the event is sent without it. |
| `beforeSend` | The app can scrub the event, or return `null` to drop it. Transactions use `beforeSendTransaction`. |
| Queue | Sends a batch at 10 events or after 2 s. The in-memory cap is 100 events (the oldest are dropped). |

### Delivery and persistence

- **Offline and failed delivery:** events are saved in `localStorage["_et_queue"]` (at most 50). If storage is full, screenshots are dropped first. The API key is blanked before saving and filled back in at send time.
- **Page unload:** `pagehide` → `fetch(..., { keepalive: true })` for up to 60 KB. If the browser refuses that, the events are persisted instead. Sends made while the tab is hidden also use keepalive, and fall back to a normal request if the browser refuses.
- **Persisted events are flushed** on the next page load.

### Never break the host app

- Every public method and collector callback runs inside a `safe` wrapper. Any SDK exception is swallowed, and logged only if `debug: true`.
- No console output unless `debug: true`.
- Calls made before `init()` are buffered (up to 100).
- Network and XHR are wrapped **once** (`networkInterceptor`), and every collector that needs request data shares that one wrap.
- Browser APIs are not wrapped in try/catch to work around cross-origin `"Script error."`. Those errors are labelled `CrossOriginScriptError` instead.

### Privacy and security

| Concern | Approach |
| --- | --- |
| API key | Kept in memory and sent in the request header. Never persisted (blanked in the offline store). The server stores only a SHA-256 hash. |
| URLs | Query string and fragment removed before recording (in breadcrumbs, `device.url` and spans) |
| Screenshots | Never taken while the page is hidden. Two-layer masking: style the cloned DOM, then paint black rectangles over masked elements. `input[type=password]` and `maskSelectors` are always masked. |
| Screenshot size | ≤ 1280 px wide, JPEG quality 0.5 (falling back to 0.3), at most ~370 KB. The server refuses anything over 400 KB, so a raw image never reaches Cloudinary. |
| html2canvas | Loaded on demand from cdnjs, pinned to 1.4.1 with an SRI hash. Can be self-hosted (`html2canvasUrl`). |
| Clicks | The click text is capped at 50 characters and masked elements record `[masked]`. Clicks on `body`/`html` record no text. |

### Detection rules (defaults; configurable through `init()` options, clamped to safe ranges)

| Issue | Default rule | Option |
| --- | --- | --- |
| `HttpError` | Status in `[400, 404, 405, 413, [500, 599]]` (401/403/409/422/429 are normal app flow) | `httpErrorStatuses` |
| `NetworkError` | No response (offline, timeout, CORS, DNS/SSL). Requests the user cancelled are never reported. | `captureNetworkErrors` |
| `PageNotFound` | Navigation Timing `responseStatus` of 404/410, or a manual `capturePageNotFound()` call (SPAs) | `detectPageNotFound` |
| `SlowPageLoad` | > 3000 ms. Opt-in, and not reported if the tab was hidden before load. | `slowPageLoadMs`, `captureSlowEvents` |
| `SlowApiCall` | > 2000 ms, opt-in, at most once per endpoint every 5 min | `slowApiCallMs`, `captureSlowEvents` |
| `MainThreadBlocked` | A long task > 1000 ms (Long Tasks API); at most one report every 30 s | `mainThreadBlockedMs` |
| `LowFrameRate` | A 1 s sample every 30 s that comes in below 20 fps | `lowFrameRateFps` |
| `MemoryLeakSuspected` | See below | `memoryPollIntervalMs`, `memoryLeakGrowth`, `memoryLeakMinGrowthMb`, `memoryLeakReadings` |

**Memory-leak rule:**
1. Ignore the first 60 s after init (warm-up).
2. Poll the heap every 30 s and group the readings into windows of 4. Each window's lowest reading is its **floor**, which approximates the heap after garbage collection.
3. Report a suspected leak only when all of these hold:
   - Each of the last 4 floors rises by at least 0.5 MB over the one before.
   - No single step is more than 70% of the total rise. One heavy screen loading once is not a leak.
   - The newest floor is at least 20% **and** at least 10 MB above the lowest floor seen.
4. Report at most once per page.

---

## 4. Backend technical approach

### Ingestion pipeline (`api/v1/events.js` → `lib/ingest.js`)

```
X-API-Key ─► SHA-256 ─► project lookup (cached 60 s) ─► disabled? 403
          ─► Origin not in the project's allowed origins? 403 origin_not_allowed
          ─► per project + IP: errors 150/min → 429 rate_limited_ip   |   page views 150/min → rejected "rate_limited"
          ─► per project:      errors: no limit                      |   page views 1000/min → rejected "rate_limited"
          ─► validate each event (truncate long strings, cap arrays, fix clock skew > 24 h)
          ─► transactions → `transactions` + hourly `perf_rollups`
          ─► others → upload screenshot (4 at a time) → upsert issue by fingerprint → insert event
          ─► 202 { accepted, rejected }
```

- **Separate budgets:** errors and page views have separate per-minute budgets, so heavy page-view traffic can't crowd out errors. Page views over budget are dropped rather than retried, because they are samples, not reports.
- **Rate limits:** counted in fixed windows stored in MongoDB (`rate_limits`, TTL), so the limits hold across all serverless instances.

### Allowed origins and per-IP limit

A browser app's API key is public: anyone can copy it from the page. It can only send events, never read data, so the risk is fake or junk events. Two checks limit that:

| Check | Rule | Stops | Doesn't stop |
| --- | --- | --- | --- |
| **Allowed origins** (`lib/origins.js`) | Per project, a list of exact origins (scheme + host + port, e.g. `http://localhost:3000`, `https://myapp.com`), max 20, no wildcards. Empty list = any origin. No `Origin` header = allowed (server-side SDKs, mobile apps). `Origin: null` (file:// pages) = refused when a list exists. | Other websites using a copied key through their visitors' browsers (browsers set `Origin` themselves) | Scripts outside a browser, which can fake the header |
| **Per-IP limit** (`lib/rateLimit.js`) | 150 events and 150 page views per minute per project + client IP (`x-forwarded-for`, set by Vercel; IPv6 counted per /64). | One source flooding a project with errors | Many IPs at once (only key rotation helps there, since errors have no per-project limit) |

- **No per-project error limit:** a project accepts any number of errors per minute from all its users together; only each IP is capped. (`RATE_LIMIT_EVENTS_PER_MINUTE` is `null`; setting a number turns a per-project limit back on.) Page views keep their per-project budget of 1000/min.
- **Order:** the origin and per-IP checks run before the page-view project budget, so a refused request uses none of it.
- **Refusals keep the CORS headers.** Without them the browser would hide the 403 from the SDK, which would treat it as a network error, retry, and store the events offline to try again on every page load. With them, the SDK sees a 4xx and drops the events once.
- **Applying changes:** edits go through `PATCH /api/projects?id=…` and reach other serverless instances within 60 s (project cache).
- **Shared IPs:** many users behind one office IP share the 150/min. Errors are rare in production, so this leaves plenty of room, and an over-limit batch is retried by the SDK and then kept offline, not lost.

### Grouping (`lib/grouping.js`)

```
fingerprint = sha256( event_type | error.type | normalize(message) | topFrame.function@normalize(topFrame.file) )
```

- **Normalizing messages:** UUIDs, hex IDs, numeric path segments, measurements (`2505ms`, `12 fps`), `#42` counters and long numbers are replaced with placeholders. Short numbers such as HTTP status codes are kept.
- **Normalizing file names:** the origin, query string and build hashes are removed (`page-69f0…d9.js` → `page.js`). Line and column numbers are ignored because they shift with every code change.
- **Issue status:** each issue is `open`, `resolved` or `ignored`. A resolved issue that happens again is reopened (`regressedAt`).
- A unique index on `(projectId, fingerprint)` with retry-on-duplicate handles two requests creating the same issue at the same time.

### Storage and retention (MongoDB TTL indexes)

| Collection | Contents | Retention |
| --- | --- | --- |
| `projects` | name, `ownerId`, `apiKeyHash`, key hint, `allowedOrigins` | — |
| `users` | email, scrypt hash, role, status, `sessionVersion` | — |
| `issues` | Grouped problems: count, first/last seen, status, environments | 90 days after last seen |
| `events` | Every occurrence: indexed summary fields + full payload + screenshot URL | 30 days |
| `transactions` | Raw page views ("slowest samples") | 7 days |
| `perf_rollups` | Per project / hour / environment / route or endpoint: counts and a log histogram (base 1.15 → percentiles ±7%) | 90 days |
| `rate_limits` | Fixed-window counters | Expire on their own |

Screenshots are stored in Cloudinary (unsigned upload preset, uploaded with `fetch`, no SDK), and only the URL is kept in MongoDB.

### Dashboard authentication and access

- **Accounts:** public sign-up. Passwords are hashed with **scrypt** (N=16384, ~50 ms per hash) and must be 8–128 characters.
- **Session:** an HttpOnly, `SameSite=Strict` (and `Secure` in production) cookie `et_session` holding `{ userId, sessionVersion, expiry }`, HMAC-SHA256 signed with `SESSION_SECRET`, valid for 7 days. The user record is re-read on every request, so bumping `sessionVersion` (password change, "log out other devices", account disabled) ends old sessions immediately.
- **Ownership:** every dashboard endpoint goes through `lib/access.js`. Another user's data answers **404**, not 403, so it doesn't reveal that the data exists. Admins manage accounts but can't read other users' issues.
- **Cross-site requests:** writes (non-GET) with a foreign `Origin` header are refused. This is on top of the cookie's `SameSite` protection.
- **Rate limits:**
  - sign-up: 5 per IP per hour
  - login: 10 per account+IP and 50 per IP, per 15 minutes
  - no limit on projects per user (`MAX_PROJECTS_PER_USER` is `null`; a number turns the limit back on)
- **HTTP headers** (`vercel.json`): strict CSP (`script-src 'self'`; images only from self and `res.cloudinary.com`), HSTS, `X-Frame-Options: DENY`, `nosniff`, and a restrictive Permissions-Policy.

### Dashboard API (all under `/api`, session cookie required except `auth` and `health`)

| Endpoint | Methods | Purpose |
| --- | --- | --- |
| `auth` | GET, POST `?action=signup\|login\|logout` | Session |
| `account` | GET, PATCH, POST `?action=logout-others`, DELETE | Own profile and password |
| `admin` | GET, PATCH, DELETE | Manage users (admins only) |
| `projects` | GET, POST (create, `?action=rotate-key`), PATCH `{allowedOrigins}`, DELETE | Projects, API keys and allowed origins |
| `issues` | GET (filters, search, pages of 50), DELETE (bulk) | Issue list |
| `issue` | GET, PATCH `{status}`, DELETE | One issue with its recent events |
| `event` | GET | One full event |
| `stats` | GET `?range=24h\|7d`, `?view=performance` | Dashboard charts and the Performance view |
| `health` | GET | Liveness check |

---

## 5. Constraints that shaped the design

| Constraint | Effect |
| --- | --- |
| SDK must never crash the host app | `safe` wrappers everywhere, silent failure, and a single network wrap |
| No third-party runtime packages (SDK) | Hand-written queue, retry, stack parser and serializer. html2canvas is the only exception, loaded on demand. |
| Backend may only use `mongodb` | Plain Vercel functions, a vanilla-JS dashboard, inline SVG charts, hand-written data cache, `node:test` |
| Vercel Hobby limit of 12 functions | 10 are in use, and related routes share one file (e.g. `auth?action=`) |
| Every field always present | The backend schema stays the same across JS, iOS and Android |
| JS SDK targets ES5 | TypeScript is pinned to ~5.9 (TS 7 drops ES5) |
