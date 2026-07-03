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

## 6. Testing

- **Functional:** `tollgate.postman_collection.json` — admin config set/get, check under both algorithms, header inspection
- **Concurrency:** k6, deferred to Milestone 3 — the only test that actually proves the atomicity claims above rather than assuming them
- **Manual sanity check:** rapid-fire `GET /check/:clientId` in Postman Runner, watch `Remaining` count down and `429` appear on schedule