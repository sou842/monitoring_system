# Performance and Resource Usage

What the error tracker costs: the JS SDK's cost inside a host app, the data it sends, and the storage the backend needs.
For how the parts fit together, see [ARCHITECTURE.md](ARCHITECTURE.md). For the wire format and limits, see [PROTOCOL.md](PROTOCOL.md).

All numbers were **measured on 2026-10-26** (JS SDK 0.6.2, backend at commit `b123e41`). Section 4 explains how. Treat them as orders of magnitude: real apps differ in page size, traffic and devices.

---

## 1. JS SDK cost inside the host app

### Download

| | Size |
| --- | --- |
| Minified (ESM or CJS) | 71 KB |
| **Gzipped** | **~20 KB** |
| Brotli | ~18 KB |
| html2canvas (screenshots only, loaded from cdnjs on first use) | ~45 KB gzipped, **never loaded unless screenshots are enabled** |

### Runtime, with default settings

Same test page with and without the SDK. "Phone" means Chrome with 4× CPU slowdown, which is roughly a mid-range Android phone.

| What | Desktop | Phone (4× slower) |
| --- | --- | --- |
| Loading the SDK script | 48 ms | 65 ms |
| Starting it (`init()`) | 2.4 ms | 12 ms |
| Page load time / first paint | No measurable change | No measurable change |
| Memory (JS heap) | +0.2–1 MB, flat after 600 requests | +0.2 MB |
| Background CPU while idle | +50 ms per minute (~0.08% of one core) | +0.4 s per minute (~0.6%) |
| Each `fetch` / XHR request | +0.3 ms | +5 ms typical, +28 ms at p95 |
| Each click | ~4 µs | ~0.09 ms |
| Reporting an error (`captureError`, synchronous part) | < 0.1 ms | 0.3 ms |

The SDK doesn't block the first paint: it loads as a module script and starts after the page renders. Its background work is a 1 s frame-rate sample every 30 s, a memory reading every 30 s, and a page-view check every 60 s.

### Screenshots (opt-in)

Screenshots are **off by default since 0.6.2** (`captureScreenshots: true` turns them on). When on, they're taken only for **unhandled** errors (`handled: false`), at most one every 10 s.

html2canvas copies and draws the page on the main thread, so **the page freezes while a screenshot renders**:

| Page with ~1,500 elements | Desktop | Phone (4× slower) |
| --- | --- | --- |
| Freeze per screenshot | **~0.35–0.4 s** | **~3–6 s** |
| First screenshot on a page | Slower: html2canvas downloads first, and can miss the 3 s time budget (the event is then sent without it) | Same |
| Screenshot size | ~34 KB (JPEG, quality 0.5) | ~34 KB |

Larger pages freeze for longer.

- **Lower render scale doesn't help.** A scale of 1, 0.75, 0.5 or 0.25 all took 3–4 s at 4× slowdown, because the cost is copying and laying out the DOM, not drawing pixels.
- **Skipping off-screen elements does help:** about 3× faster (~3.3 s → ~1 s at 4× slowdown) using html2canvas's `ignoreElements`. This is not built yet.
- **Known issue:** with screenshots on, a slow device's screenshot freeze (> 1 s) is reported as a false `MainThreadBlocked` event. At most one is sent per 30 s.

---

## 2. Data sent over the network

| Event | Size sent (JSON) |
| --- | --- |
| Error, no screenshot (few breadcrumbs) | ~1 KB |
| Error, typical (30 breadcrumbs, 15 stack frames) | ~5–8 KB |
| Error with screenshot | + ~35–50 KB (capped at ~370 KB) |
| Page view (`transaction`) | ~1 KB with no API calls, ~5 KB with 20 API calls, up to ~25 KB with 100 |

Events are batched (up to 10 per request, or every 2 s), so most users send only a few requests per page.

**SDK-side caps, per browser tab:**
- 100 errors per minute
- identical errors deduplicated within 5 s
- 30 page views per minute
- at most 50 events kept offline

---

## 3. Backend storage (MongoDB)

### Size of one stored item

Measured by sending realistic events through the backend's own ingest code into MongoDB. All sizes are **uncompressed**: the safe figure to compare against Atlas's 512 MB free tier. Paid tiers compress data on disk, so real disk use there is lower.

| Item | Typical | Largest the server accepts |
| --- | --- | --- |
| Error event (30 breadcrumbs, 15 frames) | **~8.5 KB** | ~240 KB |
| Raw page view (20 API calls) | **~7 KB** | ~31 KB (100 API calls) |
| Hourly performance summary row (one page or endpoint, one hour) | **~1–1.5 KB** | ~3 KB |
| Issue (one per grouped error) | ~1 KB | ~5 KB |
| Screenshot (Cloudinary, not MongoDB) | ~35–50 KB | 400 KB |

