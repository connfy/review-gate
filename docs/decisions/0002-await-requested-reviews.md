# ADR 0002: Await requested reviews

- Status: Accepted
- Date: 2026-09-29

## Purpose

ADR 0001 prioritizes heads whose evaluation is `pending`, so a late PR-body
`+1` is seen on the next scheduled sweep. A freshly requested review did not
reliably reach that state:

- Codex now creates a live summary comment when a PR's first review starts,
  then edits it in place. The gate counted that comment as the bot's response,
  so an `eyes` reaction placed before it no longer meant "in progress".
- A review requested by marking a draft ready produced no in-progress signal the
  gate recognized.

Such a PR evaluated to `failure`, stayed out of the priority queue, and its
reaction-only clean result waited for the rotating fallback. One observed ready
transition stayed red for 16 minutes after the clean `+1`, until an unrelated
PR edit triggered a re-evaluation.

## Decision

- The configured status-board comment (`REVIEW_STATUS_BOARD_MARKER`) is never a
  review response.
- A review requested for the current head is `pending` until the review bot
  responds, for at most `REVIEW_START_WINDOW_MS` (20 minutes by default).
  - The request is the latest of PR creation, a `ready_for_review` timeline
    event, and a review-request comment. All three carry server-generated
    timestamps.
  - A request older than the head boundary does not count, because a push does
    not start a review.
  - Drafts and unresolved current threads still fail first.
- The pending result enters the existing KV priority queue unchanged. The
  queue's keys, settlement, and race handling are untouched.

## Trade-offs

- The awaited state can only turn a `failure` into `pending`, never into
  `success`, so it cannot admit a merge the old policy blocked.
- Excluding the status board also tightens the settled-disposition rule. A
  settlement posted while the bot's `eyes` is newer than every real response is
  now refused as "review in progress". Previously the board comment falsely
  ended the review and let it pass. This is the rule the settlement already
  states.
- A stalled review now reports `pending` for up to the window before it turns
  red. Twenty minutes covers normal reviews and matches the stall threshold the
  connfy PR loop uses.
- Every requested review now occupies a priority-sweep slot while it runs.
  Queue growth tracks active reviews, as ADR 0001 intended, rather than
  repository count.
