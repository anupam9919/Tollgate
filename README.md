# Tollgate

A standalone, networked rate-limiting service — not a library you `import`, a service other APIs call into. Built to learn shared state, atomicity, and correctness under concurrency, not just the algorithms.
---

## 1. Mental Model

| Concept | Analogy |
|---|---|
| Rate limiter | Tollbooth — every request pays a toll before passing |
| Token bucket | Water tank — tokens refill at a steady rate, requests drain it |
| Sliding window | A moving recording — old entries fall off the back as time passes |
| Headers (`X-RateLimit-*`) | Thermostat display — tells the client the state so it self-regulates instead of hammering blindly |
| Admin routes | The control panel — changes parameters without redeploying code |

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                     TOLLGATE SERVICE                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  DATA PLANE (check)                                           │
│  ───────────────────                                           │
│                                                                │
│   Client              GET /check/:clientId                     │
│     │                         │                                │
│     ├────────────────────────→ routes/check.ts                 │
│     │                         │                                │
│     │                         ├─→ Lua script (EVALSHA)         │
│     │                         │       ↓                        │
│     │                         │   Redis (state)                │
│     │                         │   ├─ bucket:{id} (hash)        │
│     │                         │   └─ sw:{id} (sorted set)      │
│     │                         │       ↓                        │
│     ├─────────────────────────┤ response + headers             │
│     │ (X-RateLimit-*, 200/429)│                                │
│                                                                │
│  CONTROL PLANE (admin)                                         │
│  ──────────────────────                                        │
│                                                                │
│   Operator        PUT|GET /admin/clients/:clientId             │
│     │                         │                                │
│     ├────────────────────────→ routes/admin.ts                 │
│     │                         │                                │
│     │                         ├─→ Redis (config)               │
│     │                         │   └─ config:{id} (string)      │
│     │                         │       ↓                        │
│     ├─────────────────────────┤ response                       │
│                                                                │
│  ★ Config changes take effect on next check (no restart)       │
│  ★ Two planes talk only through Redis (independent scaling)    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Data plane:** `check.ts` → Lua script → Redis state → response + headers.  
**Control plane:** `admin.ts` → Redis config → read by `check.ts` on next request.

These two planes only talk through Redis — `check.ts` never calls `admin.ts` directly. Config changes take effect on the *next* request with no service restart, and the two routers could scale independently later.

---

## 3. Project Structure

```
src/
├── server.ts              # Express app, /health, mounts routers, connects Redis
├── redisClient.ts          # Redis client + Lua script SHA cache (EVALSHA pattern)
├── routes/
│   ├── check.ts             # GET /check/:clientId — data plane
│   └── admin.ts             # PUT|GET /admin/clients/:clientId — control plane
└── lua/
    ├── tokenBucket.lua       # Atomic refill + spend (hash: tokens, lastRefill)
    └── slidingWindow.lua     # Atomic evict + count + record (sorted set)

loadtest/
├── config.ts                 # Shared BASE_URL, client IDs, pool helpers
├── metrics/
│   └── rate-limit-metrics.ts # k6 counters + theoretical-max correctness gate
└── scenarios/
    ├── singleClient.ts        # Shared-client contention test
    └── multiClient.ts         # Multi-client throughput + isolation test (throws on breach)

.github/workflows/
├── ci.yml                    # Build + smoke tests on every push/PR
├── loadtest.yml              # k6 load test (manual trigger)
└── keep-alive.yml            # Pings /health every 14 min to prevent Render cold starts
```

**Why Lua lives in its own folder, loaded by SHA:** every check is read-modify-write on shared state. Doing that in application code means a race between two concurrent requests for the same client. Lua scripts run atomically inside Redis's single-threaded execution — the whole read-modify-write happens as one uninterruptible step. `EVALSHA` (vs sending the script text every time) avoids re-parsing Lua on every request.

---

