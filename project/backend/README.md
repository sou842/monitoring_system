# Error Tracker — Backend & Dashboard

Receives events from the error-tracking SDKs (JS now; iOS and Android later), groups them into issues, stores them in MongoDB, stores screenshots in Cloudinary, and shows everything in a password-protected dashboard.

- **Runtime:** plain Vercel serverless functions (`api/`) plus a static dashboard (`public/`). No framework.
- **Dependencies:** only the official `mongodb` driver. Tests use Node's built-in test runner.
- **Storage:** MongoDB Atlas for projects, issues and events. Cloudinary for screenshots.

## Run locally

```bash
cp .env.example .env.local   # fill in the values (see "Configuration")
npm install
npm run dev                  # http://localhost:4000
npm test                     # unit + integration tests
```

Integration tests use a throwaway database (`monitor_test_<random>`) on the configured cluster and remove its collections afterwards.

Open http://localhost:4000 and log in with `DASHBOARD_PASSWORD`. Create a project to get an API key, then point an app at the backend:

```js
import ErrorTracker from '@sourav732/error-tracker-js';

ErrorTracker.init({
  apiKey: 'et_…',                                     // from the dashboard
  endpoint: 'http://localhost:4000/api/v1/events',   // or your Vercel URL
});
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas connection string. |
| `MONGODB_DB` | Database name (default `monitor`). |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud for screenshots. |
| `CLOUDINARY_UPLOAD_PRESET` | An **unsigned** upload preset. |
| `DASHBOARD_PASSWORD` | Shared dashboard password. |
| `SESSION_SECRET` | Long random string that signs login cookies. Changing it logs everyone out. |

## Deploy to Vercel

1. **MongoDB Atlas → Network Access:** allow `0.0.0.0/0`. Vercel functions don't have fixed IP addresses, so the connection string and password are what protect the database. Use a dedicated database user with `readWrite` on this database only.
2. **Vercel → Add New Project →** import the GitHub repo, then set:
   - **Root Directory:** `project/backend`
   - **Framework Preset:** Other (no build command needed)
3. **Settings → Environment Variables:** add every variable from the table above. Use a new, long `DASHBOARD_PASSWORD` and `SESSION_SECRET` for production; don't reuse the local ones.
4. Deploy. Check `https://<your-app>.vercel.app/api/health`, which should return `{"ok":true,"database":"up"}`.
5. In each app, set the SDK `endpoint` to `https://<your-app>.vercel.app/api/v1/events`.

Optional, recommended: in Cloudinary → Settings → Upload presets → your preset, add an **incoming transformation** such as `c_limit,w_1280/q_auto:low`, as a second compression layer on top of the SDK's own.

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/events` | `X-API-Key` | Ingest `{ events: [...] }` (max 50 events, 4 MB). CORS open to any origin. Returns `202 { accepted, rejected }`. 429 when over 1000 events/min per project. |
| `GET /api/health` | none | Database status, for uptime monitors. |
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/session` | – | Dashboard session (HttpOnly cookie, 7 days). |
| `GET /api/projects` · `POST /api/projects` | session | List / create projects. Creating returns the API key **once**. |
| `POST /api/projects?id=…&action=rotate-key` | session | Replace a project's key. |
| `GET /api/issues?projectId=…&status=&type=&env=&q=&sort=&page=` | session | Issue list with filters. |
| `GET /api/issue?id=…` · `PATCH /api/issue?id=…` | session | Issue with its latest events / set `status` (open, resolved, ignored). |
| `GET /api/event?id=…` | session | One event in full. |

## How it works

- **Validation:** every event is checked against the shared payload schema and cleaned. Strings are truncated, arrays capped, and unsafe keys renamed. Bad fields become `null`; only events with an unknown `event_type` or no `sdk.name` are rejected, individually.
- **Grouping:** fingerprint = event type + error type + normalized message (IDs, long numbers, durations and query strings removed) + top stack frame (function and file, with build hashes stripped). The same bug stays one issue across deploys and environments.
- **Regressions:** a resolved issue that happens again is reopened and marked *regressed*.
- **Screenshots:** uploaded to Cloudinary under `error-tracker/<projectId>/`. Images over 400 KB are refused rather than uploaded, so raw full-size images never reach Cloudinary (the SDK already sends ~50 KB JPEGs). The dashboard loads them through Cloudinary's low-quality, auto-format delivery.
- **API keys:** only a SHA-256 hash is stored.
- **Retention:** MongoDB TTL indexes delete events after 30 days and issues not seen for 90 days. Cloudinary images are not deleted automatically: that needs the Cloudinary API secret, and is a possible follow-up.
- **Security:** the dashboard renders all event data as text (never HTML), so a malicious error message can't run script in the dashboard. Login failures are delayed by 1 s.

## Layout

```
api/            serverless functions (Vercel routes = file paths)
  v1/events.js  ingestion
  auth/         login / logout / session
  projects.js, issues.js, issue.js, event.js, health.js
lib/            shared logic: db, validation, grouping, ingest, auth, cloudinary, rate limit
public/         dashboard (index.html, app.js, styles.css)
dev-server.js   local server that mimics Vercel's routing
tests/          node:test unit + integration tests
```
