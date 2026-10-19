# Monitoring System — Error Tracking SDK

## What we're building
An in-house error tracking SDK, similar to Bugsnag or Sentry but owned entirely by the company. It's original code: never wrap or import Sentry, Bugsnag, Crashlytics, etc. The SDK runs inside client apps, watches for errors, performance problems, memory issues and crashes, and POSTs JSON events to a backend endpoint.
The original spec scoped this to client SDKs only. On 2026-10-17 the user added a **backend + dashboard** (`project/backend/`, see below).

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
- **Error types built by the SDK** (all `event_type: "error"`): `HttpError`, `NetworkError`, `InvalidJsonResponse`, `ResourceError`, `CspViolation`, `WorkerError`, `ConsoleError`, `CrossOriginScriptError`, `PageNotFound`. Extra detail goes in `context`.
- **`PageNotFound` (2026-10-19, JS 0.3.0):** `collectors/pageNotFoundCollector.ts` reads the document's Navigation Timing `responseStatus` once at install; 404/410 → event with level `warning`, `handled: true`, no screenshot, empty stack, message `Page not found: <path>`, context `{ url, path, status, referrer, source: 'http-status'|'app' }`. Public `capturePageNotFound(url?)` covers SPA route misses and Safari; same message + empty stack so the client dedup collapses a manual call on an auto-detected 404. Config `detectPageNotFound` (default true). Backend groups one issue per path. Verified in headless Chrome + local backend + dashboard.
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
- Package: **`@sourav732/error-tracker-js`**, public, from the user's own npm account. **0.1.0 and 0.2.0 are published**; **0.3.0** is prepared locally (configurable performance thresholds, `PageNotFound`) and the user still has to publish it. License stays `UNLICENSED`.
- **Configurable thresholds (2026-10-19, user chose flat options):** `init()` takes optional `slowApiCallMs`, `slowPageLoadMs`, `mainThreadBlockedMs`, `lowFrameRateFps`, `memoryPollIntervalMs`, `memoryLeakGrowth`, `memoryLeakReadings`. Defaults and min/max stay in `constants.ts`; `resolveConfig()` clamps out-of-range values and ignores non-numbers. Transport, rate-limit, dedup and screenshot limits are deliberately **not** configurable. iOS/Android should offer the same option names.
- `prepublishOnly` runs typecheck + tests + build, so `npm publish` can't ship a broken build. The build is minified with `@rollup/plugin-terser` (ES5, ~55 KB per format, with source maps).
- `SDK_VERSION` in `src/constants.ts` must equal the `package.json` version; a test enforces it. Bump both together.
- The user runs `npm login` / `npm publish` themselves (needs their account and 2FA).
- Verified 2026-10-17: the `npm pack` tarball installed in a fresh project works via CJS, ESM and strict TS, with zero runtime deps, and `npm publish --dry-run` passes.

## JS SDK quick reference
```bash
cd error-tracking-sdk/js
npm run typecheck   # strict TS over src + tests
npm test            # Vitest + jsdom (172 tests passing)
npm run build       # dist/index.mjs, dist/index.cjs, dist/types
```
- `src/core/client.ts` drives the pipeline: sample → dedup → rate-limit → build → screenshot → beforeSend → queue.
- `src/core/eventQueue.ts`: batching, retry, offline persistence. `src/transport/`: fetch sender and localStorage store.
- `src/collectors/`: error, breadcrumb (+ opt-in console errors), performance, memory, screenshot, httpError (HTTP + network failures), jsonResponse, responsiveness (long tasks + FPS), csp, worker, resource (fonts, CSS images, pre-init failures). `networkInterceptor.ts` is the single fetch/XHR wrap they share; it also passes the failure kind and the app call-site stack.
- Automatic collectors only install when `window` exists; in Node the SDK is used for `captureError` only (Next.js server errors).
- Vitest: don't use `vi.runAllTimersAsync()` with an initialised client, because the FPS sampler's repeating timer never ends. Use `advanceTimersByTimeAsync(ms)`.
- Schema shape test helper: `expectSchemaShape()` in `tests/helpers.ts`.

