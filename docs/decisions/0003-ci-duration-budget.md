# ADR 0003: One deployment-wide CI duration budget

- Status: Accepted; amended by [ADR 0004](0004-status-feedback-loop.md)
- Date: 2026-10-23

## Purpose

Actions minutes are a budget. A long CI run is a finding: review the pipeline
for excess and optimize it, rather than raise its timeout. Putting this policy
in the installed App applies one limit without copying watchdog workflows or
configuration into every repository.

## Alternatives considered

1. Set job timeouts in each repository alone.
   - Useful as runner-native stop controls, but duplicated policy drifts across
     installations and separate short jobs can still form a long pipeline.
2. Inspect completed workflows only.
   - Reports excess accurately but cannot act while a runaway run is active.
3. Budget each job or sum its billed runner minutes.
   - Per-job limits miss long serial pipelines. Summed parallel jobs and billing
     multipliers measure cost, not the requested wall-time limit.
4. Extend the event + scheduled sweep + KV queue architecture to track workflow
   attempts, with a separate status and optional ordinary cancellation.
   - Covers active runs without spending Actions minutes on polling. Accepts
     the existing cron, KV consistency, and API availability limits.

## Decision

Choose option 4. `CI_BUDGET_MINUTES` is opt-in, absent/empty by default.
`CI_BUDGET_MODE` defaults to `report`; only explicit `cancel` can mutate Actions
state. Invalid configuration disables the feature and logs its reason. There
are no per-repository overrides: all current settings are deployment-scoped,
and exceptions would undermine the requested shared limit. All workflow events
are covered, not just PR-associated CI.

Measure each workflow attempt from its first executed job start to its last job
completion, or now for an active run. Initial runner queue time, skipped jobs,
and cancelled jobs that never started are excluded. Gaps after execution starts
are part of pipeline wall time; parallel durations are not summed. Job timestamps provide an execution boundary
without using the run's mutable `updated_at`. A duration exactly equal to the
budget is allowed; exceeding it is the finding. This is not an invoice estimator.

Subscribe to `workflow_run`. An `in_progress` delivery enqueues the
installation/repository/run/attempt in a separate key prefix in the existing
`PENDING_REVIEWS` namespace before API evaluation so failures remain retryable.
`requested` and `completed` deliveries follow ADR 0004.
GitHub is authoritative; every evaluation reads the exact attempt (a completed
delivery uses its signed final record instead) and, unless the attempt
concluded `skipped`, its jobs.
The sweep evaluates due records before PR work, with its own positive integer
cap (default two). Once the start is known, the next check is due at the budget
deadline; unknown starts and failed evaluations retry on the existing cadence.
Failed entries back off so they cannot monopolize the deadline queue. Budget
changes invalidate stored deadlines. Verified active records renew a retention
window of budget duration plus 24 hours, following the existing queue's recovery
horizon without expiring before the configured deadline. Failed reads back off
but preserve the prior expiry, bounding removed installations and inaccessible
runs instead of renewing them forever. Cancel receipts use the same window.

Only scheduled reads reschedule queue keys. Webhooks enqueue once and report
promptly; they do not immediately overwrite the same KV key with a deadline,
respecting KV's one-write-per-second-per-key constraint. A delivery that sees
its attempt finished settles it (ADR 0004); scheduled cleanup re-fetches live
attempt state. Attempts have distinct keys so an old completion cannot remove a
newer rerun. Listing is capped at ten 1,000-key
pages per sweep. Persist the opaque continuation cursor in a separate KV key
after processing a segment; resume it on the next sweep and clear it at the end
to wrap. This bounds enumeration without starving later installations behind
10,000 not-yet-due entries. Due records are sorted within each segment, not
globally. KV eventual consistency may repeat a segment; the cursor is not a
lock. Caps and errors are visible in sweep summaries, and `queued` counts only
the scanned segment. Jobs are capped at 1,000 per attempt and status history at
1,000 per SHA; incomplete inspection fails
visibly rather than guessing that cancellation or success is safe.

GitHub identifies commit status contexts case-insensitively. Configuration must
reject a collision with the effective review context, disabling budgeting with
a clear log, so proactive budget success can never overwrite the review gate.
Use the same normalization when filtering status history, preserving findings
and review evidence regardless of the casing originally published.

The separate, configurable `review-gate/ci-budget` status is proactively green
while no breach is known, once a job has executed (ADR 0004). This lets normal
runs satisfy a required context,
without pretending the budget check replaces actual CI checks. Once reported,
a breach is sticky on the SHA: another workflow, rerun, or setting change does
not erase it. The description directs optimization, not a longer timeout, and
links to the offending attempt. The status history retains findings; a success
writer checks again afterward to reconcile an overlapping failure publication.
No executed Actions job means no budget status, and enabling does not backfill
old runs. A status is written only when its state or description changes.

Actions read is required, and Actions write must be explicitly present on the
installation token before cancellation. Commit statuses write must also be
approved, even when the status already exists. Public API readability alone does
not prove approval. Each installation owner must approve new App permissions.
With only read access, cancel mode logs the missing write approval and reports
the breach without attempting cancellation. Missing KV, missing read permission,
API errors, or incomplete timing cannot trigger a cancel. Reporting must succeed
before cancellation. Immediately before the ordinary cancel API call, read the
current run to check that the same attempt is still in progress. Never use the
force-cancel endpoint. Remember accepted requests separately in KV until terminal
cleanup or expiry; a failed request is not marked accepted.

## Trade-offs and limits

- The unchanged three-minute cron, KV propagation, capped backlogs, and GitHub
  availability make this best-effort near-deadline enforcement, not a precise
  ten-minute stop guarantee. Native workflow timeouts remain necessary for a
  strict runner stop bound. A one-minute cron and larger cap are operator choices
  with additional API/KV cost.
- An accepted ordinary cancellation may still leave cleanup jobs running.
  Cancellation acceptance is not live proof that all runners stopped.
- KV provides neither compare-and-swap nor exactly-once delivery. Simultaneous
  duplicate workers can make duplicate idempotent cancel requests; no lock is
  claimed. The attempt check narrows but cannot atomically eliminate the race
  between GitHub's final read and its run-scoped cancel endpoint.
- Proactive green describes only absence of an observed duration finding. Require
  actual CI checks as well, and do not require this status on branches without
  Actions runs. Persisted failures require a new SHA with optimized CI.
- Without a delivered `in_progress` event an active attempt is not queued, so
  it cannot be cancelled; its completed delivery is still reported. Lost
  deliveries need GitHub redelivery; the open-PR review fallback does not
  discover Actions.
  An outage longer than the retention window likewise needs event redelivery.
- Disabled deployments do not list the CI queue, request Actions APIs, or gain
  cancellation authority. Existing review caps, cron, and configuration stay
  unchanged.

## References

- [GitHub workflow-run webhooks](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run)
- [GitHub workflow jobs and attempt timing](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt)
- [GitHub ordinary workflow cancellation and required permission](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run)
- [GitHub installation access tokens and granted permissions](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub commit status context identity](https://docs.github.com/en/rest/commits/statuses#create-a-commit-status)
- [Workers KV cursor pagination](https://developers.cloudflare.com/kv/api/list-keys/#pagination)
- [Workers KV write limits](https://developers.cloudflare.com/kv/platform/limits/)
