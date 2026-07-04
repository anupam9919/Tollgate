// loadtest/config.ts
// Shared config across all Tollgate k6 scenarios.

export const BASE_URL: string = __ENV.BASE_URL || 'http://localhost:3000';

// A single, dedicated clientId used for the "single client" contention test.
// IMPORTANT: configure this client's limits via your admin endpoint BEFORE
// running the test, so you know the theoretical max ALLOWs in advance.
// e.g. PUT /admin/clients/loadtest-single-client  { rps: 50, burst: 100 }
export const SINGLE_CLIENT_ID = 'loadtest-single-client';

// Pool of clientIds for the multi-client isolation/throughput test.
// Each gets its own bucket — none should be affected by another's traffic.
export const MULTI_CLIENT_POOL_SIZE = 20;
export const MULTI_CLIENT_PREFIX = 'loadtest-multi-client-';

export function multiClientId(vuId: number): string {
  // Spread VUs across the pool so each simulated "client" gets sustained
  // traffic from multiple VUs, rather than a 1:1 VU-to-client mapping.
  const index = vuId % MULTI_CLIENT_POOL_SIZE;
  return `${MULTI_CLIENT_PREFIX}${index}`;
}