A page view costs more than its JSON size because every API call in it adds an index entry, used to find "slowest calls to this endpoint".

### How long data is kept (automatic deletion by MongoDB TTL indexes)

| Data | Kept for |
| --- | --- |
| Error events | 30 days |
| Issues | 90 days after last seen |
| Raw page views | 7 days |
| Hourly performance summaries | 90 days |
| Rate-limit counters | ~2 minutes |
| Screenshots in Cloudinary | **Forever** (no cleanup yet: needs the Cloudinary API secret) |

### Storage per project, by traffic

All numbers below are **per project** (one app). All projects share one database, so the totals add up across projects.

**Error events (30 days kept)**

| Errors per day | Kept | Size |
| --- | --- | --- |
| 100 | 3,000 | ~25 MB |
| 1,000 | 30,000 | ~255 MB |
| 10,000 | 300,000 | ~2.5 GB |
| Worst case: one IP at the per-IP limit (150/min non-stop) | ~6.5 million | ~55 GB (up to ~1.5 TB at maximum event size) |
| Worst case: many IPs | No limit | **No ceiling**: there is no per-project error limit |

**Raw page views (7 days kept)**

| Page views per day | Kept | Size |
| --- | --- | --- |
| 1,000 | 7,000 | ~50 MB |
| 10,000 | 70,000 | ~480 MB |
| 100,000 | 700,000 | ~4.8 GB |
| Worst case: per-project limit (1,000/min non-stop) | ~10 million | ~70 GB (up to ~310 GB at 100 API calls each) |

**Hourly performance summaries (90 days kept)**

These grow with the number of **different pages and API endpoints**, not with visits: each one gets a row for every hour it has traffic.

| App | Rows kept | Size |
| --- | --- | --- |
| Small (10 pages + 20 endpoints, traffic ~12 h a day) | ~32,000 | ~40 MB |
| Medium (50 pages + 100 endpoints, traffic all day) | ~320,000 | ~400 MB |
| Unique URLs (readable slugs like `/products/blue-shirt`, third-party APIs, fake traffic) | No limit | **No ceiling** |

**Screenshots (Cloudinary, never deleted)**

Only when an app enables screenshots, and only for unhandled errors.

| Unhandled errors with screenshots per day | Added per month | After 1 year |
| --- | --- | --- |
| 100 | ~150 MB | ~1.8 GB |
| 1,000 | ~1.5 GB | ~18 GB |

The Cloudinary free plan has about 25 GB of credits.

### Totals per project

| Scenario | MongoDB total | vs Atlas free tier (512 MB) |
| --- | --- | --- |
| Small app (100 errors/day, 1,000 page views/day, small) | ~115 MB | ✅ Fits |
| Medium app (1,000 errors/day, 10,000 page views/day, medium) | ~1.1 GB | ❌ ~2× too big |
| Large app (10,000 errors/day, 100,000 page views/day) | ~8 GB | ❌ Needs a paid tier |
| Attack or runaway bug | No limit | ❌ Fills any tier |

Users, projects and rate-limit counters together stay under 10 MB.

> **If MongoDB fills up, every project stops saving, errors included.**

### Ways to cap storage (not built yet)

| Measure | Effect |
| --- | --- |
| Store raw page views only when slow or failed, plus a small sample | Cuts raw page views by ~90%; charts unchanged |
| Cap distinct pages and endpoints per project per hour (the rest grouped as "Other") | Puts a ceiling on hourly summaries |
| Daily quota per project for errors and page views | Puts a ceiling on the attack case |
| Cloudinary cleanup (needs API secret) | Puts a ceiling on screenshots |
| Lower `performanceSampleRate` on busy apps (e.g. 0.1) | Page views and summaries shrink in proportion |

---

## 4. How these were measured

- **SDK cost:** headless Chrome over the DevTools protocol. The same test page (300 product cards, ~1,500 elements) was loaded with and without the SDK, and the results compared:
  - page load: medians of 12 fresh loads, cache disabled
  - CPU and memory: over a 65 s idle window, heap measured after forced garbage collection
  - requests: 300 sequential `fetch` and 300 XHR calls against a local server
  - clicks: 2,000 synthetic clicks
  - screenshots: Long Tasks API

  "Phone" runs used `Emulation.setCPUThrottlingRate(4)`.
- **Storage:** realistic events sent through the backend's `ingestEvents()` into a throwaway MongoDB (`mongodb-memory-server`). Sizes are from `collStats`. The in-memory engine doesn't report index sizes accurately, so those were estimated from the index definitions in `lib/db.js`.
- **Data sent:** the JSON size of each event as received by a fake ingest endpoint.

The scripts were throwaway: they lived in a scratchpad and are not in the repo. Re-measure after major SDK or schema changes.
