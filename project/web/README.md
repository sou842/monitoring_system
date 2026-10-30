# Error Tracker — Web app (dashboard + API + SDK demo)

One Next.js 15 app (App Router, TypeScript, Tailwind CSS v4) that:

- **receives events** from the error-tracking SDKs (JS now; iOS and Android later) at `POST /api/v1/events`, groups them into issues and stores them in MongoDB;
- serves the **multi-user dashboard** (sign up, projects, issues, performance, admin);
- hosts the **SDK demo pages** under `/demo`, which break things on purpose so the SDK has something to report.

It replaced `project/backend/` (plain Vercel functions + a vanilla-JS dashboard) on 2026-10-30. The API URLs and responses did not change, so SDKs keep working against the same endpoint.

## Run locally

```bash
cp .env.example .env.local   # fill in the values (see "Configuration")
npm install
npm run dev                  # http://localhost:3000
npm run typecheck            # app + tests
npm test                     # unit + integration tests (node:test)
```

The demo pages use the local SDK (`file:../../error-tracking-sdk/js`): after an SDK change, run `npm run build` in the SDK, then restart `npm run dev` (delete `.next/` if the change doesn't show).

Integration tests use a throwaway database (`monitor_test_<random>`) on `MONGODB_URI` and drop its collections afterwards; they are skipped without `MONGODB_URI`. Any MongoDB works, e.g. a local `mongod`:

```bash
mongod --dbpath <empty folder> --port 27099
MONGODB_URI=mongodb://127.0.0.1:27099 npm test
```

Open http://localhost:3000, **create an account**, create a project to get an API key, then point an app at it:

```js
import ErrorTracker from '@sourav732/error-tracker-js';

ErrorTracker.init({
  apiKey: 'et_…',                                      // from the dashboard
  endpoint: 'https://<this app>/api/v1/events',
});
```

### Make yourself admin

There is no admin email setting on purpose: without email verification, a stranger could sign up with that address first. Instead, sign up, then run with `.env.local` pointing at the **same database** the site uses:

```bash
npm run make-admin -- you@example.com
```

It also gives your account every project that has no owner yet (projects created before accounts existed). Reload to see the **Admin** link.

## Configuration

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string. |
| `MONGODB_DB` | Database name (default `monitor`). |
| `SESSION_SECRET` | Long random string that signs login cookies. Changing it logs everyone out. |
| `NEXT_PUBLIC_ET_API_KEY` | Optional: a project key, so the app reports its own errors (dashboard and `/demo`). |
| `NEXT_PUBLIC_ET_ENDPOINT`, `ET_SERVER_ENDPOINT` | Optional: where the app's own SDK sends. Unset = this app (`/api/v1/events`). `NEXT_PUBLIC_*` values are baked in at build time. |

Limits (in `server/constants.ts`): no limit on projects per user or on errors per project (both `null`), 150 events and 150 page views per IP per project per minute, 1000 page views per project per minute, passwords 8–128 characters, 5 sign-ups per IP per hour, 10 login attempts per account and 50 per IP per 15 minutes.

## Deploy to Vercel

The existing Vercel project (https://monitoringsystem-backend.vercel.app) is reused, so SDK endpoints don't change:

1. **Vercel → Project → Settings → Build and Deployment:** Root Directory `project/web`, Framework Preset **Next.js** (build/output settings: defaults). Keep "Include files outside the root directory" on (the demo uses the SDK from `error-tracking-sdk/js`, see below).
2. **Environment Variables:** the same `MONGODB_URI`, `MONGODB_DB`, `SESSION_SECRET` as before. Optionally `NEXT_PUBLIC_ET_API_KEY` (a project key) so the app monitors itself. Remove `DASHBOARD_PASSWORD` if it is still there.
3. Deploy, then check `https://<app>/api/health` → `{"ok":true,"database":"up"}`.
4. MongoDB Atlas → Network Access must allow `0.0.0.0/0` (Vercel has no fixed IPs).

Old dashboard links (`/#/i/<issue>`, `/#/p/<project>`, …) are redirected to the new pages, and the old demo paths (`/products`, `/blank`, …) to `/demo/…`.

## Layout

```
app/
  (auth)/login, (auth)/signup      public pages
  (dashboard)/…                    logged-in pages; layout.tsx checks the session server-side
    dashboard, performance, projects, projects/[id], issues/[id], account, admin
  api/v1/events/route.ts           SDK ingestion
  api/{auth,account,admin,projects,issues,issue,event,stats,health}/route.ts
  api/demo/…                       fake APIs for the demo pages
  demo/…                           SDK demo pages (plain look, no enforced CSP)
  page.tsx                         "/" → dashboard (translates old #/ links)
server/        server-only logic: db, auth, passwords, users, access (ownership), validate,
               grouping, ingest, performance (pure) + performanceStats (queries), rate limits…
  routes/      the API handlers (Web Request → Response); app/api/*/route.ts re-export them
lib/           shared with the browser: schema + API types, insights (issue summaries), format
  client/api.ts  fetch wrapper + useApi(): stale-while-revalidate cache, no packages
components/    React UI: ui/ (kit), dashboard/ (shell, views), auth/, demo/
middleware.ts  per-request CSP nonce, login redirect
tests/         node:test suites (run on Node's built-in TypeScript support)
scripts/       make-admin.ts
```

Server code imports with explicit `.ts` extensions so `node --test` and the scripts run it directly; app code uses the `@/` alias.

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/events` | `X-API-Key` | Ingest `{ events: [...] }` (max 50 events, 4 MB). CORS open to any origin; a project with **allowed origins** refuses other browser origins with `403 origin_not_allowed` (CORS headers kept). Returns `202 { accepted, rejected }`. `429 rate_limited_ip` over 150 events/min per IP and project; 403 when the owner's account is disabled. Page views (`transaction` events) have their own budgets and are rejected as `rate_limited` (not retried) when over them. |
| `GET /api/health` | none | Database status, for uptime monitors. |
| `GET /api/auth` · `POST /api/auth?action=signup\|login\|logout` | – | Session / create an account / log in / log out (HttpOnly, SameSite=Strict cookie, 7 days). |
| `GET\|PATCH /api/account` · `POST /api/account?action=logout-others` · `DELETE /api/account` | session | Profile and usage / rename or change password / end other sessions / delete the account (body `{ password }`). |
| `GET\|POST /api/projects` · `POST /api/projects?id=…&action=rotate-key` | session | Your projects / create one / replace its key. The key is returned **once**. |
| `PATCH /api/projects?id=…` | session | `{ allowedOrigins: [...] }` and/or `{ insights: { libraryPaths, hiddenFrames, hints } }`. Nothing is saved if either is invalid. |
| `DELETE /api/projects?id=…` | session | Delete a project with its issues, events and key. |
| `GET /api/issues?projectId=…&status=&type=&env=&q=&sort=&page=` | session | Issue list; `q` also matches an API call `_id` (`matchedEventId` per row). |
| `DELETE /api/issues?projectId=…` | session | Body `{ ids: [...] }` (max 500), or `&status=open\|resolved\|ignored\|all`. |
| `GET\|PATCH\|DELETE /api/issue?id=…` | session | Issue with its latest events and the project's insight settings / set `status` / delete. |
| `GET /api/event?id=…` | session | One event in full. |
| `GET /api/stats?range=24h\|7d&projectId=` | session | Dashboard charts. |
| `GET /api/stats?view=performance&range=&projectId=&environment=[&endpoint=\|&page=]` | session | Web Vitals, latency, pages and endpoints; one endpoint or route with its slowest samples. |
| `GET /api/admin?q=` · `PATCH\|DELETE /api/admin?id=…` | admin | Accounts and totals / `{ status }` or `{ role }` / delete a user. Not on your own account. |

Every dashboard endpoint only returns or changes data in projects you own; anything else answers **404**.

## How it works

- **Validation:** every event is checked against the shared schema (`lib/schema.ts`, `server/validate.ts`) and cleaned: strings truncated, arrays capped, unsafe keys renamed, unknown fields dropped (no screen captures can be stored). Only an unknown `event_type` or a missing `sdk.name` rejects an event.
- **Grouping:** fingerprint = event type + error type + normalized message + top frame (function and file, build hashes stripped). A resolved issue that happens again reopens as *regressed*.
- **Performance:** `transaction` events never become issues; they are stored for 7 days ("slowest samples") and added to hourly rollups with logarithmic latency histograms (90 days).
- **Retention:** TTL indexes delete events after 30 days, issues unseen for 90 days, page views after 7 days, rollups after 90.
- **Security:** scrypt password hashes; signed session cookie re-checked against the user on every request; cross-site writes refused; API keys stored as SHA-256 hashes; per-project allowed origins; strict CSP with a per-request nonce (`middleware.ts`) plus HSTS, `X-Frame-Options: DENY`, `nosniff` and a restrictive `Permissions-Policy` (`next.config.ts`). Event data is rendered as text by React, never as HTML.
- **Dashboard data:** `useApi()` shows cached data at once, refreshes it in the background after 10 s, shares in-flight requests, and refreshes what is on screen after any change.
