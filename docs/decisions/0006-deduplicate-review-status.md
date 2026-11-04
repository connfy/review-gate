# ADR 0006: Deduplicate review status publication with trusted App provenance

- Status: Proposed
- Date: 2026-11-04

## Purpose

Scheduled review sweeps already compared status text before publishing, while
webhook evaluations always appended a new commit status. Repeated deliveries,
review-start retries, and merged-PR sibling evaluations could therefore publish
the same result repeatedly. Every write emits a GitHub `status` event and can
start consumer workflows, even if their jobs later skip or reuse a result.
Repeated evidence must not create a new publication unless the App needs to
establish or change its own gate result.

Text alone is insufficient. A human or another App can publish the same context
with identical text. Suppressing the gate's write in that case would leave the
other creator in control of a context whose consumers trust this GitHub App.

## Decision

- Route webhook, retry, sibling, and scheduled review publication through one
  decision. Compare the latest status for the context, ignoring context case.
  Suppress only an identical state, published description, and target link
  whose numeric creator ID is this authenticated App's bot ID. Missing or
  different provenance always requires a write. Target-link changes include
  removal: a settled-disposition link is the audit trail for the attestation.
- Derive identity from the existing runtime credentials. Authenticate `GET /app`
  with the App JWT, verify its App ID, then resolve the returned slug's bot user
  with the installation token. Require a positive numeric ID and a matching
  Bot login. Do not use a deployment slug, review-bot setting, or PR evidence
  as the publishing identity. These endpoints require no added installation
  permission or owner configuration.
- Cache the successful numeric identity by App ID in one entry per Worker
  isolate. Coalesce concurrent requests and discard failed lookups. The entry
  is bounded independently of installation count. The numeric ID survives an
  App rename, so a time-based expiry would add reads without strengthening the
  comparison. A different App ID replaces the entry. Only identical content
  needs identity resolution; a cold lookup costs two requests.
- Treat comparison reads as an optimization. Failed status or identity reads
  log an error and fall back to writing the evaluated result. Status history is
  newest first, so latest-status lookup stops at its first matching page.
  Absence within the existing 1,000-status limit cannot suppress a write.
- Preserve publication safety. After optimization reads, every success checks
  the live PR head and base, even if the existing status would be suppressed.
  A moved head abstains; a moved base unconditionally writes the existing
  "Pull request changed during evaluation; retry required." failure. A failed
  live PR read remains an evaluation failure. Keep the reporter's boolean
  publication result and count mandatory-failure writes correctly in sweep
  summaries.
- Keep review retries, pending KV tracking, and queue settlement independent of
  suppression. Every current-head retry reaches the shared publisher, which
  also detects changed links or changed creators between evaluations.

## Alternatives considered

1. Keep webhook writes unconditional. This preserves redundant `status` events
   and makes identical evidence start unnecessary consumer runs.
2. Compare text without its creator, or trust a configured deployment slug.
   Text cannot prove who published it; a slug is mutable and would add owner
   configuration where the authenticated App already supplies authority.
3. Apply a cooldown, per-SHA counter, or webhook-only exception. A count or
   deadline cannot decide whether the gate's meaning or provenance changed,
   and could hide a legitimate change.

## Consequences and limits

- An unchanged own result produces no new `status` event. Consumer workflows
  must recover lost or failed runs with a rerun or explicit dispatch. The
  inspected AimStrings docs and web workflows provide `workflow_dispatch`, and
  the docs' CI guide describes reruns; duplicate publication is not their
  recovery contract. Those repositories are unchanged by this decision.
- Suppressing a sibling's unchanged success also removes that duplicate's
  opportunity to run CI. It is not a reliable base-advance validation contract:
  the inspected workflows resolve the PR API's recorded `base.sha`, not the live
  branch ref, and reuse the existing check for the same recorded pair. Repeated
  statuses cannot refresh that snapshot. Strict up-to-date protection must
  enforce the update push; without it, the existing stale-base gap remains.
  If the recorded pair does change, changed gate output still publishes, and
  explicit rerun/dispatch remains the documented recovery path.
  Retargeting a PR or another same-head snapshot change is not itself a change
  to an ordinary clean status's text. If that operation needs new CI without
  a head push or status meaning change, use explicit dispatch; unchanged status
  redelivery is deliberately no longer a retrigger contract.
- GitHub offers no atomic compare-and-publish for commit statuses. Concurrent
  evaluations can both write before either sees the other; a later evaluation
  sees the identical own status and stops. This is convergence, not an
  exactly-once guarantee.
- Identity-read outages preserve gate publication but can temporarily restore
  duplicate writes and their consumer events. A later successful lookup can
  resume suppression; failed identity requests are never cached.
- Description comparison follows the existing 140-character publication limit.
  Changes outside the published description cannot change the visible status.
- An unchanged sweep success now receives the same live PR check as a webhook.
  A racing base change can therefore publish the mandatory retry failure; the
  next event or rotating fallback re-evaluates it. A suppressed write never
  turns that safety failure into success or a pending queue result.
- CI budget status meaning, sticky history, cancellation, and permissions are
  unchanged. Full-history callers do not use the latest-status short circuit.
- Tests use generated ephemeral RSA keys and mocked GitHub responses. They
  verify JWT authentication, private-App identity resolution, cache behavior,
  signed webhook routing, both sweeps, races, and error fallback. Live App
  identity lookup and deployment acceptance remain separate verification.

## References

- [GitHub: Get the authenticated App](https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app)
- [GitHub: Get a user](https://docs.github.com/en/rest/users/users#get-a-user)
- [GitHub: List commit statuses for a reference](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference)
- [GitHub Actions: status event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#status)
