# ADR 0001: Prioritize pending reviews with Workers KV

- Status: Accepted
- Date: 2026-07-16

## Purpose

PR-body reactions do not wake Review Gate through a standalone GitHub webhook.
The original scheduled sweep rotated across all installed repositories with a
budget of four repositories and two PRs every three minutes. A valid clean
reaction could therefore wait through many rotations, with no configured
reaction-to-status latency bound.

## Alternatives considered

1. Increase the repository and PR sweep caps.
   - Simple, but GitHub API usage grows with every installed repository and open
     PR. It still provides no tight latency bound under growth.
2. Poll for longer inside the webhook `waitUntil()` task.
   - Avoids storage, but Cloudflare only extends work for up to 30 seconds after
     the HTTP response. Reviewer reactions can arrive later than that.
3. Replace the Worker with GitHub Actions polling.
   - Adds per-repository workflow setup and burns Actions capacity for idle
     waiting.
4. Store pending PR heads in Workers KV and prioritize them in the existing
   cron. Keep the rotating sweep as a fallback.
   - Adds one managed binding and accepts KV eventual consistency, but makes
     GitHub API usage proportional to active reviews rather than repository
     count.

## Decision

Choose option 4. When a webhook evaluation ends in `pending`, store the GitHub
installation, repository, PR number, and head SHA in KV metadata with a 24-hour
TTL. The scheduled handler lists those records and evaluates them alongside the
rotating open-PR fallback using separate budgets. Queue keys include both the
head SHA and latest review-request generation. Terminal settlement deletes only
the generation it evaluated, so an older evaluation cannot delete a newer
review request on the same head. KV listing follows cursors so queues larger
than one page remain reachable.

KV is optional at runtime: if the binding is missing or listing fails, the
existing open-PR sweep still runs with its full budget.

## Cost and limits

On the base $5/month Workers Paid plan, the three-minute cron performs about
14,400 KV list operations per month for a one-page queue. Cursor pagination is
capped at ten pages, putting the implementation ceiling near 144,000 list
operations per month, below the included 1 million list operations. Each active
pending head normally costs one KV write and one delete, also below the included
monthly allowances. The queue stores its payload in list metadata, avoiding a
separate KV read for every record.

Workers Paid allows far more subrequests and cron duration than this Worker
needs. The tighter operational constraint is the GitHub App installation-token
rate limit, which starts at 5,000 requests per hour. Prioritizing active pending
reviews reduces GitHub API use compared with raising broad sweep caps.

## Trade-offs

- KV changes may take up to 60 seconds to propagate across locations. With a
  three-minute cron, the expected reaction-to-status delay is one of the next
  priority sweeps rather than a repository-wide rotation.
- A pending entry can be retried more than once while the review is genuinely in
  progress. The existing status comparison avoids redundant status writes.
- Pending and fallback paths each evaluate at most two PRs per default cron, so
  neither path can consume the other's budget.
- Expired, malformed, or temporarily unavailable queue state falls back to the
  rotating open-PR sweep, so KV is not the sole recovery path.

## References

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [Workers KV list API](https://developers.cloudflare.com/kv/api/list-keys/)
- [GitHub App rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github-app-installations)
