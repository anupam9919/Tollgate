# Tollgate

A standalone, networked rate-limiting service — not a library you `import`, a service other APIs call into. Built to learn shared state, atomicity, and correctness under concurrency, not just the algorithms.

---

## 1. Mental Model

| Concept | Analogy |
|---|---|
| Rate limiter | Tollbooth — every request pays a toll before passing |
| Token bucket | Water tank — tokens refill at a steady rate, requests drain it |
| Sliding window | A moving 60-second recording — old entries fall off the back |
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
│     │                         │       ↓                         │
│     │                         │   Redis (state)                │
│     │                         │   ├─ bucket:{id} (hash)        │
│     │                         │   └─ sw:{id} (sorted set)      │
│     │                         │       ↓                         │
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
│     │                         │       ↓                         │
│     ├─────────────────────────┤ response                       │
│                                                                │
│  ★ Config changes take effect on next check (no service restart)│
│  ★ Two planes talk only through Redis (independent scaling)    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Data plane:** `check.ts` → Lua script → Redis state → response + headers.
**Control plane:** `admin.ts` → Redis config → read by `check.ts` on next request.

These two planes only talk through Redis — `check.ts` never calls `admin.ts` directly. That decoupling is deliberate: config changes take effect on the *next* request with no service restart, and the two routers could scale independently later.

---

## 3. Project Structure

```
src/
├── server.ts              # Express app, mounts routers, connects Redis
├── redisClient.ts          # Redis client + Lua script SHA cache (EVALSHA pattern)
├── routes/
│   ├── check.ts             # GET /check/:clientId — data plane
│   └── admin.ts             # PUT|GET /admin/clients/:clientId — control plane
├── lua/
│   ├── tokenBucket.lua       # Atomic refill + spend (hash: tokens, lastRefill)
│   └── slidingWindow.lua     # Atomic evict + count + record (sorted set)
└── loadtest/
    ├── config.ts             # Shared BASE_URL, client IDs, pool helpers
    ├── metrics/
    │   └── rate-limit-metrics.ts # k6 counters + theoretical-max scaffold
    └── scenarios/
        ├── singleClient.ts    # Shared-client contention test
        └── multiClient.ts     # Multi-client throughput + isolation test
```

**Why Lua lives in its own folder, loaded by SHA:** every check is read-modify-write on shared state. Doing that in application code means a race between two concurrent requests for the same client. Lua scripts run atomically inside Redis's single-threaded execution — the whole read-modify-write happens as one uninterruptible step. `EVALSHA` (vs sending the script text every time) avoids re-parsing Lua on every request.

---

## 4. Core Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Atomicity mechanism | Lua scripting (`EVAL`/`EVALSHA`) | `MULTI`/`EXEC` transactions | Lua allows conditional logic (`if tokens >= 1`) inside the atomic unit; Redis transactions can't branch on values read mid-transaction |
| Token bucket storage | Redis hash (`tokens`, `lastRefill`) | Single counter, cron-based refill | Lazy refill (compute elapsed time per request) avoids a background job and stays correct even if the client goes quiet for hours |
| Sliding window storage | Sorted set (log of timestamps) | Two-counter approximation | Log is exact; approximation is cheaper at scale but was skipped to keep the concurrency lesson honest, not approximate |
| Module system | CommonJS | ESM / NodeNext | Removes a second learning curve so the concurrency/Redis problem stays the focus |
| Config storage | Redis (`config:{id}`) | In-memory map | Survives restarts; single Redis dependency instead of two state stores |
| Config propagation | Read-per-request from Redis | Push config to app + cache in memory | Simplicity now; caching admin config is a known future optimization, deferred deliberately |

---

## 5. Milestones — Overview

| Phase | Goal | Status |
|---|---|---|
| 1 | Core server, single algorithm, race-safe | ✅ Complete |
| 2 | Configurability, second algorithm, feedback headers | 🔶 In progress |
| 3 | Proof under load (500+ req/s) | 🔶 In progress |
| 4 | Distributed mode (stretch) | Planned |
| 5 | Observability / dashboard (stretch) | Planned |

---

## 6. Testing

### Service contract

- `GET /check/:clientId` runs the limiter for one client and returns `200` when allowed or `429` when denied.
- `PUT /admin/clients/:clientId` stores the config used by the next `/check` call.
- `GET /admin/clients/:clientId` reads the stored config back.

### Admin request body

The server expects JSON in this shape:

```json
{
    "algorithm": "token-bucket" | "sliding-window",
    "requestPerSecond": 1,
    "burstSize": 20,
    "windowSize": 6000
}
```

`windowSize` is in milliseconds. If no config exists for a client, the server falls back to the default token-bucket settings in `src/routes/check.ts`.

### Response headers

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

### k6 setup

Tollgate's load tests use k6 native TypeScript support. Since k6 v0.57, `.ts` files run directly with no bundler or build step, but type-checking is still separate.

```bash
npm install
npm run typecheck:loadtest
```

The repository already includes the TypeScript loadtest config in `tsconfig.loadtest.json`, which covers `loadtest/**/*.ts`.

### Loadtest files

- `loadtest/config.ts` centralizes `BASE_URL`, the single-client ID, and the multi-client pool helper.
- `loadtest/scenarios/singleClient.ts` is the contention test for one shared Redis key.
- `loadtest/scenarios/multiClient.ts` is the throughput and client-isolation test.
- `loadtest/metrics/rate-limit-metrics.ts` records allow/deny counts and contains the theoretical-max check scaffold.

### Running locally

Make sure Redis is available, `REDIS_URL` is set for the Tollgate server, and the app is listening on port `3000`.

```bash
# start the service
npm run dev

# configure the single-client test target
curl --location --request PUT 'http://localhost:3000/admin/clients/loadtest-single-client' \
    --header 'Content-Type: application/json' \
    --data '{
        "algorithm": "token-bucket",
        "requestPerSecond": 1,
        "burstSize": 20,
        "windowSize": 6000
    }'

# run the Milestone 3 scenarios
k6 run loadtest/scenarios/singleClient.ts
k6 run loadtest/scenarios/multiClient.ts
```

### What each scenario proves

- `singleClient.ts` is the correctness test. Many VUs hit the same `clientId`, so it can reveal double-spend bugs in the Lua atomicity path.
- `multiClient.ts` is the throughput and isolation test. It checks that aggregate traffic stays high and that one client's requests do not leak into another client's bucket.

### Correctness gate

`metrics/rate-limit-metrics.ts` is where the run should compare `tollgate_allow_total` against the theoretical maximum for the configured limits and wall-clock duration. Once that check is wired into `handleSummary()`, the k6 run should exit non-zero if the limiter ever allows more than the math permits.
