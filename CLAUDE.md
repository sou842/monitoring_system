# Monitoring System — Error Tracking SDK

## What we're building
An in-house error tracking SDK, similar to Bugsnag or Sentry but owned entirely by the company. It's original code: never wrap or import Sentry, Bugsnag, Crashlytics, etc. The SDK runs inside client apps, watches for errors, performance problems, memory issues and crashes, and POSTs JSON events to a backend endpoint.
**Scope: client SDKs only.** No backend, dashboard or grouping engine.

Three SDKs, all sending the **same shared payload schema**:
| SDK | Path | Stack | Status |
| --- | --- | --- | --- |
| JS | `error-tracking-sdk/js/` | TypeScript → ES5, Rollup (ESM + CJS), Vitest, zero runtime deps | ✅ Done (2026-10-17) |
| iOS | `error-tracking-sdk/ios/` | Swift 5.5+, iOS 14+, Swift Package + Podspec, XCTest | ⏳ Not started |
| Android | `error-tracking-sdk/android/` | Kotlin 1.8+, API 21+, Gradle AAR, JUnit4 + Mockito | ⏳ Not started |

**Full original spec (requirements for every SDK, shared schema, test scenarios): [docs/SPEC.md](docs/SPEC.md).** Read it before starting iOS, Android or the test-scenario suite.

## Core rules (from the spec)
- **The SDK must never crash the host app.** Every SDK failure fails silently, with at most a debug log.
- No console, Logcat or NSLog output unless `debug: true`.
- The API key exists only in memory and in the outgoing request header. Never persist it.
- Every schema field is always present. Use `null` when a platform can't provide it; never omit a field.
- No `any` in TypeScript. No `!` force-unwraps in Swift or Kotlin without a comment. Doc comments on every public method.
- No magic numbers: all thresholds go in a constants file.
- No third-party packages unless the spec lists them. Ask first.
- Ask the user before choosing between two implementation approaches.
- Don't capture screenshots while the app is in the background.
- Build order: types → core queue and payload builder → transport and retry → collectors → public API → tests → README.

## Decisions already made (keep all 3 platforms consistent)
- **Batch body:** `{ "events": [ ... ] }`. Headers: `Content-Type: application/json` and `X-API-Key`.
- **Retry:** network errors, 5xx, 408 and 429 are retried 3× (1s/2s/4s). Other 4xx responses are dropped with no retry.
- **Error-storm protection:** identical events (type + message + top frame) are deduplicated within 5 s, then a rate limit of 100 events per rolling minute applies.
- **Extra JS fields beyond the shared schema:** `level`, `context`, `performance.cls`, `device.referrer`. ⚠️ Still needs backend sign-off. iOS and Android should probably include `level` and `context` too.
- **JS screenshots:** html2canvas loaded on demand from cdnjs with an SRI hash (the user chose this over a DOM serializer). Two-layer masking: style the cloned DOM, then draw black rectangles over masked elements.
- **Performance events:** `event_type: "performance"`, with the issue in `error.type` (`SlowPageLoad`, `SlowApiCall`, `MemoryLeakSuspected`, `MainThreadBlocked`, `LowFrameRate`) and `handled: true`.
- **Error types built by the SDK** (all `event_type: "error"`): `HttpError`, `NetworkError`, `InvalidJsonResponse`, `ResourceError`, `CspViolation`, `WorkerError`, `ConsoleError`, `CrossOriginScriptError`. Extra detail goes in `context`.
- **`handled` rule:** `false` = broke without app code getting a chance (uncaught exceptions/rejections, failed resources, CSP, workers). `true` = handed back to the app (HTTP status, rejected request, JSON parse error, console.error, perf issues, `captureError`).
- **One failure, one event:** `core/reportedErrors.ts` remembers reported error objects (WeakSet) and short-lived text signatures, so the same failure arriving by a second route (unhandledrejection, console.error, worker error re-dispatched on window) is skipped.
- **Error storms:** when the rate limit drops events, one `EventsDropped` message (`context.dropped_count`) is sent 10 s later.
- **User decisions (2026-10-17):** track server errors via Next.js `onRequestError`; freezes via the Long Tasks API only (no watchdog worker); `captureConsoleErrors` opt-in, default off; cross-origin "Script error." is documented and labelled, with no try/catch wrapping of browser APIs.
- URLs have their query string and fragment stripped before recording (PII).
- Offline / failed-delivery events are persisted (JS: `localStorage["_et_queue"]`, max 50, screenshots dropped first if storage is full).

