# Tollgate Workflows and AI Analysis

This note captures the GitHub Actions workflows that are actually useful for Tollgate, plus where AI fits without weakening the core rate-limiting design.

## 1. What GitHub Actions should prove

Tollgate is not just a Node/TypeScript service. Its main claim is that Redis + Lua can enforce rate limits correctly under concurrency. That means CI should prove three things:

1. The service builds cleanly.
2. The Redis-backed routes still work.
3. The limiter does not over-admit when traffic gets hot.

A generic "run tests and lint" workflow is not enough on its own.

## 2. Recommended workflows

### PR CI

Trigger: `pull_request`

Purpose: fast feedback before merge.

Suggested steps:

1. Install dependencies with `npm ci`.
2. Run `npm run build`.
3. Run `npm run typecheck:loadtest`.
4. Start Redis as a service container.
5. Boot Tollgate.
6. Hit a small smoke test against `GET /check/:clientId` and `PUT /admin/clients/:clientId`.

Why this matters:

- Proves the app still starts.
- Catches TypeScript regressions.
- Verifies the service can connect to Redis in CI.
- Exercises both control plane and data plane.

### Manual load-test workflow

Trigger: `workflow_dispatch`, optionally `schedule`

Purpose: prove the concept under contention.

Suggested steps:

1. Install dependencies.
2. Start Redis.
3. Boot Tollgate.
4. Run `loadtest/scenarios/singleClient.ts`.
5. Run `loadtest/scenarios/multiClient.ts`.
6. Fail the job if the allow count exceeds the theoretical max.

Why this matters:

- `singleClient.ts` is the real race-condition test.
- `multiClient.ts` proves client isolation and aggregate throughput.
- Theoretical-max checking turns the load test into a correctness gate, not just a performance demo.

### Optional nightly regression run

Trigger: `schedule`

Purpose: catch concurrency regressions after changes land.

Why this matters:

- Rate-limit bugs are often intermittent.
- A nightly run gives you a safety net once the limiter is stable.

## 3. Best AI features for this project

AI should not sit inside `check.ts` and decide whether a request is allowed. That would undermine the entire point of Tollgate. The limiter itself should stay deterministic, atomic, and explainable.

AI is useful in the control plane, observability, and developer workflow.

### A. Natural-language admin assistant

Example:

- "Set client alpha to token bucket, 50 rps, burst 100"

The assistant converts that into the validated JSON body for `PUT /admin/clients/:clientId`.

Why it is useful:

- Makes the service easier to demo.
- Keeps correctness in Redis + Lua.
- Reduces friction for operators.

### B. Load-test analyst

The AI reads the k6 output from the load tests and explains what happened.

It should answer questions like:

- Did the run pass the theoretical-max check?
- Were 429s expected or suspicious?
- Did the limiter over-admit under contention?
- Which scenario failed and why?

Why it is useful:

- The repo already centers on proving correctness under load.
- AI can summarize results faster than a human reading raw k6 output.
- It adds value without touching the rate-limit decision path.

### C. Denial explainer

Input:

- clientId
- current config
- recent Redis state

Output:

- why the request was denied in plain English

Why it is useful:

- Good for demos.
- Good for debugging.
- Good for teaching how token bucket and sliding window behave.

### D. Policy recommender

AI looks at request patterns and suggests values for:

- `requestPerSecond`
- `burstSize`
- `windowSize`

Why it is useful:

- Helps turn Tollgate into a product, not just an engine.
- Useful when different clients have different traffic shapes.

### E. Anomaly summary

AI watches for unusual traffic patterns and summarizes them.

Examples:

- sudden spike in 429s
- unexpected config changes
- one client behaving very differently from its baseline

Why it is useful:

- Helps operators understand what changed.
- Can support a future dashboard or alerting feature.

## 4. Best implementation shape

The safest pattern is:

- Keep limiter logic deterministic in Lua.
- Keep configuration in Redis.
- Put AI around the edges.

That means AI can:

- generate admin commands,
- summarize load tests,
- explain denials,
- recommend configuration.

AI should not:

- make allow/deny decisions,
- rewrite request flow inside `check.ts`,
- replace the atomic Redis script.

## 5. Best concept demo

If the goal is to prove the concept clearly, the strongest demo is:

1. A PR workflow that proves the service still builds and talks to Redis.
2. A manual load-test workflow that proves the limiter is correct under contention.
3. A small AI assistant that explains configs and summarizes results.

That combination shows both sides of the project:

- the hard engineering problem,
- and the product layer that makes it easy to use.
