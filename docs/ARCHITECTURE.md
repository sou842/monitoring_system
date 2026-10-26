# Architecture

How the in-house error tracker fits together: client SDKs in the apps, one ingestion API, MongoDB, and a dashboard.
For the wire format and the technical rules behind each part, see [PROTOCOL.md](PROTOCOL.md). For the original requirements, see [SPEC.md](SPEC.md).

Diagrams are written in [Mermaid](https://mermaid.js.org/) (GitHub and VS Code render them).

---

## 1. System overview

```mermaid
flowchart LR
    subgraph Clients["Client apps"]
        WEB["Web app<br/>(browser)<br/>JS SDK"]
        NODE["Next.js server<br/>(Node)<br/>JS SDK, captureError only"]
        IOS["iOS app<br/>iOS SDK ⏳"]
        AND["Android app<br/>Android SDK ⏳"]
    end

    subgraph Vercel["Vercel (project/backend)"]
        ING["POST /api/v1/events<br/>ingestion"]
        DASHAPI["Dashboard API<br/>auth · account · admin · projects<br/>issues · issue · event · stats · health"]
        STATIC["Static dashboard<br/>public/ (vanilla JS)"]
    end

    subgraph Storage
        MONGO[("MongoDB Atlas<br/>db: monitor")]
        CLD[("Cloudinary<br/>screenshots")]
    end

    USER(["Developer<br/>(browser)"])

    WEB -- "JSON batch<br/>X-API-Key" --> ING
    NODE -- "JSON batch<br/>X-API-Key" --> ING
    IOS -. "same schema" .-> ING
    AND -. "same schema" .-> ING

    ING -- "validate, group, store" --> MONGO
    ING -- "upload compressed JPEG" --> CLD

    USER -- "HTTPS + session cookie" --> STATIC
    STATIC -- "fetch /api/*" --> DASHAPI
    DASHAPI --> MONGO
    USER -. "loads images" .-> CLD
```

| Part | Path | Stack | Status |
| --- | --- | --- | --- |
| JS SDK | `error-tracking-sdk/js/` | TypeScript → ES5, Rollup (ESM + CJS), zero runtime deps | ✅ 0.6.1 |
| iOS SDK | `error-tracking-sdk/ios/` | Swift 5.5+, iOS 14+ | ⏳ not started |
| Android SDK | `error-tracking-sdk/android/` | Kotlin 1.8+, API 21+ | ⏳ not started |
| Backend + dashboard | `project/backend/` | Vercel functions (plain JS, ES modules), only dependency `mongodb` | ✅ deployed |
| Demo app | `project/web/` | Next.js 15 (App Router) using the JS SDK | ✅ |

---

## 2. JS SDK internals

```mermaid
flowchart TB
    subgraph API["Public API (src/index.ts)"]
        INIT["init()"]
        CAP["captureError / captureMessage /<br/>capturePageNotFound"]
        CTX["setUser / addBreadcrumb"]
        FL["flush / close"]
    end

    subgraph COL["Collectors (src/collectors/)"]
        direction TB
        NI["networkInterceptor<br/>(single fetch + XHR wrap)"]
        ERR["error<br/>window.onerror, unhandledrejection"]
        HTTP["httpError<br/>HttpError, NetworkError"]
        JSONR["jsonResponse<br/>InvalidJsonResponse"]
        RES["resource / csp / worker"]
        PNF["pageNotFound"]
        PERF["performance<br/>SlowPageLoad, SlowApiCall (opt-in)"]
        RESP["responsiveness<br/>MainThreadBlocked, LowFrameRate"]
        MEM["memory<br/>MemoryLeakSuspected"]
        PV["pageView<br/>transaction events"]
        BC["breadcrumb<br/>clicks, navigation, api, console"]
    end

    subgraph CORE["Core pipeline (src/core/client.ts)"]
        direction LR
        S["sample"] --> D["dedup<br/>5 s"] --> RL["rate limit<br/>100/min"] --> B["payloadBuilder"] --> SS["screenshot<br/>(html2canvas)"] --> BS["beforeSend"] --> Q["eventQueue"]
    end

    subgraph TR["Transport (src/transport/)"]
        HT["httpTransport<br/>fetch, keepalive"]
        RT["retryManager<br/>1s / 2s / 4s"]
        OS["offlineStore<br/>localStorage _et_queue"]
    end

    NI --> HTTP & JSONR & PV & BC
    ERR & HTTP & JSONR & RES & PNF & PERF & RESP & MEM --> S
    CAP --> S
    PV -- "own limit 30/min,<br/>beforeSendTransaction" --> Q
    BC -. "ring buffer (30)" .-> B
    CTX -.-> B
    Q --> HT
    HT <--> RT
    Q <-- "offline / failed /<br/>page unload" --> OS
    HT -- "POST {events:[...]}" --> BACKEND[("Backend")]
```

Shared helpers in `core/`: `reportedErrors` (one failure, one event), `visibility` (hidden-tab periods), `stackParser`, `serialize`, `device`, `safe` (wraps every SDK call so it can never throw into the host app), `logger` (silent unless `debug: true`).

Automatic collectors are only installed when `window` exists. In Node (Next.js `onRequestError`), only `captureError` is used.

---

## 3. Backend internals

```mermaid
flowchart TB
    subgraph Functions["api/ (10 Vercel functions, Hobby limit 12)"]
        EV["v1/events.js<br/>POST, OPTIONS (CORS *)"]
        AUTH["auth.js<br/>signup · login · logout"]
        ACC["account.js"]
        ADM["admin.js"]
        PRJ["projects.js"]
        ISS["issues.js / issue.js / event.js"]
        ST["stats.js<br/>dashboard + ?view=performance"]
        HE["health.js"]
    end

    subgraph Lib["lib/"]
        VAL["validate.js"]
        ING["ingest.js"]
        GRP["grouping.js<br/>fingerprint"]
        PERFL["performance.js<br/>rollups, histograms"]
        RLIM["rateLimit.js<br/>per project + per IP"]
        ORI["origins.js<br/>allowed origins"]
        CLDL["cloudinary.js"]
        AU["auth.js<br/>signed session cookie"]
        ACCESS["access.js<br/>ownership checks"]
        PW["passwords.js<br/>scrypt"]
        STATS["stats.js / performanceStats.js"]
        DEL["deletion.js"]
    end

    EV --> ORI
    EV --> RLIM --> ING
    PRJ --> ORI
    ING --> VAL
    ING --> GRP
    ING --> PERFL
    ING --> CLDL
    AUTH & ACC & ADM --> AU & PW & RLIM
    PRJ & ISS & ST --> AU --> ACCESS
    ST --> STATS
    ISS & PRJ --> DEL

    subgraph Mongo["MongoDB collections"]
        C1[("projects")]
        C2[("users")]
        C3[("issues<br/>TTL 90 d")]
        C4[("events<br/>TTL 30 d")]
        C5[("transactions<br/>TTL 7 d")]
        C6[("perf_rollups<br/>hourly, TTL 90 d")]
        C7[("rate_limits<br/>TTL")]
    end

    ING --> C3 & C4 & C5 & C6
    RLIM --> C7
    AU --> C2
    ACCESS --> C1
```

---

## 4. Event lifecycle (error event)

```mermaid
sequenceDiagram
    autonumber
    participant App as Host app
    participant SDK as JS SDK
    participant LS as localStorage
    participant API as POST /api/v1/events
    participant DB as MongoDB
    participant CL as Cloudinary

    App->>SDK: throws TypeError
    SDK->>SDK: sample → dedup → rate limit → build payload
    SDK->>SDK: screenshot, if enabled and unhandled (masked, ≤1280 px, JPEG 0.5)
    SDK->>SDK: beforeSend → queue (batch of 10 or 2 s)
    SDK->>API: POST { events: [...] }  X-API-Key
    alt network error / 5xx / 408 / 429
        API-->>SDK: failure
        SDK->>SDK: retry after 1 s, 2 s, 4 s
        SDK->>LS: still failing → persist (max 50, key removed)
    else other 4xx
        API-->>SDK: 400 / 401 / 403 (incl. origin_not_allowed) / 413
        SDK->>SDK: drop, no retry
    end
    API->>DB: look up project by SHA-256(API key)
    API->>API: Origin in the project's allowed origins? (else 403)
    API->>DB: consume per-IP budget (150/min; no per-project error limit)
    API->>API: validate each event (bad ones rejected individually)
    API->>CL: upload screenshot (≤400 KB)
    API->>DB: upsert issue by fingerprint (reopen if resolved)
    API->>DB: insert event (+ screenshot URL)
    API-->>SDK: 202 { accepted, rejected: [{index, reason}] }
```

Page views (`event_type: "transaction"`) take a different branch at the server: they never become issues. They are stored in `transactions` (for "slowest samples") and added to hourly `perf_rollups`, which feed the Performance view.

---

## 5. Dashboard access model

```mermaid
flowchart LR
    U["User"] -- "login" --> S["Signed cookie<br/>{userId, sessionVersion, expiry}"]
    S --> R["Every request:<br/>verify signature, re-read user"]
    R -- "disabled or version changed" --> X["401: logged out"]
    R -- "ok" --> O["access.js:<br/>project.ownerId == user?"]
    O -- "no" --> N["404 (not 403)"]
    O -- "yes" --> D["data"]
    A["Admin"] --> M["Manage accounts only<br/>(cannot read others' issues)"]
```

---

## 6. Deployment

```mermaid
flowchart LR
    GIT["Git repo"] --> VC["Vercel project<br/>Root Directory: project/backend<br/>framework: null"]
    VC --> URL["monitoringsystem-backend.vercel.app"]
    VC -- "MONGODB_URI, MONGODB_DB, SESSION_SECRET,<br/>CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET" --> ENV["Env vars"]
    URL --> ATLAS[("Atlas<br/>network access 0.0.0.0/0")]
    NPM["npm: @sourav732/error-tracker-js"] --> APPS["Client apps"]
    APPS --> URL
```

- The JS SDK ships on npm (or a CDN such as jsDelivr); the user publishes it from their own account.
- Locally, `project/backend/dev-server.js` (Node `http`) mimics Vercel routing on port 4000.
- The demo app (`project/web/`) links the SDK via `file:../../error-tracking-sdk/js` and sends to the deployed backend.
