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

The queue is an optimization, not a new authority. GitHub remains the source of
truth, and every scheduled retry re-fetches the current PR, reviews, reactions,
threads, and timeline before changing the status.

The optional settled-disposition signal is also derived only from current
GitHub evidence. It requires a round anchor — the latest-head request comment
when one exists, or the latest head boundary itself for an auto-fired round
with no request comment anywhere — then a later non-dismissed formal bot
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
