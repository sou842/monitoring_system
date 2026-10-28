# Error Tracker — Backend & Dashboard

Receives events from the error-tracking SDKs (JS now; iOS and Android later), groups them into issues, stores them in MongoDB, and shows everything in a multi-user dashboard.

- **Accounts:** anyone can sign up. Each user creates their own projects and only ever sees their own data. Admins manage accounts.
- **Runtime:** plain Vercel serverless functions (`api/`) plus a static dashboard (`public/`). No framework.
- **Dependencies:** only the official `mongodb` driver. Passwords are hashed with Node's built-in `scrypt`. Tests use Node's built-in test runner.
- **Storage:** MongoDB Atlas for users, projects, issues and events.

## Run locally

```bash
cp .env.example .env.local   # fill in the values (see "Configuration")
npm install
npm run dev                  # http://localhost:4000
npm test                     # unit + integration tests
```

Integration tests use a throwaway database (`monitor_test_<random>`) on the configured cluster and remove its collections afterwards.

Open http://localhost:4000, **create an account**, create a project to get an API key, then point an app at the backend:

```js
import ErrorTracker from '@sourav732/error-tracker-js';

ErrorTracker.init({
  apiKey: 'et_…',                                     // from the dashboard
  endpoint: 'http://localhost:4000/api/v1/events',   // or your Vercel URL
});
```

### Make yourself admin

Admins see every account (not their data) and can disable, delete or promote users. There is no admin email setting on purpose: without email verification, a stranger could sign up with that address first. Instead:

1. Sign up in the dashboard with your own email.
2. Run, with `.env.local` pointing at the **same database** the site uses:

   ```bash
   npm run make-admin -- you@example.com
   ```

The script also gives your account every project that has no owner yet, i.e. projects created before accounts existed. Until then those projects keep accepting events, but nobody can see them. Log out and in again, or reload, to see the **Admin** link.

## Configuration

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas connection string. |
| `MONGODB_DB` | Database name (default `monitor`). |
| `SESSION_SECRET` | Long random string that signs login cookies. Changing it logs everyone out. |

Limits (in `lib/constants.js`): no limit on projects per user or on errors per project (both constants are `null`; set a number to turn one back on), 150 events and 150 page views per IP per project per minute, 1000 page views per project per minute, passwords 8–128 characters, 5 sign-ups per IP per hour, and 10 login attempts per account and 50 per IP per 15 minutes.

## Deploy to Vercel

1. **MongoDB Atlas → Network Access:** allow `0.0.0.0/0`. Vercel functions don't have fixed IP addresses, so the connection string and password are what protect the database. Use a dedicated database user with `readWrite` on this database only.
2. **Vercel → Add New Project →** import the GitHub repo, then set:
   - **Root Directory:** `project/backend`
   - **Framework Preset:** Other (no build command needed)
3. **Settings → Environment Variables:** add every variable from the table above. Use a new, long `SESSION_SECRET` for production; don't reuse the local one.
4. Deploy. Check `https://<your-app>.vercel.app/api/health`, which should return `{"ok":true,"database":"up"}`.
5. Sign up on the site, then run `npm run make-admin -- you@example.com` locally against the production database (see above).
6. In each app, set the SDK `endpoint` to `https://<your-app>.vercel.app/api/v1/events`.
7. For each browser project, open it in the dashboard → **Allowed origins** and add every origin the app runs on, e.g. `http://localhost:3000` and `https://myapp.com`. Until you do, any website can send events with the key.

**Upgrading from the shared-password version:** existing API keys keep working and no data is lost. After deploying, everyone is logged out (the old cookie format is no longer accepted). Sign up, run `make-admin` to take over the existing projects, and remove the old `DASHBOARD_PASSWORD` variable from Vercel.

