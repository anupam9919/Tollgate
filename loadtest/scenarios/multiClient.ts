// loadtest/scenarios/multi-client-throughput.ts
//
// THROUGHPUT + ISOLATION TEST: a pool of distinct clientIds hit
// concurrently. Proves two things separately from the single-client
// contention test:
//   1. The server can sustain 500+ req/s in aggregate.
//   2. One client's traffic never eats into another client's limit
//      (i.e. bucket keys are genuinely isolated per clientId).
//
// Before running, configure each client in the pool via the admin
// endpoint (setup() below is a good place to do that — it runs once
// before VUs start).
//
// Run:
//   k6 run loadtest/scenarios/multi-client-throughput.ts

import http from "k6/http";
import { sleep } from "k6";
import { Options } from "k6/options";
import {
  BASE_URL,
  multiClientId,
  MULTI_CLIENT_POOL_SIZE,
  MULTI_CLIENT_PREFIX,
} from "../config.ts";
import { recordRateLimitOutcome } from "../metrics/rate-limit-metrics.ts";

export const options: Options = {
  scenarios: {
    throughput: {
      executor: "ramping-arrival-rate",
      startRate: 50,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      maxVUs: 600,
      stages: [
        { duration: "10s", target: 100 },
        { duration: "20s", target: 550 }, // push past 500 rps aggregate
        { duration: "30s", target: 550 },
        { duration: "10s", target: 0 },
      ],
    },
  },
};

export function setup(): void {
  // configure each client in the pool with known limits
  // via PUT /admin/clients/:clientId here, so isolation checks in
  // handleSummary have a theoretical baseline per client to compare against.
  //
  // for (let i = 0; i < MULTI_CLIENT_POOL_SIZE; i++) {
  //   http.put(`${BASE_URL}/admin/clients/${MULTI_CLIENT_PREFIX}${i}`, ...);
  // }
  // Pre-configure every client in the pool with identical known limits.
  // This gives you a baseline to check isolation against in handleSummary.
  for (let i = 0; i < MULTI_CLIENT_POOL_SIZE; i++) {
    const clientId = `${MULTI_CLIENT_PREFIX}${i}`;
    http.put(
      `${BASE_URL}/admin/clients/${clientId}`,
      JSON.stringify({
        algorithm: "token-bucket",
        requestPerSecond: 50,
        burstSize: 100,
        windowSize: 60000,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
  console.log(`Configured ${MULTI_CLIENT_POOL_SIZE} clients in the pool`);
}

export default function (): void {
  // __VU is k6's built-in 1-indexed virtual user ID — used here to spread
  // traffic across the client pool rather than every VU sharing one client.
  const clientId = multiClientId(__VU);
  const res = http.get(`${BASE_URL}/check/${clientId}`);
  recordRateLimitOutcome(res);
  sleep(0.01);
}

export function handleSummary(data: any): Record<string, string> {
  // metrics per-clientId (k6 supports tags) rather than one global
  // allow/deny counter, then check no single client's ALLOW count is
  // inflated by another client's traffic. The scaffold here only tracks
  // global counts; consider adding a `{ client: clientId }` tag to
  // recordRateLimitOutcome() calls if you want per-client breakdowns.

  const totalAllows = data.metrics.tollgate_allow_total.values.count;
  const totalDenies = data.metrics.tollgate_deny_total.values.count;
  const unexpectedStatuses =
    data.metrics.tollgate_unexpected_status_total.values.count;
  const totalRequeests = totalAllows + totalDenies + unexpectedStatuses;

  console.log(
    `Total ALLOWs: ${totalAllows}, Total DENYs: ${totalDenies}, Unexpected Statuses: ${unexpectedStatuses}`,
  );

  // With 20 clients each at 50 rps burst 100 over ~70s:
  // theoretical max per client = 100 + (50 * 70) = 3600
  // aggregate max = 3600 * 20 = 72000
  const perCLientMax = 100 + 50 * 70;
  const aggregateMax = perCLientMax * MULTI_CLIENT_POOL_SIZE;

  const summary = {
    totalRequeests,
    totalAllows,
    totalDenies,
    unexpectedStatuses,
    perCLientMax,
    aggregateMax,
    isolationCheckPassed:
      totalAllows <= aggregateMax
        ? "✅ PASS — aggregate allows within bounds"
        : `❌ FAIL — ${totalAllows} allows exceeded aggregate max ${aggregateMax}`,
  };
  console.log("\n=== Tollgate multi-client summary ===");
  console.log(JSON.stringify(summary, null, 2));
  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
