// loadtest/scenarios/single-client-contention.ts
//
// THE REAL TEST: many VUs hammering the SAME clientId concurrently.
// This is the only scenario where a race condition in your Lua script
// could actually manifest as double-spent tokens. If your atomic Lua
// implementation is correct, allowCounter should never exceed the
// theoretical max no matter how many VUs pile on.
//
// Before running:
//   1. Make sure your server is up: http://localhost:3000
//   2. Set known limits for the test client, e.g.:
//      curl -X PUT http://localhost:3000/admin/clients/loadtest-single-client \
//        -H "Content-Type: application/json" \
//        -d '{"algorithm":"tokenBucket","rps":50,"burst":100}'
//   3. Note the rps/burst you configured — you'll need them for the
//      theoretical-max check afterwards.
//
// Run (k6 v0.57+, native TS support, no build step needed):
//   k6 run loadtest/scenarios/single-client-contention.ts

import http from "k6/http";
import { sleep } from "k6";
import { Options } from "k6/options";
import { BASE_URL, SINGLE_CLIENT_ID } from "../config.ts";
import {
  computeTheoreticalMaxAllows,
  recordRateLimitOutcome,
} from "../metrics/rate-limit-metrics.ts";

export const options: Options = {
  scenarios: {
    contention: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 50 }, // warm up
        { duration: "20s", target: 500 }, // ramp to 500+ concurrent
        { duration: "30s", target: 500 }, // hold at peak — this is where races live
        { duration: "10s", target: 0 }, // cool down
      ],
    },
  },
};

export default function (): void {
  const res = http.get(`${BASE_URL}/check/${SINGLE_CLIENT_ID}`);
  recordRateLimitOutcome(res);
  // No sleep worth mentioning — we want VUs hammering as fast as possible
  // during the hold phase to maximize contention on the same Redis key.
  sleep(0.01);
}

export function handleSummary(data: any): Record<string, string> {
  // TODO: pull `tollgate_allow_total` out of data.metrics, plug into
  // computeTheoreticalMaxAllows() from metrics/rate-limit-metrics.ts along
  // with the rps/burst you configured and the actual test duration
  // (60s across all stages), and fail loudly if actual allows exceeded
  // the theoretical max.
  //
  // Example shape of what you're reaching for:
  //
  //   const actualAllows = data.metrics.tollgate_allow_total.values.count;
  //   const result = computeTheoreticalMaxAllows({ rps: 50, burst: 100, durationSeconds: 60, actualAllows });
  //   console.log(JSON.stringify(result, null, 2));
  //   if (!result.passed) {
  //     throw new Error(`Correctness check FAILED: allowed ${result.actual}, max was ${result.expectedMax}`);
  //   }

  const actualAllows: number =
    data.metrics.tollgate_allow_total?.values?.count ?? 0;

  const rps = 50;
  const burst = 100;
  const durationSeconds = 70;

  const result = computeTheoreticalMaxAllows({
    rps,
    burst,
    durationSeconds,
    actualAllows,
  });

  const summary = {
    expectedMax: result.expectedMax,
    actual: result.actual,
    passed: result.passed,
    verdict: result.passed
      ? "PASS - no double-spend detected"
      : `FAIL-  FAIL — allowed ${result.actual}, max was ${result.expectedMax}`,
  };

  console.log("\n=== Tollgate correctness check ===");
  console.log(JSON.stringify(summary, null, 2));

  if (!result.passed) {
    // Throwing here causes k6 to exit with a non-zero code,
    // which fails the CI job.
    throw new Error(
      `Correctness check FAILED: allowed ${result.actual}, theoretical max was ${result.expectedMax}. ` +
        `Double-spend suspected in Lua atomicity path.`,
    );
  }

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
