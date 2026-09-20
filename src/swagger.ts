import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Tollgate",
      version: "1.0.0",
      description: `
## What is Tollgate?

Tollgate is a **standalone rate-limiting gateway** — a dedicated service your backend calls to decide whether a request should be allowed through, rather than embedding rate-limiting logic inside each application server.

> Rate limiting is infrastructure, not application logic. Instead of every service reimplementing token buckets or sliding windows, they delegate the decision to Tollgate via a single HTTP call.

---

## Per-client configuration

Each \`clientId\` carries its own independent config stored in Redis. There is no global server-wide limit.

| Client | Algorithm | Rate | Burst |
|--------|-----------|------|-------|
| \`payment-service\` | token-bucket | 10 req/s | 20 |
| \`search-api\` | sliding-window | 200 req/s | — |

Config is set via \`PUT /admin/clients/:clientId\` and persisted in Redis. The gateway reads it on every \`/check\` call — **no restart, no redeploy**.

---

## Dual-algorithm support

**Token Bucket** — allows bursts above the steady-state rate. Tokens accumulate at \`requestPerSecond\` up to \`burstSize\`. State is stored as \`{tokens, last_refill_time}\` in a Redis hash and refilled on every check based on elapsed time.

**Sliding Window** — strict quota, no burst allowance. Tracks exact request timestamps in a Redis sorted set. Timestamps outside \`windowSize\` ms are pruned on every check. Uses an INCR-based sequence key for collision-safe writes under high concurrency.

---

## Atomic evaluate + consume

A single \`GET /check/:clientId\` call does two things inside one Lua script via \`EVALSHA\`:

1. **Evaluate** — read current state and decide \`allowed: true/false\`
2. **Mutate** — consume the token or record the timestamp in the same operation

Because both steps run inside a single \`EVALSHA\`, Redis's single-threaded model guarantees atomicity — two concurrent requests cannot both see "1 token remaining" and both be allowed. The response always reflects state **after** consumption.
  `,
    },
    servers: [
      {
        url: "https://tollgate-8cj5.onrender.com",
        description: "Production",
      },
    ],
    components: {
      schemas: {
        ClientConfig: {
          type: "object",
          required: [
            "algorithm",
            "requestPerSecond",
            "burstSize",
            "windowSize",
          ],
          properties: {
            algorithm: {
              type: "string",
              enum: ["token-bucket", "sliding-window"],
              example: "token-bucket",
            },
            requestPerSecond: { type: "number", example: 50 },
            burstSize: { type: "number", example: 100 },
            windowSize: { type: "number", example: 60 },
          },
        },
      },
    },
  },
  apis: ["./dist/routes/*.js", "./dist/server.js"],
};

export const swaggerSpec = swaggerJsdoc(options);