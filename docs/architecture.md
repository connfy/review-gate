# Architecture

Review Gate is a JavaScript Cloudflare Worker backed by one GitHub App and one
Workers KV namespace.

## Module relationships

- `src/index.js` owns the Worker entrypoints, GitHub orchestration, status
  reporting, and scheduled sweep budgets.
- `src/webhook.js` verifies and routes GitHub webhook events without making
  network calls.
- `src/github.js` owns GitHub App authentication, pagination, REST calls, and
  GraphQL review-thread reads.
- `src/gate.js` is the pure policy engine. It turns fetched PR evidence into a
  `success`, `pending`, or `failure` result.
- `src/pending.js` owns Workers KV key encoding, TTL tracking, listing, and
  settlement for pending PR heads.
- `src/ci-budget.js` owns the optional deployment-wide Actions duration policy,
  attempt deadline queue, sticky budget status, and permission-checked ordinary
  cancellation. It shares the KV binding, not the review queue's key prefix or
  evaluation budget.

## Runtime flow

1. GitHub sends a supported webhook to `fetch()`.
2. The Worker verifies the signature, acknowledges the request, and evaluates
   the referenced PR in `waitUntil()`. A merged-PR close also lists the other
   open PRs in that repository and evaluates siblings targeting the same base
   ref.
3. Each result is written as the configured GitHub commit status.
4. A `pending` result is stored in `PENDING_REVIEWS`; a terminal result removes
   the matching queued head.
5. Every three minutes, the scheduled handler evaluates queued pending heads
   and the rotating open-PR fallback with separate budgets.

When CI budgeting is enabled, signed `workflow_run` webhooks are routed to the
budget instead. `requested` does no work, since no job has started. `in_progress`
enqueues and evaluates the referenced workflow attempt. `completed` evaluates
the finished attempt from its signed payload (a `skipped` conclusion needs no
API call); only a failed evaluation is queued. Whichever delivery sees the
attempt finished removes its queue entry.
GitHub attempt/job reads determine
wall time from the first executed job to completion (or now), excluding the
initial queue. The scheduled handler processes due CI attempts before both PR
paths, with a third independent cap. Bounded queue enumeration resumes from a
persisted KV cursor across sweeps and wraps when listing completes, so later
installations are not hidden behind an always-full first segment. Due attempts
are sorted within that segment. Initial webhook writes are not immediately
overwritten; only scheduled evaluations reschedule deadlines, and they clean
terminal records that no completed webhook settled. Permission/API failures
remain queued. Budget configuration changes
invalidate old deadlines. No CI queue listing or Actions request occurs when
the budget is absent.

The budget status is separate from review status and actual workflow results.
Configuration rejects a case-insensitive collision with the effective review
context, and all status-history reads use the same case-insensitive identity.
Once a job has executed it is green proactively until a breach is observed; a
reported failure is sticky
on the SHA across workflows and reruns. Status history and a post-success
reconciliation prevent an observed finding from being cleared by a shorter run.
Runs that executed no job publish nothing, and only a change of state or
description is written: every status write emits a `status` event that can start
status-triggered workflows, so evaluations of those runs must not republish an
unchanged status. See [ADR 0004](decisions/0004-status-feedback-loop.md).
Cancellation requires explicit mode plus Actions write on the installation
token, and a final live attempt check. Accepted requests have separate KV
receipts; neither KV nor the run-scoped cancel endpoint offers an atomic
exactly-once guarantee. See [ADR 0003](decisions/0003-ci-duration-budget.md).

The queue is an optimization, not a new authority. GitHub remains the source of
truth, and every scheduled retry re-fetches the current PR, reviews, reactions,
threads, and timeline before changing the status.

The optional settled-disposition signal is also derived only from current
GitHub evidence. It requires a round anchor — the latest-head request comment
when one exists, or for an auto-fired round with no request comment anywhere a
server-generated boundary (PR creation and head-ref event times, never
client-controlled commit timestamps) — then a later non-dismissed formal bot
review for that exact head, and a later exact head/base attestation from an
allowlisted human. Either live SHA changing invalidates the signal. No extra
invalidation store or mutation authority is introduced.

Merged base advances trigger same-base sibling evaluation from the subscribed
`pull_request` close event. Direct pushes to a base branch remain covered by the
rotating scheduled fallback, so their invalidation occurs when that fallback
selects the affected PR.

## Operational boundaries

- Workers KV is eventually consistent, so a newly queued head may take up to a
  minute to become visible from another Cloudflare location. The three-minute
  cron interval absorbs that delay.
- Queue entries expire after 24 hours by default. The rotating open-PR sweep
  remains available if an entry expires or KV is unavailable.
- Pending and fallback sweeps have separate caps, so long-running reviews cannot
  starve reaction-only PRs that were not queued.
- Enabled CI sweeps also have a separate cap and bounded queue/job/status reads.
  A three-minute cron and eventual consistency give best-effort deadline checks,
  not an exact stop-time guarantee. `limited` warnings expose delayed work.
  Verified active CI entries renew retention of budget duration plus 24 hours;
  failures preserve the previous expiry so inaccessible runs do not accumulate.
  Workflow event redelivery recovers lost or outage-expired entries; the PR
  fallback does not discover runs.
- The fallback over-fetches by the number of queued PRs it excludes, preserving
  its evaluation budget when queued PRs lead an open-PR page.
- Queue keys include the head SHA, review-request generation, and a unique write
  revision. Scheduled terminal settlement removes the evaluated revision plus
  same-generation revisions captured before evaluation, while preserving writes
  that race in afterward.
- A still-pending settlement compacts same-head, same-generation revisions from
  its snapshot to one key, preventing webhook retries from inflating the queue.
- A scheduled closed-PR evaluation removes every revision in its pre-evaluation
  snapshot. A revision hidden by KV eventual consistency is handled by the next
  sweep instead of being deleted unsafely after a concurrent reopen.
- GitHub installation-token rate limits, rather than Workers Paid execution
  limits, determine the conservative per-run PR budget.

See [ADR 0001](decisions/0001-prioritize-pending-reviews.md) for alternatives
and the cost model.