## Backend + dashboard: `project/backend/` (to be deployed on Vercel)
- **User constraint: the only allowed npm package is `mongodb`.** No Next.js/React, zod, TypeScript, vitest or sharp; ask before adding anything. So the backend is plain Vercel functions in `api/*.js` (exporting `GET`/`POST`/… with Web `Request`/`Response`), plain JS (ES modules + JSDoc), a vanilla-JS dashboard in `public/`, `node:test` tests, and `dev-server.js` (Node `http`) that mimics Vercel routing locally.
- **Storage:** MongoDB Atlas (database `monitor`), plus Cloudinary for screenshots (unsigned preset, upload via `fetch`, no SDK). Secrets live only in `project/backend/.env.local` (git-ignored). The Atlas password was pasted in chat on 2026-10-17; the user was told to rotate it.
- **Screenshots must never be uploaded raw** (user requirement). The SDK compresses them (≤1280 px, JPEG 0.5, ~50 KB), and the server refuses anything over 400 KB.
- **Accounts (2026-10-19, replaced the shared `DASHBOARD_PASSWORD`):** public sign-up (user chose: anyone can register; no email verification / password reset for now; basic admin). `users` collection (scrypt hash via `lib/passwords.js`, `role` user|admin, `status` active|disabled, `sessionVersion`). Session cookie = signed `{ user id, sessionVersion, expiry }` (`lib/auth.js`), user re-read on every request; bumping `sessionVersion` (password change, "log out other devices", disable) ends old sessions. Projects have `ownerId`; **every dashboard endpoint goes through `lib/access.js` ownership checks and answers 404 for others' data**. Limits: 10 projects/user, sign-up 5/IP/hour, login 10/account+IP and 50/IP per 15 min (`lib/rateLimit.js` generic `consume`). Cross-site Origin check on writes. Disabled owner → projects get `disabled: true` → ingestion 403. Admins manage accounts (`api/admin.js`) but can't read others' issues.
- **First admin:** no admin-email env var on purpose (no email verification → takeover risk). User signs up, then `npm run make-admin -- email` (`scripts/make-admin.js`, uses `.env.local` DB) promotes them and gives them all ownerless (pre-accounts) projects. **Not yet done on production:** after deploying, the user must sign up and run it; until then the old projects (e.g. "Web demo") are invisible but still ingest. Remove `DASHBOARD_PASSWORD` from Vercel.
- **Vercel Hobby = max 12 functions;** backend has 10 (`auth/*` merged into `api/auth.js` for this). Check before adding endpoint files.
- `vercel.json` sets a strict CSP (script-src 'self', img-src self + res.cloudinary.com, style-src allows inline style attributes), HSTS, Permissions-Policy; `dev-server.js` applies the same headers (minus HSTS).
- **Grouping:** `lib/grouping.js` fingerprint = event type + error type + normalized message + top-frame function and file (build hashes stripped). Resolved issues reopen on regression. TTL: events 30 days, issues 90 days.
- The Atlas user can't `dropDatabase`, so tests drop collections instead. Integration tests use a `monitor_test_<random>` database.
- Commands: `npm run dev` (port 4000), `npm test` (53 tests), `npm run make-admin -- <email>`. Deploy steps are in `project/backend/README.md` (Root Directory `project/backend`, preset Other, env vars, Atlas network access `0.0.0.0/0`).
- Verified 2026-10-17: the demo app sent 69 events, grouped into 27 issues. The dashboard was checked in headless Chrome (login, filters, search, resolve/reopen, screenshots, phone layout).
- **Dashboard design (2026-10-18):** monochrome monospace look (sidebar + grid panels, light/dark toggle stored in `localStorage["et_theme"]`, `public/theme.js` sets it before paint). Default route `#/dashboard` shows charts (inline SVG, no chart library) fed by `GET /api/stats?range=24h|7d&projectId=` (`lib/stats.js`). Tests: 29. **Data cache (hand-written SWR in `public/app.js`, no packages, chosen over SWR/TanStack Query):** `cachedGet()` returns cached data at once and revalidates in the background after 10 s, shares in-flight requests, clears everything after any non-GET call, redraws quietly only when data changed (`softRender`, skipped while typing / forms open), prefetches issues on hover, delays the spinner 150 ms, and re-checks the login session only every 60 s.
- **Deleting (2026-10-18):** dashboard can delete one issue, selected issues, all issues by status, or a whole project (`lib/deletion.js`, `DELETE` on `api/issue.js`, `api/issues.js`, `api/projects.js`). Events go with their issues; Cloudinary images stay.
- **Deployed:** https://monitoringsystem-backend.vercel.app (Vercel project, Root Directory `project/backend`). `vercel.json` sets `framework: null` and `.vercelignore` excludes `dev-server.js`, otherwise Vercel treated it as the app and every route crashed.
- **Dashboard UI for accounts (2026-10-19):** `#/login`, `#/signup` (split layout with product intro, inline field errors, show/hide password, strength meter), `#/account` (profile, password, log out others, delete account), `#/admin` (KPIs + users table, disable/enable, make/remove admin, delete with type-to-confirm). Native `confirm()` replaced by `openDialog()` (`<dialog>`, async `onConfirm` keeps it open on errors) and `toast()`. Verified in headless Chrome (both themes, 1440 px and 390 px, no CSP errors or overflow) against a throwaway `monitor_uitest_*` database.
- Not yet: Cloudinary image cleanup (needs API secret), email verification / password reset, and the iOS/Android SDKs sending here.

