# Implementation Plan (All Phases)

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