## Environment constraints
- Windows 10 machine with **only Node.js** installed: no JDK, Gradle, Android SDK, Swift or Xcode. iOS and Android code can be written here but **not compiled or tested**; the user must verify on a Mac or in Android Studio.
- No Python on this machine; use Node for scripting.
- JS: TypeScript is **pinned to ~5.9** because TS 7 drops `target: ES5`. Don't upgrade it.

## JS SDK on npm
- Package: **`@sourav732/error-tracker-js`**, public, from the user's own npm account. First version **0.1.0** (still early: only tested in Chrome). License stays `UNLICENSED`.
- `prepublishOnly` runs typecheck + tests + build, so `npm publish` can't ship a broken build. The build is minified with `@rollup/plugin-terser` (ES5, ~55 KB per format, with source maps).
- `SDK_VERSION` in `src/constants.ts` must equal the `package.json` version; a test enforces it. Bump both together.
- The user runs `npm login` / `npm publish` themselves (needs their account and 2FA).
- Verified 2026-10-17: the `npm pack` tarball installed in a fresh project works via CJS, ESM and strict TS, with zero runtime deps, and `npm publish --dry-run` passes.

## JS SDK quick reference
```bash
cd error-tracking-sdk/js
npm run typecheck   # strict TS over src + tests
npm test            # Vitest + jsdom (151 tests passing)
npm run build       # dist/index.mjs, dist/index.cjs, dist/types
```
- `src/core/client.ts` drives the pipeline: sample → dedup → rate-limit → build → screenshot → beforeSend → queue.
- `src/core/eventQueue.ts`: batching, retry, offline persistence. `src/transport/`: fetch sender and localStorage store.
- `src/collectors/`: error, breadcrumb (+ opt-in console errors), performance, memory, screenshot, httpError (HTTP + network failures), jsonResponse, responsiveness (long tasks + FPS), csp, worker, resource (fonts, CSS images, pre-init failures). `networkInterceptor.ts` is the single fetch/XHR wrap they share; it also passes the failure kind and the app call-site stack.
- Automatic collectors only install when `window` exists; in Node the SDK is used for `captureError` only (Next.js server errors).
- Vitest: don't use `vi.runAllTimersAsync()` with an initialised client, because the FPS sampler's repeating timer never ends. Use `advanceTimersByTimeAsync(ms)`.
- Schema shape test helper: `expectSchemaShape()` in `tests/helpers.ts`.

## Demo app: `project/web/`
A basic Next.js 15 (App Router, plain JS) app that uses the JS SDK through `file:../../error-tracking-sdk/js`. `node_modules` symlinks to the SDK folder, so after an SDK change: run `npm run build` in the SDK, then restart `npm run dev` (delete `.next/` if the change doesn't show up).
- **Browser:** the SDK is initialized in `instrumentation-client.js`, which runs before React hydrates, so first-render and hydration errors are caught. `app/error.js` reports page render crashes, and `app/global-error.js` reports root-layout crashes.
- **Server:** `instrumentation.js` → `onRequestError` → `lib/serverErrors.js` sends API-route, server-component and SSR errors through the SDK in Node, with `context.source: "server"`.
- The home page has a button for every scenario. Other demo pages: `/hydration`, `/csp` (report-only CSP header from `next.config.mjs`, plus a broken `<img>` in the server HTML), `/server-error`.
- APIs: `/api/products`, `/api/slow` (2.5 s), `/api/fail` (500), `/api/bad-json`, `/api/crash` (server throw). `/api/events` is the local receiver: POST prints events to the terminal and keeps server events in memory; GET/DELETE list/clear them.
- **Issues page** (`/issues`): temporary dashboard. The SDK's `beforeSend` hook saves browser events to `localStorage["web_issues"]` (newest 30) through `lib/issueStore.js`. Server events are polled from `/api/events`. Each issue expands to show stack trace, breadcrumbs, performance (incl. FPS), memory, device, context and screenshot.
- **Real-browser check:** build with `NEXT_DIST_DIR=.next-test npx next build` (a separate folder, so it doesn't clash with `npm run dev`), then drive headless Chrome (installed at `C:/Program Files/Google/Chrome/Application/chrome.exe`) over the DevTools protocol with a throwaway `--user-data-dir`. Done 2026-10-17: every scenario produced exactly one event in Chrome.

## Next steps
1. Confirm with the user/backend: the extra payload fields, the batch body format, and the throttling numbers.
2. Build the Android SDK (spec in docs/SPEC.md), or iOS, whichever the user picks.
3. Then the "test scenarios" suite from the spec, for each SDK.
4. JS: checked in real Chrome (headless); Safari and Firefox are still unchecked. Long Tasks, ReportingObserver and Resource Timing status are Chromium-only there.