The deployment uses 10 serverless functions, within the Hobby plan's limit of 12. Auth is a single function (`api/auth.js`) for that reason.

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/events` | `X-API-Key` | Ingest `{ events: [...] }` (max 50 events, 4 MB). CORS open to any origin; a project with **allowed origins** refuses other browser origins with `403 origin_not_allowed` (CORS headers kept, so the SDK drops instead of retrying). Returns `202 { accepted, rejected }`. 429 `rate_limited_ip` when one IP sends over 150 events/min to a project (there is no per-project error limit), 403 when the owner's account is disabled. Page views (`transaction` events) have their own budgets (150/min per IP, 1000/min per project); over them they are rejected as `rate_limited` (not retried), while errors in the same batch are still stored. |
| `GET /api/health` | none | Database status, for uptime monitors. |
| `GET /api/auth` | – | `{ authenticated, user }`. |
| `POST /api/auth?action=signup` · `?action=login` · `?action=logout` | – | Create an account `{ name, email, password }` / log in `{ email, password }` / log out. Sets an HttpOnly, SameSite=Strict cookie (7 days). |
| `GET /api/account` · `PATCH /api/account` | session | Your profile and project usage / change `{ name }` or `{ currentPassword, newPassword }` (logs out your other sessions). |
| `POST /api/account?action=logout-others` · `DELETE /api/account` | session | End your other sessions / delete your account and all its projects (body `{ password }`). |
| `GET /api/projects` · `POST /api/projects` | session | Your projects / create one. Creating returns the API key **once**. |
| `POST /api/projects?id=…&action=rotate-key` | session | Replace a project's key. |
| `PATCH /api/projects?id=…` | session | Body `{ "allowedOrigins": ["https://myapp.com", "http://localhost:3000"] }` replaces the project's allowed origins (max 20; `[]` = any origin). Entries are normalized to scheme + host + port; `400 invalid_origins` lists each bad entry in `error.details`. Body `{ "insights": { "libraryPaths": [], "hiddenFrames": [], "hints": [{ "match": "…", "text": "…" }] } }` replaces the issue-insight settings (max 50 per list; `400 invalid_insights`). Both may be sent together; nothing is saved if either is invalid. |
| `GET /api/issues?projectId=…&status=&type=&env=&q=&sort=&page=` | session | Issue list with filters. |
| `GET /api/issue?id=…` · `PATCH /api/issue?id=…` | session | Issue with its latest events and the project's insight settings / set `status` (open, resolved, ignored). |
| `GET /api/event?id=…` | session | One event in full. |
| `GET /api/stats?range=24h\|7d&projectId=` | session | Dashboard charts for your projects (or one of them). |
| `GET /api/stats?view=performance&range=&projectId=&environment=` | session | Web Vitals (p75 + rating), request latency per bucket, and the pages and endpoints tables. Add `&endpoint=<key>` or `&page=<route>` for one endpoint or route over time, with its slowest recent samples. |
| `DELETE /api/issue?id=…` | session | Delete an issue and all its events. |
| `DELETE /api/issues?projectId=…` | session | With body `{ "ids": [...] }` (max 500) deletes those issues; with `&status=open\|resolved\|ignored\|all` deletes every issue with that status. Events go too. |
| `DELETE /api/projects?id=…` | session | Delete a project, its issues, events and API key. |
| `GET /api/admin?q=` | admin | Totals and all accounts with project/event counts. |
| `PATCH /api/admin?id=…` · `DELETE /api/admin?id=…` | admin | `{ status: "active" \| "disabled" }` or `{ role: "user" \| "admin" }` / delete a user and their projects. Not allowed on your own account. |

Every dashboard endpoint only returns or changes data in projects you own. Anything else answers **404**, so ids of other users' projects aren't even confirmed to exist.

## How it works

- **Validation:** every event is checked against the shared payload schema and cleaned. Strings are truncated, arrays capped, and unsafe keys renamed. Bad fields become `null`; only events with an unknown `event_type` or no `sdk.name` are rejected, individually.
- **Grouping:** fingerprint = event type + error type + normalized message (IDs, long numbers, durations and query strings removed) + top stack frame (function and file, with build hashes stripped). The same bug stays one issue across deploys and environments.
- **Regressions:** a resolved issue that happens again is reopened and marked *regressed*.
- **API keys:** only a SHA-256 hash is stored. A browser app's key is public (it ships in the page), so it can only send events, never read data.
- **Allowed origins** (`lib/origins.js`): per project, exact scheme + host + port, no wildcards. Empty list = any origin. Requests without an `Origin` header (server-side SDKs, mobile apps) are always accepted, since browsers always send one on cross-origin requests. This stops other websites from using a copied key through their visitors' browsers; a script outside a browser can fake the header, which the per-IP limit covers. Changes reach other serverless instances within a minute (key cache).
- **Performance:** `transaction` events (one per page view, SDK 0.5.0+) never become issues. Each is stored in `transactions` (kept 7 days, for "slowest samples") and added to hourly rollups in `perf_rollups` (kept 90 days): one row per project, hour, environment and page route or endpoint, with counts and a logarithmic latency histogram (1.15× steps, so percentiles are within ~7%). Percentiles for any range come from adding histograms, so storage stays small however much traffic there is. IDs in paths are grouped (`/orders/42` → `/orders/{id}`), and timings measured while the tab was hidden are counted but kept out of histograms. Logic: `lib/performance.js` (pure, unit-tested) and `lib/performanceStats.js` (queries).
- **Retention:** MongoDB TTL indexes delete events after 30 days, issues not seen for 90 days, page views after 7 days and performance rollups after 90.

### Accounts and security

- **Passwords:** scrypt (N=16384, r=8, p=1) with a random salt per user. The cost settings are stored with each hash, so they can be raised later. Logins with an unknown email take as long as wrong passwords, and both get the same message.
- **Sessions:** a signed, HttpOnly, SameSite=Strict cookie holding the user id and a session version. Every request re-reads the user, so disabling an account, changing a password or "log out other devices" ends the old sessions immediately.
- **Cross-site requests:** state-changing requests whose `Origin` is another site are refused (on top of SameSite cookies).
- **Rate limits:** sign-ups per IP, login attempts per account and per IP, and ingestion per project + IP (150 events and 150 page views per minute, IPv6 per /64; errors have no per-project limit, so this is what stops one source flooding a project), counted in MongoDB so they hold across serverless instances.
- **Disabled accounts:** can't log in, are logged out everywhere, and their projects answer 403 to new events. Other serverless instances may accept events for up to a minute (key cache).
- **Headers:** a strict Content-Security-Policy (scripts only from this site, images only from this site and inline `data:` icons), HSTS, `X-Frame-Options: DENY`, `nosniff`, and a restrictive `Permissions-Policy` (`vercel.json`; the dev server sends the same).
- **Rendering:** the dashboard renders all event data as text (never HTML), so a malicious error message can't run script in the dashboard.
- **No email yet:** there is no email verification or "forgot password". An admin can delete a locked-out account, and the user can sign up again.

## Layout

```
api/              serverless functions (Vercel routes = file paths)
  v1/events.js    ingestion
  auth.js         sign up / log in / log out / session
  account.js      your profile, password, sessions, account deletion
  admin.js        accounts (admins only)
  projects.js, issues.js, issue.js, event.js, stats.js, health.js
lib/              shared logic: db, validation, grouping, ingest, auth, passwords,
                  users, access (ownership checks), rate limits
public/           dashboard (index.html, app.js, styles.css)
scripts/          make-admin.js
dev-server.js     local server that mimics Vercel's routing and headers
tests/            node:test unit + integration tests
```
