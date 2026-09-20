# Tollgate

[![Live API Docs](https://img.shields.io/badge/Live-API%20Docs-4CAF50?logo=swagger&logoColor=white)](https://tollgate-8cj5.onrender.com/docs/)
[![OpenAPI JSON](https://img.shields.io/badge/OpenAPI-JSON-FF6B6B?logo=openapiinitiative&logoColor=white)](https://tollgate-8cj5.onrender.com/docs.json)
[![Render Status](https://img.shields.io/badge/Render-Online-25C2A0?logo=render&logoColor=white)](https://tollgate-8cj5.onrender.com/health)

This repo contains the Tollgate service: a standalone, networked rate-limiting service — not a library you `import`, a service other backend APIs call into before processing their own requests. Built to learn shared state, atomicity, and correctness under concurrency.

## Hosted API Docs

- Swagger UI: https://tollgate-8cj5.onrender.com/docs/
- OpenAPI JSON: https://tollgate-8cj5.onrender.com/docs.json

---

## 1. Mental Model

| Concept | Analogy |
|---|---|
| Rate limiter | Tollbooth — every request pays a toll before passing |
| Token bucket | Water tank — tokens refill at a steady rate, requests drain it |
| Sliding window | A moving recording — old entries fall off the back as time passes |
| `X-RateLimit-*` headers | Thermostat display — tells the caller its state so it self-regulates |
| Admin routes | Control panel — changes limits without redeploying |

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                     TOLLGATE SERVICE                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  DATA PLANE (check)                                            │
│                                                                │
│   Upstream API        GET /check/:clientId                     │
│     │                         │                                │
│     ├────────────────────────→ routes/check.ts                 │
│     │                         ├─→ Lua script (EVALSHA)         │
│     │                         │       ↓                        │
│     │                         │   Redis (state)                │
│     │                         │   ├─ bucket:{id} (hash)        │
│     │                         │   └─ sw:{id} (sorted set)      │
│     ├─────────────────────────┤ 200 / 429 + X-RateLimit-*      │
│                                                                │
│  CONTROL PLANE (admin)                                         │
│                                                                │
│   Operator            PUT|GET /admin/clients/:clientId         │
│     │                         │                                │
│     ├────────────────────────→ routes/admin.ts                 │
│     │                         ├─→ Redis (config:{id})          │
│     ├─────────────────────────┤ 200                            │
│                                                                │
│  ★ Config changes take effect on next check (no restart)       │
│  ★ Two planes talk only through Redis (independent scaling)    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Data plane:** `check.ts` → Lua script → Redis state → response + headers.  
**Control plane:** `admin.ts` → Redis `config:{id}` → read by `check.ts` on next request.

The two planes share no in-process state — `check.ts` never calls `admin.ts`. Config changes propagate on the next request with no restart, and the planes could scale independently.

**Who calls Tollgate:** other backend services, not browsers or mobile clients. A payment API, for example, calls `GET /check/:clientId` before processing a transaction. The end user never interacts with Tollgate directly.

---

## 3. Project Structure

```
src/
├── server.ts              # Express app, /health, mounts routers, connects Redis
├── redisClient.ts         # Redis client + Lua SHA cache (EVALSHA pattern)
├── routes/
│   ├── check.ts           # GET /check/:clientId — data plane
│   └── admin.ts           # PUT|GET /admin/clients/:clientId — control plane
└── lua/
    ├── tokenBucket.lua    # Atomic refill + spend (hash: tokens, lastRefill)
    └── slidingWindow.lua  # Atomic evict + count + record (sorted set)

loadtest/
├── config.ts              # BASE_URL, client IDs, pool helpers
├── metrics/
│   └── rate-limit-metrics.ts  # k6 counters + theoretical-max correctness gate
└── scenarios/
    ├── singleClient.ts    # Contention test — 500 VUs, one shared clientId
    └── multiClient.ts     # Throughput + isolation test — throws on breach

.github/workflows/
├── ci.yml                 # Build + smoke tests on every push/PR
├── loadtest.yml           # k6 load test (manual trigger)
└── keep-alive.yml         # Pings /health every 14 min — prevents Render cold starts
```

**Why Lua, loaded by SHA:** every check is a read-modify-write on shared state. Application-level read-then-write means two concurrent requests for the same client can both read the same token count and both be allowed — a double-spend. Lua scripts run atomically inside Redis's single-threaded execution, making the entire read-modify-write one uninterruptible step. `EVALSHA` skips re-parsing the script on every request.

---

## 4. Core Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Atomicity | Lua (`EVAL`/`EVALSHA`) | `MULTI`/`EXEC` | Lua allows conditional logic mid-script; Redis transactions cannot branch on values read during the transaction |
| Token bucket storage | Redis hash (`tokens`, `lastRefill`) | Counter + cron refill | Lazy refill computes elapsed time per request — correct even after long client silence, no background job |
| Sliding window storage | Sorted set (exact log) | Two-counter approximation | Exact; approximation is cheaper at scale but skipped to keep correctness the focus |
| Sliding window member key | `timestamp + INCR(:seq)` | `timestamp + math.random()` | `INCR` is atomic and collision-free; `math.random()` in Lua can produce duplicate members under concurrency, silently dropping entries |
| Sliding window `resetAt` | `oldest_entry + windowSize` | `now + windowSize` | Reflects when the first in-window entry actually expires; `now + windowSize` always returns a future time and misleads clients on `Retry-After` |
| Config storage | Redis (`config:{id}`) | In-memory map | Survives restarts; single dependency |
| Correctness gate | `throw` in `handleSummary` | Log + exit 0 | k6 must exit non-zero on breach so CI actually catches double-spend bugs |

---

## 5. Networked vs In-Process — The Core Tradeoff

Tollgate is a **networked** rate limiter. Every upstream API request incurs one extra round trip to Tollgate before its own logic runs.

| Approach | Added latency | Global limit across instances |
|---|---|---|
| In-process library | None | ✗ — each pod enforces its own counter |
| Networked (Tollgate) | +1 round trip | ✓ — all instances share one Redis state |

**Why the hop matters at scale:** three pods each running an in-process limiter at 100 req/s produce an effective global rate of 300 req/s — the limit is per-instance, not per-service. Tollgate enforces the limit collectively.

**Latency cost:** ~1–2 ms collocated, 10–20 ms+ across a network.

**Production mitigations:** run Tollgate as a sidecar on the same host (near-zero RTT), or inline the Lua scripts directly into the API and call Redis without the service boundary.

This tradeoff is intentional — the goal was to study shared state and atomicity, not to produce the lowest-latency solution.

---

## 6. Milestones

| Phase | Goal | Status |
|---|---|---|
| 1 | Core server, token bucket, race-safe via Lua | ✅ Complete |
| 2 | Sliding window, configurability, feedback headers | ✅ Complete |
| 3 | Proof under load — 500 VUs, 498k requests, zero double-spend confirmed | ✅ Complete |
| 4 | Multi-instance mode behind nginx (distributed correctness) | Planned |
| 5 | Observability / live dashboard | Planned |

---

## 7. API Reference

### Health

```
GET /health
→ 200  { "status": "ok",    "redis": "connected" }
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
  "burstSize":        number,   // token bucket only
  "windowSize":       number    // milliseconds — sliding window only
}
→ 200  Config saved

GET /admin/clients/:clientId
→ 200  Current config JSON
→ 404  Not found
```

---

## 8. Running Locally

```bash
npm install
cp .env.example .env          # set REDIS_URL=redis://localhost:6379
npm run dev

# register a client
curl -X PUT http://localhost:3000/admin/clients/my-client \
  -H "Content-Type: application/json" \
  -d '{"algorithm":"token-bucket","requestPerSecond":5,"burstSize":10,"windowSize":60000}'

# hit the limiter
curl -i http://localhost:3000/check/my-client
```

```bash
npm run build   # tsc + copies src/lua → dist/lua
npm start       # node dist/server.js
```

---

## 9. Load Testing

Uses k6 native TypeScript support (v0.57+) — `.ts` files run directly, no bundler.

```bash
npm run typecheck:loadtest
k6 run loadtest/scenarios/singleClient.ts
k6 run loadtest/scenarios/multiClient.ts
```

**`singleClient.ts`** — correctness under contention. 500 VUs hit the same `clientId` concurrently. The correctness gate in `handleSummary` compares `tollgate_allow_total` against the theoretical maximum (`burstSize + rps × duration`) and exits non-zero if the limiter over-allows. **Verified: 498,191 requests, 3,589 allowed — within ceiling of 3,600. Zero double-spends.**

**`multiClient.ts`** — throughput and isolation. 20 clients preconfigured at 50 rps / burst 100. Verifies aggregate allows stay within `perClientMax × 20` and that no client's tokens leak into another's bucket. `handleSummary` throws on breach — CI fails. **Verified: 26,499 requests, all allowed, zero isolation breaches.**

---

## 10. CI / CD

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Push / PR to `main` | `npm ci` → build → start server → smoke-test all 4 routes |
| `loadtest.yml` | Manual + daily cron (2 AM UTC) | Installs k6 v0.57, runs both scenarios |
| `keep-alive.yml` | Cron every 14 min | `curl /health` — prevents Render cold starts |

---

## 11. Deployment

| | |
|---|---|
| Server | Render Free Web Service — `npm ci && npm run build` → `node dist/server.js` |
| Redis | Upstash (ap-south-1) — `rediss://` TLS via `REDIS_URL` env var |
| Cold starts | Mitigated by `keep-alive.yml` pinging `/health` every 14 minutes |

Only required env var: `REDIS_URL`. Render injects `PORT` automatically.