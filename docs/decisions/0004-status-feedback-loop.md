# ADR 0004: Keep CI budget statuses from feeding status-triggered workflows

- Status: Accepted
- Date: 2026-10-23
- Amends: [ADR 0003](0003-ci-duration-budget.md)

## Purpose

With ADR 0003 enabled, an installation exhausted its GitHub REST rate limit, so
every review-gate evaluation failed. A repository had a workflow triggered on
`status` events whose job `if:` proceeds only for one specific status. GitHub
starts one run of such a workflow per status event in the repository and
attributes it to the default-branch HEAD. Each run's `workflow_run` deliveries
were evaluated, and each evaluation wrote a new budget status on that HEAD
because the comparison with the latest status included `target_url`, which is
unique per attempt. That write was another `status` event, so it started the
next run. Every external status event began a new chain, and the chains
accumulated until the rate limit stopped them. Most of those runs executed no
job at all, yet each still produced a proactive success.

A CI budget evaluation must never be able to sustain or multiply such a chain,
while breaches stay sticky and status-triggered runs stay under the budget.

## Alternatives considered

1. Cap budget status writes per SHA or per time window.
   - The cap is an arbitrary threshold, still writes redundant statuses up to
     it, and would suppress a real breach that arrives after the cap.
2. Publish no budget status for runs triggered by `status` events (or for any
   run whose `head_sha` is the default-branch HEAD).
   - Removes the direct edge structurally. But report mode would then keep no
     durable record of exactly the long status-triggered runs the budget exists
     for, and cancel mode would cancel them with no status explaining why on the
     commit where GitHub shows the run. The attribution concern equally applies
     to `schedule`, `repository_dispatch`, and `workflow_run` runs, so an
     event-specific exception has no principle of its own once publication is
     idempotent.
3. Make publication idempotent and claim nothing without measured execution;
   triage deliveries before any I/O.
   - Closes the loop for every trigger without a special case or threshold, and
     cuts the cost of runs that executed no job.

## Decision

Choose option 3.

- **Publish only changes of meaning.** A status means its state and
  description; `target_url` is provenance. A status is written only when the
  state or description differs from the latest one; a sticky breach is still
  restored from history, and success never overwrites it. Descriptions depend
  only on the verdict and the budget setting, so apart from the concurrent
  evaluations described below, a SHA receives at most one success and one
  failure per budget setting, plus the existing overlap repair, however many
  runs are evaluated. An unchanged status keeps the link to the attempt that
  first established it.
- **No claim without an executed job.** The budget measures executed jobs.
  While none has started (queued, waiting, skipped, or cancelled before
  starting) there is no duration to judge, so nothing is published. GitHub
  concludes a run `skipped` only when none of its jobs started, so that
  conclusion settles the run from the run object alone, before any jobs read.
- **`requested` does no work.** No job has started, so there is nothing to
  measure or schedule. It makes no KV or GitHub API call; `in_progress` queues
  the attempt as before.
- **The delivery that sees an attempt finished settles it.** A completed attempt
  is immutable and its signed payload is GitHub's final record of it. The
  `completed` webhook evaluates from that record (no attempt read), and a
  `skipped` conclusion needs no API call at all. Only a failed evaluation is
  queued for a scheduled retry. Whichever delivery sees the attempt finished,
  normally `completed` but also an `in_progress` processed after completion,
  deletes the attempt's queue entry (and its cancel receipt after a breach), so
  finished and job-less runs do not occupy the capped sweep. That delete can
  follow an `in_progress` enqueue of the same attempt within KV's
  one-write-per-second-per-key interval, so it is retried once after that
  interval. An entry that still remains is settled by the sweep, as before.
- **Status-triggered runs remain budgeted.** They are queued on `in_progress`
  and cancelled at the budget in cancel mode like any other run. Their status
  lands on the default-branch HEAD. A proactive success there is not what pull
  request protection evaluates, but it is harmless and written at most once per
  HEAD and budget setting. A breach there is meaningful: it is where GitHub
  attributes the run, it is the durable explanation of a report or
  cancellation, and status-triggered workflows run from the default branch, so
  the fix lands as a new default-branch commit, matching the sticky-until-new-SHA
  rule.

## Trade-offs and limits

- Proactive green appears when the first evaluation sees an executed job (the
  `in_progress` webhook or the next sweep), not while the attempt only waits for
  a runner.
- A commit on which no job executes, because every job of every workflow was
  skipped by its `if:`, now receives no budget status, whereas a skipped run
  used to publish a proactive success. Requiring the context blocks such a
  commit, so the README limits that advice to commits that run at least one
  job. This follows from claiming nothing without measured execution.
- Each budget status change still emits one `status` event, so a status-triggered
  workflow runs once more per change. Job-level `if:` filters make those runs
  skipped and free; the README documents this.
- Evaluations that read status history before a concurrent write lands can each
  publish the same meaning once. The next evaluation sees it and writes nothing,
  so the chain converges instead of multiplying.
- An active attempt whose `in_progress` delivery is lost is not queued and
  cannot be cancelled; its completion is still reported. Redelivery restores
  tracking. A KV-only enqueue on `requested` would back up that delivery
  without an API call, but it would put every run, including every skipped
  status-triggered run, into the queue and make each one depend on settlement.
  It was not adopted.
- A `completed` delivery whose Worker is stopped mid-evaluation (rather than
  failing with an error) queues no retry unless `in_progress` already queued
  the attempt.
- Two deployments that write the same status context with different budgets
  disagree on the success description and can keep rewriting it whenever a
  status-triggered workflow executes a job for those events. Each deployment
  needs its own context, as the README states.
- Not verified against live GitHub: whether `in_progress` is delivered for runs
  whose jobs are all skipped. Either way such a run publishes nothing, and the
  delivery that sees it finished removes its queue entry; one left behind costs
  the sweep one attempt read.

## References

- [GitHub events that trigger workflows: `status`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#status)
- [GitHub workflow-run webhooks](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run)
- [GitHub check conclusion `skipped`](https://developer.github.com/changes/2020-05-08-skipped-conclusion)
- [Workers KV write limits](https://developers.cloudflare.com/kv/platform/limits/)