## Demo app: `project/web/`
A basic Next.js 15 (App Router, plain JS) app that uses the JS SDK through `file:../../error-tracking-sdk/js`. `node_modules` symlinks to the SDK folder, so after an SDK change: run `npm run build` in the SDK, then restart `npm run dev` (delete `.next/` if the change doesn't show up).
- Sends to the backend: `.env.local` has the "Web demo" project key and `NEXT_PUBLIC_ET_ENDPOINT` / `ET_SERVER_ENDPOINT` = `http://localhost:4000/api/v1/events`. The user edits this app too (blue background, a `/wrong_path` link), so don't overwrite their changes.
- **Browser:** the SDK is initialized in `instrumentation-client.js`, which runs before React hydrates, so first-render and hydration errors are caught. `app/error.js` reports page render crashes, and `app/global-error.js` reports root-layout crashes. `app/not-found.js` calls `capturePageNotFound()`; the home page has an `<a href="/abouts">` typo link (full page load → automatic detection). In the production build Next hard-navigates the `<Link href="/wrong_path">` too, so it is also caught automatically.
- **Server:** `instrumentation.js` → `onRequestError` → `lib/serverErrors.js` sends API-route, server-component and SSR errors through the SDK in Node, with `context.source: "server"`.
- The home page has a button for every scenario. Other demo pages: `/hydration`, `/csp` (report-only CSP header from `next.config.mjs`, plus a broken `<img>` in the server HTML), `/server-error`.
- APIs: `/api/products`, `/api/slow` (2.5 s), `/api/fail` (500), `/api/bad-json`, `/api/crash` (server throw).
- **Viewing errors:** in the backend dashboard (local http://localhost:4000 or the Vercel URL). The old `/issues` page, `lib/issueStore.js` (`localStorage["web_issues"]`) and the `/api/events` local receiver were removed on 2026-10-18. The server SDK uses `ET_SERVER_ENDPOINT`, falling back to `NEXT_PUBLIC_ET_ENDPOINT`.
- **Real-browser check:** build with `NEXT_DIST_DIR=.next-test npx next build` (a separate folder, so it doesn't clash with `npm run dev`), then drive headless Chrome (installed at `C:/Program Files/Google/Chrome/Application/chrome.exe`) over the DevTools protocol with a throwaway `--user-data-dir`. Done 2026-10-17: every scenario produced exactly one event in Chrome.

## Next steps
1. Confirm with the user/backend: the extra payload fields, the batch body format, and the throttling numbers.
2. Build the Android SDK (spec in docs/SPEC.md), or iOS, whichever the user picks.
3. Then the "test scenarios" suite from the spec, for each SDK.
4. JS: checked in real Chrome (headless); Safari and Firefox are still unchecked. Long Tasks, ReportingObserver and Resource Timing status are Chromium-only there.
