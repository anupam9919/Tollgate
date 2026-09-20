import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Tollgate",
      version: "1.0.0",
      description: `
    ## What is Tollgate?

    Tollgate is a standalone rate-limiting gateway — a dedicated service your backend calls to decide whether a request should be allowed through, rather than embedding rate-limiting logic inside each application server.

    The core idea: rate limiting is infrastructure, not application logic. Instead of every service reimplementing token buckets or sliding windows (and getting them wrong under concurrency), they delegate the decision to Tollgate via a single HTTP call.

    ---

    ## Per-client configuration

    Each client (identified by a \`clientId\`) carries its own independent rate-limit config stored in Redis. There is no global server-wide limit. This means:

    - Client \`payment-service\` can run token-bucket at 10 req/s with burst 20
    - Client \`search-api\` can run sliding-window at 200 req/s with window 60s
    - Changing one client's config has zero effect on any other

    Config is set via \`PUT /admin/clients/:clientId\` and persisted in Redis as \`client:{clientId}:algorithm\`. The gateway reads it on every \`/check\` call — no restart, no redeploy.

    ---

    ## Dual-algorithm support

    Tollgate supports two algorithms, chosen per client at config time:

    **Token Bucket** — suited for APIs that want to allow short bursts above the steady-state rate. Tokens accumulate at \`requestPerSecond\` up to \`burstSize\`. A request consumes one token. If the bucket is empty, the request is denied. State is stored as \`{tokens, last_refill_time}\` in a Redis hash and refilled on every check based on elapsed time.

    **Sliding Window** — suited for strict per-second or per-minute quotas with no burst allowance. Tracks exact request timestamps in a Redis sorted set. On each check, timestamps older than \`windowSize\` ms are pruned, the current count is compared against \`requestPerSecond\`, and the new timestamp is added atomically using an INCR-based sequence key to avoid collisions under high concurrency.

    ---

    ## The single-request dual-turn model

    A single call to \`GET /check/:clientId\` does two things atomically inside a Lua script executed on Redis:

    1. **Evaluate** — read current state (bucket tokens or window count) and decide \`allowed: true/false\`
    2. **Mutate** — if allowed, consume the token or record the timestamp in the same atomic operation

    Because both turns happen inside a single \`EVALSHA\` call, there is no race condition between the read and the write. Two concurrent requests cannot both read "1 token remaining", both decide allowed, and both decrement — the Lua script is guaranteed to execute atomically by Redis's single-threaded command model.

    The response always reflects the state **after** consumption, not before.
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