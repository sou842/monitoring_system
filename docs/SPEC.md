# Error Tracking SDK — Original Spec

> Source: "Claude Code Prompt — Error Tracking SDK", 17 Oct 2026, by Sourav Samanta.
> Saved here so the requirements survive across chat sessions. Content reproduced from the original.

> **Status note (2026-10-26):** this file is the original requirement text and is kept as written. Later changes: a backend and dashboard were added (`project/backend/`, merged into the Next.js app `project/web/` on 2026-10-30, so "client-side SDK only" below is no longer the whole project), the JS memory-leak rule was rewritten in 0.4.0 (heap floors instead of 3 readings), and the schema gained `level`, `context`, `performance.cls`, `device.referrer` and the `transaction` event. For the current behaviour and numbers, see [PROTOCOL.md](PROTOCOL.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Project overview
You are building a production-grade error tracking SDK from scratch, similar to Bugsnag or Sentry but owned entirely by our company. This is not a wrapper around any existing library. Every line of code must be original, clean, and written as if it will be maintained long-term by a professional engineering team.

The SDK runs inside a client app (browser, iOS, or Android). It silently monitors the app for errors, performance issues, and crashes, then sends structured JSON payloads to a backend API endpoint. It does not include a backend, dashboard, or grouping engine. The scope is the client-side SDK only.

Three SDKs to build:
- JS SDK: for browser, React, Vue, and vanilla JS apps
- iOS SDK: written in Swift, targeting iOS 14+
- Android SDK: written in Kotlin, targeting API level 21+

**Core principle:** The SDK must never crash the host app. If anything goes wrong inside the SDK itself (network failure, serialization error, storage full), it must fail silently and log a warning at most. The host app's stability always takes priority.

## Tech stack and folder structure
**JS SDK:** TypeScript (compiled to ES5 for max compatibility). Rollup, outputting both ESM and CJS builds. No runtime dependencies. Targets browsers (Chrome 60+, Safari 12+, Firefox 60+) and Node.js 14+.

**iOS SDK:** Swift 5.5+. Distributed as a Swift Package (Package.swift). Minimum deployment target iOS 14. No third-party dependencies.

**Android SDK:** Kotlin 1.8+. Distributed as a Gradle module / AAR. Minimum SDK API 21 (Android 5.0). No third-party dependencies (Android standard library only).

```
error-tracking-sdk/
├── js/
│   ├── src/
│   │   ├── core/          # Payload builder, event queue, retry manager
│   │   ├── collectors/    # Error, performance, memory collectors
│   │   ├── transport/     # HTTP sender, offline buffer
│   │   └── index.ts       # Public API / init
│   ├── tests/
│   └── package.json
├── ios/
│   ├── Sources/ErrorTracker/
│   │   ├── Core/
│   │   ├── Collectors/
│   │   ├── Transport/
│   │   └── ErrorTracker.swift   # Public API
│   ├── Tests/
│   └── Package.swift
└── android/
    ├── errortracker/
    │   └── src/main/kotlin/com/company/errortracker/
    │       ├── core/
    │       ├── collectors/
    │       ├── transport/
    │       └── ErrorTracker.kt   # Public API
    ├── tests/
    └── build.gradle
```

---

## JS SDK (✅ implemented)
Public API:
```ts
ErrorTracker.init({
  apiKey: string,
  endpoint: string,         // e.g. "https://api.yourcompany.com/v1/events"
  environment: string,      // "production" | "staging" | "development"
  appVersion: string,
  sampleRate: number,       // 0.0 to 1.0, default 1.0
  maxBreadcrumbs: number,   // default 30
  maskSelectors: string[],  // CSS selectors whose text is hidden in click breadcrumbs
  debug: boolean,           // enable console warnings, default false
});
ErrorTracker.captureError(error: Error, context?: Record<string, any>);
ErrorTracker.captureMessage(message: string, level?: 'info'|'warning'|'error');
ErrorTracker.setUser(user: { id: string; email?: string; name?: string });
ErrorTracker.addBreadcrumb(breadcrumb: { type: string; message: string; data?: object });
```
Collectors (one file each, under src/collectors/):
1. **ErrorCollector:** attach window.onerror and the `unhandledrejection` listener. Parse errors into stack frames (filename, line, column, function). No external source-map library.
2. **BreadcrumbCollector:** record clicks (tag + text + CSS path), navigation (pushState/popState), console warn/error, and fetch/XHR (URL, method, status, duration). Circular buffer of maxBreadcrumbs.
3. **PerformanceCollector:** Navigation Timing + PerformanceObserver to collect page load, TTFB, FCP, LCP, CLS. Intercept fetch/XHR for per-call timings. Flag a page load over 3000 ms or an API call over 2000 ms as slow.
4. **MemoryCollector:** poll performance.memory every 30 s (heap used/total). Set `leak_suspected` if heap used grows more than 20% across 3 consecutive readings without navigation.

Transport: fetch with Content-Type JSON and `X-API-Key`. Queue in memory. When offline, persist to localStorage `_et_queue` and flush on the `online` event. Retry 3× with 1s/2s/4s backoff. Batch up to 10 events. Apply sampleRate before queuing (drop the event if `Math.random() > sampleRate`).

Also: strict TS, exported types, tree-shakeable ESM plus CJS, public methods safe to call before init (queue them and flush after init), Vitest tests for ErrorCollector, BreadcrumbCollector, PayloadBuilder and retry logic, a README, and zero console output unless debug.

---

## iOS SDK (⏳ to do)
Build a production-grade iOS error tracking SDK in Swift. Original code: do not import or wrap any third-party crash reporting library. Distribute as a Swift Package.

Public API:
```swift
ErrorTracker.shared.initialize(config: ErrorTrackerConfig(
  apiKey: String,
  endpoint: String,
  environment: String,
  appVersion: String,
  sampleRate: Double,       // 0.0–1.0, default 1.0
  maxBreadcrumbs: Int,      // default 30
  maskViews: [UIView],      // views whose labels are hidden in touch breadcrumbs
  debug: Bool
))
ErrorTracker.shared.captureError(_ error: Error, context: [String: Any]? = nil)
ErrorTracker.shared.captureMessage(_ message: String, level: EventLevel = .error)
ErrorTracker.shared.setUser(_ user: TrackedUser)
ErrorTracker.shared.addBreadcrumb(_ breadcrumb: Breadcrumb)
```
Collectors (one Swift file each):
1. **CrashCollector:** NSSetUncaughtExceptionHandler for ObjC exceptions, plus signal handlers for SIGABRT, SIGSEGV, SIGBUS, SIGILL and SIGTRAP. On crash, write the event JSON to a file in the Caches directory. On next launch, read and send pending crash files before calling the user's completion handler.
2. **BreadcrumbCollector:** swizzle (or use method observation) to record UIViewController viewDidAppear, touch events (element class + accessibility label), and URLSession completions (URL, method, status, duration). Thread-safe circular buffer of maxBreadcrumbs, guarded by a serial DispatchQueue.
3. **PerformanceCollector:** cold start time (process launch to first viewDidAppear). For each URLSessionDataTask, record URL, method, status and duration. Flag a screen that takes over 1000 ms to appear as slow. Track frame rate via CADisplayLink; flag drops below 55 fps as jank.
4. **MemoryCollector:** os_proc_available_memory() and task_vm_info every 30 s. Observe UIApplication.didReceiveMemoryWarningNotification. Detect OOM termination (didFinishLaunching with no clean-exit flag set), record an OOM event, and send it on next launch.

Transport: URLSession.shared with a custom URLSessionConfiguration (60 s timeout). Persist unsent events to a JSON file in Caches. Flush on launch and on applicationWillEnterForeground. Retry 3× (1s/2s/4s) on a background queue. Batch up to 10. Compress with zlib if over 50 KB. Send the `X-API-Key` and `Content-Type: application/json` headers.

Also: thread-safe throughout (serial DispatchQueue or actor), works with SPM and CocoaPods (provide a Podspec), XCTest tests for payload building, the breadcrumb buffer and retry logic, a README with SPM install and usage, and zero console output unless debug.

---

## Android SDK (⏳ to do)
Build a production-grade Android error tracking SDK in Kotlin. Original code: do not import or wrap any third-party crash reporting library. Distribute as a Gradle module that outputs an AAR.

Public API:
```kotlin
ErrorTracker.init(
  context: Context,
  config = ErrorTrackerConfig(
    apiKey = String,
    endpoint = String,
    environment = String,
    appVersion = String,
    sampleRate = Double,       // 0.0–1.0, default 1.0
    maxBreadcrumbs = Int,      // default 30
    maskViewIds = List<Int>,   // R.id.* views whose labels are hidden in touch breadcrumbs
    debug = Boolean
  )
)
ErrorTracker.captureError(throwable: Throwable, context: Map<String, Any>? = null)
ErrorTracker.captureMessage(message: String, level: EventLevel = EventLevel.ERROR)
ErrorTracker.setUser(user: TrackedUser)
ErrorTracker.addBreadcrumb(breadcrumb: Breadcrumb)
```
Collectors (one Kotlin file each):
1. **CrashCollector:** implement Thread.UncaughtExceptionHandler and chain to the existing default handler after recording. On crash, serialize the event to a JSON file in context.cacheDir. On next launch, send pending crash files before host app code runs (ContentProvider with android:initOrder for early init).
2. **ANRCollector:** a watchdog thread posts a Runnable to the main thread every 3 s. If the main thread hasn't responded within 5 s, capture stack traces of all threads and record an ANR event.
3. **BreadcrumbCollector:** Application.ActivityLifecycleCallbacks for Activity transitions. Wrap OkHttp if present (detect via reflection; no hard dependency), otherwise intercept HttpURLConnection, to record API calls. Record touch events via a custom Window.Callback. Thread-safe circular buffer: ArrayDeque + ReentrantLock.
4. **PerformanceCollector:** cold start via ProcessStartTimeHelper / AppStartInfo (API 35+), falling back to Process.getStartUptimeMillis(). Track each HTTP call's URL, method, status and duration. Detect dropped frames with Choreographer.FrameCallback (flag when frame time exceeds 16 ms × 3). Flag an Activity onResume over 1000 ms as slow.
5. **MemoryCollector:** ActivityManager.getMemoryInfo() and Debug.MemoryInfo every 30 s. Register ComponentCallbacks2.onTrimMemory for memory pressure. Detect OOM kills via ActivityManager.getHistoricalProcessExitReasons (API 30+) and record them on next launch.

Transport: HttpURLConnection (no OkHttp dependency) with 60 s connect and read timeouts. Persist unsent events as JSON files in context.cacheDir/errortracker/. Flush on launch and on ProcessLifecycleOwner foreground transitions. Retry 3× (1s/2s/4s) on a background ExecutorService. Batch up to 10. Send the `X-API-Key` and `Content-Type: application/json` headers. Use ConnectivityManager.NetworkCallback to flush on reconnect.

Also: minSdk 21, with @RequiresApi on API-gated calls plus safe fallbacks. Thread-safe, and no heavy work on the main thread. JUnit 4 + Mockito tests for payload building, the breadcrumb buffer, the ANR detector and retry logic. A README with Gradle install and usage. A consumer-proguard-rules.pro. Zero Logcat output unless debug.

---

## Shared payload schema
All three SDKs must send events in this exact JSON shape. Any field not available on a platform must be `null`, never omitted, so the backend schema stays consistent.
```json
{
  "sdk": {
    "name": "error-tracker-js" | "error-tracker-ios" | "error-tracker-android",
    "version": "1.0.0"
  },
  "api_key": "string",
  "event_type": "error" | "message" | "performance" | "crash" | "transaction",
  "timestamp": "2026-10-17T10:42:15.000Z",
  "environment": "production",
  "app_version": "2.1.4",
  "user": { "id": "usr_8821", "email": null, "name": null },
  "error": {
    "message": "Cannot read property 'price' of undefined",
    "type": "TypeError",
    "handled": false
  },
  "stacktrace": [
    { "filename": "cart.js", "lineno": 142, "colno": 12, "function": "handlePayment" }
  ],
  "breadcrumbs": [
    { "timestamp": "ISO8601", "type": "navigation" | "click" | "api" | "log" | "lifecycle", "message": "string", "data": {} }
  ],
  "performance": {
    "page_load_ms": 4200,
    "ttfb_ms": 320,
    "fcp_ms": 1800,
    "lcp_ms": 2400,
    "startup_ms": null,
    "frame_rate_fps": 58,
    "slow_screen": false,
    "api_calls": [
      { "_id": "9f3c2a7b41d0e865", "url": "/api/cart", "method": "POST", "status": 200, "duration_ms": 230 }
    ],
    "slow_api_calls": []
  },
  "memory": {
    "used_mb": 142,
    "total_mb": 256,
    "leak_suspected": false,
    "oom_kill": false
  },
  "device": {
    "platform": "js" | "ios" | "android",
    "os": "Windows 11" | "iOS 17.4" | "Android 14",
    "os_version": "string",
    "manufacturer": null,
    "model": null,
    "browser": "Chrome",
    "browser_version": "124.0",
    "screen_width": 1920,
    "screen_height": 1080,
    "url": "https://app.example.com/checkout",
    "locale": "en-IN"
  },
  "transaction": null
}
```

### Addition (2026-10-23, JS 0.5.0): page views as `transaction` events
Added after the original spec, for Sentry-style performance monitoring. Every SDK sends `"transaction": null` on all other events, and one `transaction` event per **page view** (web route, iOS view controller, Android Activity or Fragment). A transaction event has `error: null`, `stacktrace: []`, `breadcrumbs: []`, an empty `performance` block (nulls / empty arrays), level `info`, and:
```json
"transaction": {
  "name": "/orders/42",                 // route path, or the screen's class/route name on mobile
  "kind": "pageload" | "navigation" | "continued",
  "start": "ISO8601",
  "duration_ms": 5000,
  "background": false,                  // the app/tab was in the background at some point during the view
  "vitals": { "ttfb_ms": null, "fcp_ms": null, "lcp_ms": null, "cls": null, "inp_ms": null, "page_load_ms": null },
  "long_tasks": { "count": 0, "blocking_ms": 0 },
  "spans": [{ "_id": "4b1e09c7d2a35f80", "op": "http", "method": "GET", "url": "https://api.example.com/orders/42", "status": 200, "failure": null,
              "start_ms": 100, "duration_ms": 600, "server_ms": 500, "download_ms": 80, "size_bytes": 2048, "background": false }],
  "dropped_spans": 0
}
```
- **kind:** `pageload` = first view after launch/page load (mobile: cold start; `page_load_ms` = startup time), `navigation` = moved to another screen, `continued` = same screen after returning from the background, or a view split after 30 minutes.
- **A view ends** on navigation, when the app goes to the background, or after 30 minutes. Background time is never part of a view; spans that overlapped the background are flagged `background: true` and excluded from percentiles by the backend.
- **spans:** every HTTP request (max 100 per view, the rest counted in `dropped_spans`). `server_ms` = request sent → first response byte, `download_ms` = first → last byte (iOS: `URLSessionTaskMetrics`; Android: OkHttp `EventListener` when present, else null). Query strings are stripped from URLs.
- **vitals** are web metrics; mobile SDKs send null for those without an equivalent (`inp_ms` may map to the slowest touch-to-frame latency; `long_tasks` to main-thread hangs over 50 ms).
- **Sampling:** `performanceSampleRate` (default 1.0), decided once per app launch / page load. Separate from `sampleRate`. Use `beforeSendTransaction` to scrub or drop.
- Per-request `SlowApiCall` / `SlowPageLoad` issue events are opt-in (`captureSlowEvents`, default false).

### Addition (2026-10-28, JS 0.8.0): `screen`
Every event has a top-level `"screen": string | null`: the app screen the event happened on, set by the app with `setScreen(name | null)`, and `null` until the app sets one. It exists for apps whose screens change without the URL changing (Appzillon, wizards, tab UIs). It is not the same as `device.url`, which is always the page URL.
- `setScreen` trims the name and cuts it to 200 characters. A non-string is ignored, an empty name clears the screen, and repeating the current screen does nothing.
- A new screen leaves a `navigation` breadcrumb (`Screen: <name>`, data `{ from, to, trigger: "setScreen" }`) and starts a new page view (`kind: "navigation"`, same `transaction.name`). A transaction event carries the screen of **its** view, even when it is sent after the next screen was set.
- The backend groups page views by `screen` when present, otherwise by the normalized URL route. The dashboard shows `screen` next to the page URL.
- iOS/Android should send the same field. A sensible default is `null` with `setScreen` only, so automatic view-controller or Activity names stay in `transaction.name`.

### Addition (2026-10-28, JS 0.9.0): API call `_id`
Every recorded HTTP request gets a unique `"_id": string` (JS: 16 random lowercase hex characters, from `crypto.getRandomValues` with a `Math.random` fallback), created once when the request finishes. The same call carries the **same** `_id` everywhere it appears:
- `performance.api_calls[]._id` and `performance.slow_api_calls[]._id`
- the `api` breadcrumb's `data._id`
- the page view's `transaction.spans[]._id`
- `context._id` of the `HttpError`, `NetworkError` or `SlowApiCall` event the call caused

It lets you find every stored event that recorded one call. It is **not** sent to the app's API as a header (not distributed tracing). The backend keeps strings up to 64 characters and stores `null` for older SDKs; iOS/Android should send the same field (any unique string ≤ 64 characters, e.g. 16 hex characters).

---

## Test scenarios (⏳ to do, after the SDKs are built)
Write a comprehensive test suite covering every scenario below. For each one: write the test, explain how to trigger it manually, and state the expected payload field values.

- **Runtime errors:** null/undefined access, type mismatch, index out of bounds, stack overflow, division by zero, cast failure
- **Async errors:** unhandled promise rejection, uncaught async/await error, ignored callback error, race-condition crash
- **Network errors:** API timeout, offline request, 4xx response, 5xx response, SSL error, malformed JSON response
- **UI errors:** component render crash, missing resource, layout conflict, DOM manipulation error, infinite re-render
- **Memory & performance:** memory leak detection, OOM crash, slow page load (>3 s), dropped frames (<55 fps), ANR (Android only), slow API call (>2 s)
- **Native crashes:** SIGSEGV / SIGABRT signal, iOS watchdog timeout, Android JNI crash, background task termination
- **Storage errors:** disk full simulation, corrupt local DB, localStorage quota exceeded, permission denied
- **SDK-specific:** capture before init, invalid API key, offline queuing and flush on reconnect, duplicate event dedup, PII masking in breadcrumbs, high-frequency error-storm throttling (1000 events/min)

For each test, assert that the event is sent to the endpoint, the payload matches the shared schema, and the correct fields are populated. For the SDK-specific cases, also assert that the host app does not crash.

---

## General rules
**Before writing any code:**
1. Read the shared payload schema. Every field must be present in output events.
2. Plan the file structure first and confirm it matches the folder layout.
3. Don't install third-party packages unless explicitly listed. Ask first.

**Code quality:**
- No `any` types in TypeScript. No `!` non-null force-unwraps in Swift or Kotlin without a comment.
- Every public method has a doc comment (JSDoc / Swift doc / KDoc).
- No magic numbers. Extract all constants (timeouts, retry counts, thresholds) to a named constants file.
- Handle every error path explicitly. No silent swallows without a debug log.
- All file I/O and network calls are async and never block the main thread.

**Build order:**
1. Shared types / models
2. Core event queue and payload builder
3. Transport layer with retry logic
4. Collectors one by one (Error → Breadcrumb → Performance → Memory)
5. Public API surface
6. Unit tests
7. README

**What NOT to do:**
- Don't wrap Sentry, Firebase Crashlytics, Bugsnag or any other SDK.
- Don't use deprecated APIs without a clearly commented fallback.
- Don't print to console / Logcat / NSLog unless debug mode is enabled.
- Don't store the API key anywhere other than in memory and the outgoing request header.

**When unsure:**
- Ask before choosing between two implementation approaches.
- If a platform API is only available from a certain OS version, implement it with a version check and a safe fallback, and leave a `// TODO: test on API <N>` comment.

**Definition of done (per SDK):**
- [ ] All collectors implemented and tested
- [ ] Payload matches the shared schema exactly
- [ ] Offline queue works (send, persist, flush on reconnect)
- [ ] PII masking in breadcrumbs tested
- [ ] High-frequency throttling tested
- [ ] SDK does not crash the host app under any error condition
- [ ] README complete with install and usage example
