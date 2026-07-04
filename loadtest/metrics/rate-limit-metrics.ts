// loadtest/metrics/rate-limit-metrics.ts
//
// Custom k6 metrics + correctness-checking scaffold for rate-limit
// load tests. Named "rate-limit-metrics" (not "checks") to avoid
// clashing with the /check/:clientId route or check.ts in the main app —
// this file is about tallying ALLOW/DENY outcomes, not the check route itself.
//
// The throughput number from k6's summary (requests/sec) tells you the
// server survived. It does NOT tell you the rate limiter is CORRECT.
// Correctness means: across the whole test run, the number of ALLOWed
// requests for a given client never exceeds what the algorithm's math
// says it should. That's the number that actually matters here.

import { Counter } from 'k6/metrics';
import { Response } from 'k6/http';

// Track allow/deny counts per scenario so we can compare against
// theoretical maxima after the run.
export const allowCounter = new Counter('tollgate_allow_total');
export const denyCounter = new Counter('tollgate_deny_total');
export const unexpectedStatusCounter = new Counter('tollgate_unexpected_status_total');

/**
 * Record the outcome of a single /check/:clientId call.
 * Adjust the status-code / body logic below to match how your
 * server actually signals ALLOW vs DENY (e.g. 200 vs 429, or a
 * JSON body field like { allowed: true/false }).
 */
export function recordRateLimitOutcome(res: Response): void {
  if (res.status === 200) {
    allowCounter.add(1);
  } else if (res.status === 429) {
    denyCounter.add(1);
  } else {
    unexpectedStatusCounter.add(1);
  }
}

export interface TheoreticalMaxParams {
  rps: number;
  burst: number;
  durationSeconds: number;
  actualAllows: number;
}

export interface TheoreticalMaxResult {
  expectedMax: number;
  actual: number;
  passed: boolean;
}

/**
 * TODO (yours to implement):
 *
 * Given:
 *   - the configured rps/burst for a client (whatever you set via
 *     PUT /admin/clients/:clientId before the test),
 *   - the wall-clock duration of the test scenario,
 *   - the algorithm mode (token bucket vs sliding window),
 *
 * compute the theoretical MAX number of ALLOWs that should be possible
 * for that client over the test duration, and compare it against the
 * actual `tollgate_allow_total` you get out of the k6 summary.
 *
 * Token bucket theoretical max (rough form):
 *   maxAllows = burst + floor(rps * durationSeconds)
 *
 * Sliding window theoretical max is trickier — think about how many
 * complete windows fit in the test duration and what "limit per window"
 * actually bounds.
 *
 * Wire the result into handleSummary() (see scenario files) so the k6
 * run fails loudly (non-zero exit) if actual > expectedMax — that's the
 * signal that tokens were double-spent under concurrency.
 */
export function computeTheoreticalMaxAllows(_params: TheoreticalMaxParams): TheoreticalMaxResult {
  throw new Error('computeTheoreticalMaxAllows() not implemented yet — see TODO above');
}

