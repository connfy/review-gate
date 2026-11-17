# ADR 0006: On-demand API-credit native Codex reviews

- Status: Accepted scope; local implementation, not deployment/activation
- Date: 2026-11-17
- Owner decision, paraphrased: build a dedicated GitHub App reviewer using the
  existing API-credit route when hosted Codex review has no plan allowance;
  report material actionable introduced defects and otherwise pass cleanly.
- Owner amendment, paraphrased: drop historical-PR calibration; use mock tests
  and at most one dry-run smoke on live web PR #586. First real reviews wait for
  coordinator App setup. Do not push, deploy or post during this build.

Number 0005 belongs to the existing parallel base-sync workstream; this ADR does
not change or incorporate that unmerged work.

## Decision and rationale

Use the existing `codex-credit` wrapper and native `codex exec review` engine,
not a custom bug-finding prompt or another review model. Native material-bug
criteria already prefer no findings over speculation. Only actionable P0–P2
defects introduced by the diff open inline threads. No minimum count, repeated
clean-pass loop, confidence cutoff, P3 thread or cosmetic gate is introduced.
P3 remains visible in local evidence and never becomes a blocker because its
location or overall label disagrees. Malformed/incomplete evidence and an empty
incorrect result remain unusable; a valid nonempty finding set is classified by
its severities, not coupled to the model's overall label.

A trusted local controller freezes SHAs, fetches into its own temporary object
repository/worktree, isolates model tools from credentials, and preserves raw
evidence. A separate publishing step in trusted code authenticates as the
dedicated App, rechecks live head/base/ready state, and submits exactly one
`COMMENT` Review with explicit `commit_id` and inline blockers where possible;
unanchorable blockers remain in its body rather than being lost. The publisher,
not the model, emits clean text. Only the existing Review Gate App writes status.
The new identity is paired login plus numeric Bot ID and is valid only for
formal submitted exact-head Reviews, not legacy comments or reactions.

## Implementation choices (agent-selected within that scope)

- Sparse Bubblewrap runtime plus native read-only/no-network tool sandbox;
  no project trust/MCP or inherited host/GitHub/App credentials. Read applicable
  review guidance from the frozen base, so a PR cannot replace reviewer control
  instructions. Revisit if trusted policy sources or CLI instruction loading
  change; never infer that read-only filesystem access alone protects secrets.
- Version-pinned native-session adapter. The inspected CLI does not forward
  `--output-schema` to the review task, its public JSON stream renders prose,
  and its root usage omits review-child token usage. Read the linked review
  child's original completed JSON and usage; keep the wrapper ledger unchanged
  plus an append-only native-usage reconciliation ledger. Require matching
  lineage, version, head, cwd, selected model/effort and completed runtime before
  treating evidence as a result. Revalidate on CLI upgrade, not by adjusting
  malformed output into a pass.
- Command-only trigger and a single-host per-head lock/remote signed-review
  deduplication per shared freshness generation, with generation-bound local
  receipts. New same-head requests/restores must expire deduplication when they
  expire gate authority. Persist POST intent, refuse automatic retries after ambiguous
  publication. Multiple hosts require coordination rather than pretending the
  GitHub POST endpoint provides atomic idempotency.
- Frozen base is comparison provenance and a pre-publication race check, not
  an added post-publication base-staleness gate. Preserve existing direct hosted
  review semantics and branch/CI/settlement freshness rules.
- Repository authorization is independent of App installation scope. The
  coordinator reported the owner's all-connfy installation decision on
  2026-11-17; the owner then asked that every connfy repository may use it, so the
  runner defaults to the `connfy` account (configurable owner and repository
  allowlists), enforcing that allowlist before credentials/network/model
  work and again at controller/publisher boundaries.

## Alternatives

- API-backed generic `codex exec --output-schema`: documented structured output,
  but would replace the native review engine/rubric unnecessarily.
- Actions reviewer or shared `github-actions[bot]`: spends Actions capacity and
  does not identify this specific authorized reviewer. Not selected.
- Parse the human clean sentence or zero outer usage: contradicted by source
  and the real smoke; loses failure information and misstates API consumption.
- Repeated historical LLM comparisons: explicitly removed by the owner. No
  semantic-parity or false-positive-rate claim follows from mocks or one smoke.

## Operational evidence still required

The coordinator has created/installed the App and supplied its identity; the
worker did not perform those external actions. Worker activation, a published
exact-head Review and resulting Worker status remain coordinator steps, not
authorized by this build/review-fix round. The first-use runbook is
[API-credit reviewer](../api-credit-reviewer.md); it names docs #999 and web #586.
