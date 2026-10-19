# Error Tracker — Backend & Dashboard

Receives events from the error-tracking SDKs (JS now; iOS and Android later), groups them into issues, stores them in MongoDB, stores screenshots in Cloudinary, and shows everything in a multi-user dashboard.

- **Accounts:** anyone can sign up. Each user creates their own projects and only ever sees their own data. Admins manage accounts.
- **Runtime:** plain Vercel serverless functions (`api/`) plus a static dashboard (`public/`). No framework.
- **Dependencies:** only the official `mongodb` driver. Passwords are hashed with Node's built-in `scrypt`. Tests use Node's built-in test runner.
- **Storage:** MongoDB Atlas for users, projects, issues and events. Cloudinary for screenshots.

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
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud for screenshots. |
| `CLOUDINARY_UPLOAD_PRESET` | An **unsigned** upload preset. |
| `SESSION_SECRET` | Long random string that signs login cookies. Changing it logs everyone out. |

Limits (in `lib/constants.js`): 10 projects per user, 1000 events per project per minute, passwords 8–128 characters, 5 sign-ups per IP per hour, and 10 login attempts per account and 50 per IP per 15 minutes.

## Deploy to Vercel

1. **MongoDB Atlas → Network Access:** allow `0.0.0.0/0`. Vercel functions don't have fixed IP addresses, so the connection string and password are what protect the database. Use a dedicated database user with `readWrite` on this database only.
2. **Vercel → Add New Project →** import the GitHub repo, then set:
   - **Root Directory:** `project/backend`
   - **Framework Preset:** Other (no build command needed)
3. **Settings → Environment Variables:** add every variable from the table above. Use a new, long `SESSION_SECRET` for production; don't reuse the local one.
4. Deploy. Check `https://<your-app>.vercel.app/api/health`, which should return `{"ok":true,"database":"up"}`.
5. Sign up on the site, then run `npm run make-admin -- you@example.com` locally against the production database (see above).
6. In each app, set the SDK `endpoint` to `https://<your-app>.vercel.app/api/v1/events`.

**Upgrading from the shared-password version:** existing API keys keep working and no data is lost. After deploying, everyone is logged out (the old cookie format is no longer accepted). Sign up, run `make-admin` to take over the existing projects, and remove the old `DASHBOARD_PASSWORD` variable from Vercel.

The deployment uses 10 serverless functions, within the Hobby plan's limit of 12. Auth is a single function (`api/auth.js`) for that reason.

Optional, recommended: in Cloudinary → Settings → Upload presets → your preset, add an **incoming transformation** such as `c_limit,w_1280/q_auto:low`, as a second compression layer on top of the SDK's own.

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/events` | `X-API-Key` | Ingest `{ events: [...] }` (max 50 events, 4 MB). CORS open to any origin. Returns `202 { accepted, rejected }`. 429 when over 1000 events/min per project, 403 when the owner's account is disabled. |
| `GET /api/health` | none | Database status, for uptime monitors. |
| `GET /api/auth` | – | `{ authenticated, user }`. |
| `POST /api/auth?action=signup` · `?action=login` · `?action=logout` | – | Create an account `{ name, email, password }` / log in `{ email, password }` / log out. Sets an HttpOnly, SameSite=Strict cookie (7 days). |
| `GET /api/account` · `PATCH /api/account` | session | Your profile and project usage / change `{ name }` or `{ currentPassword, newPassword }` (logs out your other sessions). |
| `POST /api/account?action=logout-others` · `DELETE /api/account` | session | End your other sessions / delete your account and all its projects (body `{ password }`). |
| `GET /api/projects` · `POST /api/projects` | session | Your projects / create one. Creating returns the API key **once**. |
| `POST /api/projects?id=…&action=rotate-key` | session | Replace a project's key. |
| `GET /api/issues?projectId=…&status=&type=&env=&q=&sort=&page=` | session | Issue list with filters. |
| `GET /api/issue?id=…` · `PATCH /api/issue?id=…` | session | Issue with its latest events / set `status` (open, resolved, ignored). |
| `GET /api/event?id=…` | session | One event in full. |
| `GET /api/stats?range=24h\|7d&projectId=` | session | Dashboard charts for your projects (or one of them). |
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
- **Screenshots:** uploaded to Cloudinary under `error-tracker/<projectId>/`. Images over 400 KB are refused rather than uploaded, so raw full-size images never reach Cloudinary (the SDK already sends ~50 KB JPEGs). The dashboard loads them through Cloudinary's low-quality, auto-format delivery.
- **API keys:** only a SHA-256 hash is stored.
- **Retention:** MongoDB TTL indexes delete events after 30 days and issues not seen for 90 days. Cloudinary images are not deleted automatically, nor when you delete issues, projects or accounts: that needs the Cloudinary API secret, and is a possible follow-up.

### Accounts and security

- **Passwords:** scrypt (N=16384, r=8, p=1) with a random salt per user. The cost settings are stored with each hash, so they can be raised later. Logins with an unknown email take as long as wrong passwords, and both get the same message.
- **Sessions:** a signed, HttpOnly, SameSite=Strict cookie holding the user id and a session version. Every request re-reads the user, so disabling an account, changing a password or "log out other devices" ends the old sessions immediately.
- **Cross-site requests:** state-changing requests whose `Origin` is another site are refused (on top of SameSite cookies).
- **Rate limits:** sign-ups per IP, and login attempts per account and per IP, counted in MongoDB so they hold across serverless instances.
- **Disabled accounts:** can't log in, are logged out everywhere, and their projects answer 403 to new events. Other serverless instances may accept events for up to a minute (key cache).
- **Headers:** a strict Content-Security-Policy (scripts only from this site, images only from here and Cloudinary), HSTS, `X-Frame-Options: DENY`, `nosniff`, and a restrictive `Permissions-Policy` (`vercel.json`; the dev server sends the same).
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
                  users, access (ownership checks), rate limits, cloudinary
public/           dashboard (index.html, app.js, styles.css)
scripts/          make-admin.js
dev-server.js     local server that mimics Vercel's routing and headers
tests/            node:test unit + integration tests
```
