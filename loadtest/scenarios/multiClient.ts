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

import http from 'k6/http';
import { sleep } from 'k6';
import { Options } from 'k6/options';
import { BASE_URL, multiClientId } from '../config.ts';
import { recordRateLimitOutcome } from '../metrics/rate-limit-metrics.ts';

export const options: Options = {
  scenarios: {
    throughput: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 600,
      stages: [
        { duration: '10s', target: 100 },
        { duration: '20s', target: 550 },  // push past 500 rps aggregate
        { duration: '30s', target: 550 },
        { duration: '10s', target: 0 },
      ],
    },
  },
};

export function setup(): void {
  // TODO (optional): configure each client in the pool with known limits
  // via PUT /admin/clients/:clientId here, so isolation checks in
  // handleSummary have a theoretical baseline per client to compare against.
  //
  // for (let i = 0; i < MULTI_CLIENT_POOL_SIZE; i++) {
  //   http.put(`${BASE_URL}/admin/clients/${MULTI_CLIENT_PREFIX}${i}`, ...);
  // }
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
  // TODO: this is the interesting bit for isolation — you'd want to tag
  // metrics per-clientId (k6 supports tags) rather than one global
  // allow/deny counter, then check no single client's ALLOW count is
  // inflated by another client's traffic. The scaffold here only tracks
  // global counts; consider adding a `{ client: clientId }` tag to
  // recordRateLimitOutcome() calls if you want per-client breakdowns.
  return {
    stdout: JSON.stringify(data, null, 2),
  };
}