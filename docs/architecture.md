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
- `src/review-state.js` parses versioned full-head Code Review metadata for
  binding separate clean signals; a summary alone never grants authority.
- `src/base-sync.js` proves exact reviewed/base tree overlays and complete text
  comparisons from immutable objects; it makes no network or status calls.
- `src/base-sync-github.js` collects those objects through `RepoClient` when the
  ordinary gate lacks clean authority. Historical review and lifecycle authority
  remains in `src/gate.js`.
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
allowlisted human. Either recorded PR SHA changing invalidates the signal. No extra
invalidation store or mutation authority is introduced.
Known current-head running Code Review also blocks settlement, and later
non-clean state invalidates an older attestation. Findings already known before
the human attestation remain eligible under the existing exact-pair policy.

## Base snapshots and merge protection

`pull_request.base.sha` is the PR's recorded base snapshot, not a read of the
live branch ref. The settlement binds to that snapshot. Same-base sibling
evaluation on merged-PR close and the scheduled fallback for direct base pushes
re-fetch the snapshot; neither guarantees invalidation merely because the live
base advanced. This is a limitation of the existing settlement binding.

The merge-safety assumption is enforced strict up-to-date required checks
(`strict_required_status_checks_policy`, or classic protection's `strict`). A
required update push refreshes the PR snapshot and invalidates a settlement for
the old head/base pair. This assumption does not cover bypassed protection or
direct pushes. Without strict mode the stale-base gap remains. Proposed remedies
are owner-managed strict protection or a separately approved settlement binding
to live base-ref evidence with a publication recheck; neither is changed here.

Read-only default-branch checks at 2026-11-04 17:29 UTC found strict required
checks enabled only on aimstrings-web/main. aimstrings-docs/main had strict
disabled; rmo-ai-web/main, rmo-center/main, rmo-maestro/main,
bloodmoon-blowfish/master and review-gate/main had no required-status protection.
This is the six owner-listed installations plus the observed self-installation,
not an independently enumerated complete App inventory. The docs/web required
review contexts had no integration-ID pin. Propose owner-managed publisher
pinning as well as strict checks; no protection setting is changed here.

## Verified base sync

`BASE_SYNC_REVIEW_ENABLED` is false when absent; only an explicit `true` enables
carry. The owner approved this default so deployment alone cannot change clean
authority across installations before consumer rules and App permissions are
ready. Disabled carry makes no graph/tree proof reads.

When no direct clean or settled result applies, a two-parent merge can carry an
explicitly bound completed clean review of R. The first-parent chain contains
only verified sync merges. Every second parent M is an ancestor of a freshly
read live base tip L. Every merge is compared with R, including after earlier
carried successes. Each older integrated M must be an ancestor of the next M;
otherwise an exact overlay on a backward/divergent base could discard earlier
base changes. Equal bases are allowed when the exact tree is preserved.
Complete compare file/patch evidence and recursive Git trees
prove disjoint base/PR paths and an exact overlay, including file modes and
terminal empty-subtree entries. Ordinary directory structure follows its
children; empty subtrees cannot disappear from the comparison. Unrelated base
empty trees are preserved, while PR empty-tree changes lack supported patches. A
missing permission, capped file list, binary/missing/truncated PR patch,
truncated tree, API error, or malformed evidence supplies no carry authority.

R needs a fully bound actual clean source: a non-dismissed full-SHA clean formal
review, a full-SHA clean comment, or a separate clean signal with matching
completed full-SHA summary metadata. A bare reaction, unbound comment,
settlement, or carried status supplies no historical authority. Drafts, threads,
later requests/findings/in-progress signals, and force boundaries prevent carry,
including rounds before the latest sync that its new head boundary could hide.

The carried status names R and N's integrated M, records full R/M/N/L in details,
and links to R's review. All review/lifecycle inputs are refreshed after Git
collection. Publication then re-reads PR head, recorded base, base
repository/ref, non-draft state, and L. Closure alone preserves immutable
coverage, matching direct review. A moved head abstains; other identity
changes or an unreadable live ref prevent the prepared success and report a
retry failure. GitHub has no atomic read-and-publish operation, so strict merge
protection and required CI still matter after the final recheck. Contents: read
and owner-approved installation consent are prerequisites for private objects.
No new KV record, webhook subscription, or mutation authority is introduced.
Configured-Bot comment edits/deletions already trigger evaluation, including
summary edits. Created summaries receive normal evaluation; the separate
three-second clean-receipt retry remains limited to clean receipts. Reactions
without a webhook use the existing pending/fallback sweeps. Retry-required
publication failures recover through subsequent events or the fallback sweep.
Disabled/raw non-boolean configuration and missing timeline heads stop before
graph reads; temporal checks precede comparisons/trees. Immutable reads are
deduplicated within one evaluation, not persisted across evaluations.
See [ADR 0005](decisions/0005-carry-clean-review-across-base-sync.md).

## Direct review authority

The same change closes the existing backdated-commit/reused-reaction path.
Hardening applies independently of the carry switch. Direct success and carry
share full-head clean sources; commit dates and timeline positions never prove
head identity. Submitted clean formal reviews and separate full-SHA clean
comments are independent sources. For short/unbound receipts or `+1`, one
canonical `codex-review-state:v1` summary must identify the full reviewed head,
completed Code Review, and both findings flags false. Join only a separate clean
signal from the same numeric configured Bot actor. No mutable Git ref lookup or
preceding non-clean formal review can establish this binding.
Reaction responses can report `type: "User"` for the same numeric actor whose
comment/canonical profile is `Bot`. Authenticate reactions by their configured
login and ID joined to the Bot summary, never by reaction type. Positive comment
and formal-review authority still requires Bot records. Uncertain account type
cannot discard configured-reviewer responses, pending reviews or conflicting
comment copies from the blocking side of evaluation.

Summary metadata is a binding, never a signal/response by itself (ADR 0002).
Validate its canonical marker/version, unique actor summary, full SHA, Completed
row/commit agreement, and completion timestamp. Unknown/malformed/conflicting
state supplies no binding. A known newer Running or non-clean Code Review
state retracts older same-head authority without becoming a review response.
Optional Security Review is a separate role. The
receipt may precede the row's completion; use the earlier signal/completion
second for invalidation, so both must follow server request/ready/force
boundaries. Board updates by another role cannot refresh completion. Newer
in-progress signals or superseding responses and ambiguous same-second order
block success. Both issue-comment API representations share the policy.

The separate reaction is presence plus a freshness cap, not proof of a new run.
The provider's exact-head completed clean state supplies coverage. No per-run
reaction delete/recreate behavior is assumed. Row time is a provider assertion;
signal time is GitHub-stamped. Using their minimum prevents a newer board/row
from refreshing an older signal and still assumes truthful provider state and
timing. It does not eliminate every cross-provider clock assumption. Row time
after the board update second fails closed with a specific diagnostic.

Explicit results for heads outside R→N cannot retract this coverage, including
ancestors predating R.
R, intermediate syncs, N, and unknown/prefix-colliding identities remain subject
to the blockers. Direct evaluation scopes explicit responses to its current head.

A receipt awaiting its binding preserves the existing requested/eyes pending
queue within the existing review-start window. An unbound plausible result
with persistent weak in-progress evidence becomes a diagnostic failure after
that window; expiry never grants completion or settlement. Known running Code
Review stays pending. An independently verified historical source can still
carry. Malformed state returns reason codes; unavailable/malformed binding warns
once per non-success evaluation without comment bodies. A summary alone never
ends the wait. Formal
pending state blocks older authority. Exact-pair human settlement remains a
separate authorized path and cannot establish carry's R. Direct summary binding
uses existing permissions; Contents read is only needed for the optional Git
proof. The recorded public summary/receipt in tests supplies actual provider
format evidence, not a claimed stable public API guarantee. Provider changes
fail closed rather than being inferred from rendered prose.
An all-null never-run Code Review slot is absent evidence, not format drift.
On deployment, legacy abbreviated receipts without v1 full-head metadata need
fresh review unless independent full-SHA clean evidence survives. This applies
even with carry disabled. Public manual reviews #12/#14 supplied receipts;
automatic-ready #13 supplied only a summary and a User-shaped `+1`. Static
records establish these examples, not universal reaction/review lifecycles.

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