## 4. Core Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Atomicity mechanism | Lua scripting (`EVAL`/`EVALSHA`) | `MULTI`/`EXEC` transactions | Lua allows conditional logic (`if tokens >= 1`) inside the atomic unit; Redis transactions can't branch on values read mid-transaction |
| Token bucket storage | Redis hash (`tokens`, `lastRefill`) | Single counter, cron-based refill | Lazy refill (compute elapsed time per request) avoids a background job and stays correct even if the client goes quiet for hours |
| Sliding window storage | Sorted set (log of timestamps) | Two-counter approximation | Log is exact; approximation is cheaper at scale but skipped to keep the concurrency lesson honest |
| Sliding window member key | `timestamp + INCR(:seq)` | `timestamp + math.random()` | `INCR` on a sidecar key is atomic and collision-free; `math.random()` in Redis Lua can produce duplicate members under high concurrency, silently dropping entries |
| Sliding window `resetAt` | `oldest_entry + windowSize` | `now + windowSize` | Reflects when the first current-window entry actually falls off, giving clients an accurate `Retry-After`; `now + windowSize` is always a fresh future time and misleads clients |
| Module system | CommonJS | ESM / NodeNext | Removes a second learning curve so the concurrency/Redis problem stays the focus |
| Config storage | Redis (`config:{id}`) | In-memory map | Survives restarts; single Redis dependency instead of two state stores |
| Correctness gate | `throw` in `handleSummary` | Log and exit 0 | k6 must exit non-zero on isolation breach so CI actually catches double-spend bugs; a silent log is not a gate |

---

## 5. Milestones

| Phase | Goal | Status |
|---|---|---|
| 1 | Core server, token bucket, race-safe | ✅ Complete |
| 2 | Sliding window, configurability, feedback headers | ✅ Complete |
| 3 | Proof under load (500+ req/s), correctness gate | 🔶 Load tests authored — results pending |
| 4 | Distributed mode — multi-instance behind nginx | Planned |
| 5 | Observability / live dashboard | Planned |

---

## 6. API Reference

### Health

```
GET /health
→ 200  { "status": "ok", "redis": "connected" }
→ 503  { "status": "error", "redis": "disconnected" }
```

### Data plane

```
GET /check/:clientId
→ 200  Allowed  (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset)
→ 429  Denied   (same headers + Retry-After)
→ 404  No config registered for this clientId
```

### Control plane

```
PUT /admin/clients/:clientId
Body:
{
  "algorithm":        "token-bucket" | "sliding-window",
  "requestPerSecond": number,   // sustained refill rate
  "burstSize":        number,   // token bucket only — max burst above sustained rate
  "windowSize":       number    // milliseconds
}
→ 200  Config saved

GET /admin/clients/:clientId
→ 200  Current config JSON
→ 404  Not found
```

---

## 7. Running Locally

```bash
# 1. Install
npm install

# 2. Set env (copy and fill in)
cp .env.example .env
# REDIS_URL=redis://localhost:6379

# 3. Start dev server (hot-reload)
npm run dev

# 4. Register a client
curl -X PUT http://localhost:3000/admin/clients/my-client \
  -H "Content-Type: application/json" \
  -d '{"algorithm":"token-bucket","requestPerSecond":5,"burstSize":10,"windowSize":60000}'

# 5. Hit the limiter
curl -i http://localhost:3000/check/my-client
```

### Build

```bash
npm run build    # tsc + copies src/lua → dist/lua
npm start        # node dist/server.js
```

---

## 8. Load Testing

Load tests use k6's native TypeScript support (v0.57+) — `.ts` files run directly, no bundler needed.

```bash
# Type-check loadtest files
npm run typecheck:loadtest

# Run scenarios (server must be running)
k6 run loadtest/scenarios/singleClient.ts
k6 run loadtest/scenarios/multiClient.ts
```

### What each scenario proves

**`singleClient.ts`** — correctness under contention. 500 VUs hit the same `clientId` concurrently. Reveals double-spend bugs in the Lua atomicity path. The correctness gate in `handleSummary` compares `tollgate_allow_total` against the theoretical maximum (`burstSize + rps × duration`) and exits non-zero if the limiter over-allows.

**`multiClient.ts`** — throughput and client isolation. 20 clients each preconfigured at 50 rps / burst 100. Checks that aggregate allows stay within `perClientMax × 20` and that one client's requests don't leak into another's bucket. `handleSummary` throws on isolation breach — k6 exits 1, CI fails.

---

## 9. CI / CD

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Push / PR to `main` | `npm ci` → `build` → start server → smoke-test all 4 routes |
| `loadtest.yml` | Manual (`workflow_dispatch`) | Installs k6 v0.57, runs both scenarios against the live server |
| `keep-alive.yml` | Cron every 14 min | `curl /health` to prevent Render free-tier cold starts |

---

## 10. Deployment

Hosted on **Render** (free web service) + **Upstash** (free Redis).

| | |
|---|---|
| Server | Render Free Web Service — `npm ci && npm run build` → `node dist/server.js` |
| Redis | Upstash Regional (ap-south-1) — `rediss://` TLS URL via `REDIS_URL` env var |
| Cold starts | Prevented by `keep-alive.yml` pinging `/health` every 14 minutes |

The only required env var is `REDIS_URL`. Render injects `PORT` automatically; `server.ts` reads `process.env.PORT || 3000`.