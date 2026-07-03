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
                        ┌──────────────────────────┐
                        │        TOLLGATE           │
                        │                            │
  Client ──GET /check──▶│  routes/check.ts           │
                        │      │                      │
                        │      ▼                      │
                        │  loadScript() ──EVALSHA──▶ Redis
                        │      │                      │   ├─ bucket:{id}   (hash)
                        │      ▼                      │   └─ sw:{id}       (sorted set)
                        │  headers + ALLOW/DENY        │
  Client ◀───────────────      │                      │
                        │                            │
  Operator ──PUT/GET──▶ │  routes/admin.ts           │
     /admin/clients/:id │      │                      │
                        │      ▼                      │
                        │  Redis: config:{id} (string)│
                        └──────────────────────────┘
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
└── test/
    └── (Postman collection: tollgate.postman_collection.json)
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
| 3 | Proof under load (500+ req/s) | Planned |
| 4 | Distributed mode (stretch) | Planned |
| 5 | Observability / dashboard (stretch) | Planned |

---

## 6. Implementation Plan (All Phases)

Each phase lists: **Goal → Steps → Files Touched → Done When**

### Phase 1 — Core Server ✅ Complete

**Goal:** A single-algorithm rate limiter, race-safe under concurrent hits to the same key.

**Steps:**
1. Scaffold Express app, connect to Redis on startup
2. Design bucket state shape (hash: `tokens`, `lastRefill`)
3. Write `tokenBucket.lua` — atomic refill-then-spend
4. Wire `POST /check/:clientId` to call the script via `EVALSHA`
5. Manual concurrency test — fire parallel requests at one client key, confirm no double-spend

**Files:** `server.ts`, `redisClient.ts`, `routes/check.ts`, `lua/tokenBucket.lua`

**Done when:** Server runs on port 3000; two simultaneous requests to the same client never both get ALLOW when only 1 token remains.

---

### Phase 2 — Configurability & Feedback 🔶 In Progress

**Goal:** Per-client tunable limits, a second algorithm, and headers that let clients self-throttle.

**Steps:**
1. Design config shape (`algorithm`, `requestsPerSecond`, `burstSize`, `windowSizeMs`), store as JSON string at `config:{clientId}`
2. Build `admin.ts` — `PUT`/`GET /admin/clients/:clientId`, validate shape before writing
3. Update `tokenBucket.lua` to return `{ allowed, remaining, resetAt }` instead of a bare flag
4. Write `slidingWindow.lua` — atomic `ZREMRANGEBYSCORE` (evict) → `ZCARD` (count) → `ZADD` (record)
5. Update `check.ts` to read config first, branch to the matching script, set `X-RateLimit-*` headers from the script's return values
6. Build Postman collection covering both algorithms + admin set/get
7. Manual test: switch a client between algorithms via admin route, confirm `check` behavior changes accordingly

**Files:** `routes/admin.ts` (new), `routes/check.ts` (rewritten), `lua/tokenBucket.lua` (extended), `lua/slidingWindow.lua` (new)

**Done when:** Admin route persists config across restarts (Redis-backed); `check` respects per-client algorithm; every response carries correct `Limit`/`Remaining`/`Reset` headers; sliding window is exact (no over-admits under sequential testing).

**Remaining work:** finish and test `slidingWindow.lua` independently, verify header math on both algorithms under Postman.

---

### Phase 3 — Proof Under Load

**Goal:** Demonstrate correctness holds at 500+ concurrent req/s, not just in manual testing.

**Steps:**
1. Install k6, write a script targeting `GET /check/:clientId` with a single fixed `clientId`
2. Ramp scenario: 0 → 500 VUs over 10s, hold 30s, ramp down
3. Assert in-script: response status distribution matches expected allow/deny ratio given configured `requestsPerSecond`
4. Post-run verification: query Redis directly (`HGETALL bucket:{id}` or `ZCARD sw:{id}`) to confirm final state matches what the math predicts — this is the real correctness check, not just HTTP status codes
5. Repeat for sliding window config
6. If violations found (over-admits), diagnose: likely causes are a non-atomic read outside the Lua script, or a TTL/key collision — fix and re-run
7. Document results (requests/sec sustained, p95 latency, correctness pass/fail) in `LOAD_TEST_RESULTS.md`

**Files:** `test/load/check.js` (new, k6 script), `LOAD_TEST_RESULTS.md` (new)

**Done when:** 500+ concurrent req/s sustained for 30s against one client key with zero double-spends confirmed by direct Redis inspection, not just by trusting HTTP responses.

---

### Phase 4 — Distributed Mode (Stretch)

**Goal:** Multiple Tollgate instances correctly share rate-limit state through one Redis.

**Steps:**
1. Run 2+ instances of the app on different ports, pointed at the same Redis
2. Put a simple load balancer or manual round-robin script in front (nginx, or a tiny script alternating requests)
3. Re-run the Phase 3 k6 test against the load-balanced endpoint instead of a single instance
4. Verify state correctness the same way — direct Redis inspection post-run
5. Identify and fix any issues specific to multi-instance access (there shouldn't be new ones if Phase 1–2 atomicity is correct — this phase is a proof, not new logic)

**Files:** `docker-compose.yml` or a process-manager config (new) to run multiple instances; no application code changes expected

**Done when:** Correctness holds identically whether traffic hits one instance or is spread across several — proving the atomicity guarantee lives in Redis, not in single-process assumptions.

---

### Phase 5 — Observability (Stretch)

**Goal:** Make allow/deny behavior visible without reading Redis by hand.

**Steps:**
1. Add a counter increment (`INCR stats:{clientId}:allowed` / `:denied`) inside each Lua script, atomic with the existing check
2. Build `GET /admin/clients/:clientId/stats` returning both counters
3. Build a minimal frontend (single HTML page, polling the stats endpoint every few seconds) showing live allow/deny rate per client
4. Optional: add a reset-stats admin action for clean demo runs

**Files:** `lua/tokenBucket.lua` + `lua/slidingWindow.lua` (add counter increments), `routes/admin.ts` (new stats route), `public/dashboard.html` (new)

**Done when:** Dashboard shows live counts updating in real time while `check` traffic runs, without needing to inspect Redis directly.

---

### Sequencing Rationale

Phase 3 before Phase 4: load-testing a single instance is a strict prerequisite — if correctness doesn't hold on one instance under load, distributing it only hides the bug across more processes.

Phase 5 is independent of Phase 4 and could be done in either order, but comes last here since it's the least load-bearing for the "infrastructure correctness" goal of the project.

---

## 7. Testing

- **Functional:** `tollgate.postman_collection.json` — admin config set/get, check under both algorithms, header inspection
- **Concurrency:** k6, deferred to Milestone 3 — the only test that actually proves the atomicity claims above rather than assuming them
- **Manual sanity check:** rapid-fire `GET /check/:clientId` in Postman Runner, watch `Remaining` count down and `429` appear on schedule