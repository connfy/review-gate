# ADR 0005: Carry a clean review across a verified base sync

- Status: Accepted design (owner approval in this task, 2026-11-04); implementation under review
- Date: 2026-11-04
- Scope: Review authority, immutable GitHub evidence, and documentation; no deployment or ruleset changes

## Problem and authority

Strict required checks require an open PR to integrate an advancing base before
merging. A base-only merge changes the head without changing the reviewed PR
patch, but previously always required another Codex review.

The owner requested avoiding that redundant review. The invariant is that carry
must never cover an unreviewed PR-authored change. The agent proposed the
conservative disjoint-path/tree proof below; the owner approved it before
implementation. The owner subsequently approved fixing the existing backdated
commit/stale `+1` authority bug in this change and keeping carry off by default.
Parsing and evidence choices below are implementation decisions, not additional
owner policy rulings. Existing exact-pair human settlement remains separate.

## Qualifying merge proof

R is an original full-SHA clean-reviewed head, N the current head, and L the
live base tip. Follow N's ordered first parents to the nearest eligible R.
Every intervening S must have exactly two parents [P, M]. P is R or another
sync in this chain; a previously carried success never establishes review
coverage. Every sync is checked against original R, including the second sync.

For each S require:

1. Read L from the current base repository/ref. M must be an ancestor of L;
   the PR's recorded `base.sha` cannot supply this fact. Across adjacent syncs,
   the previously integrated M must also be an ancestor of the next M. Merely
   belonging to L is insufficient: an older or divergent M could discard
   already integrated base changes while preserving R's patch. Equal M is
   harmless when the exact overlay stays unchanged.
2. Let B be the merge base of M and R. Complete tree deltas B→R and B→M
   must have disjoint paths, including both rename sides and file/directory
   collisions. This intentionally excludes overlapping edits even when a
   conflict resolution looks reasonable.
3. Complete comparisons M...R and M...S must have identical paths, statuses,
   rename sources, additions/deletions, and text patches. Only hunk starting
   line numbers are normalized; counts, context, whitespace, line endings,
   and no-newline markers remain significant.
4. S's complete tree must be the exact overlay of R's PR delta onto M: each
   PR-changed leaf has R's object SHA, type, mode, or absence, and every other
   leaf has M's entry. Compare the union of all tree paths, not just API files.
   Terminal empty subtrees are atomic entries too: ordinary leaf-only maps
   would erase an extra empty directory hidden in the merge. Unrelated base
   empty subtrees are preserved; PR empty-subtree changes lack supported text
   patch evidence and take the normal path. Check empty-tree object identity
   against its claimed lack of children.

Disjoint blobs normally also produce identical hunk positions; normalization
is only a patch-format comparison rule and grants no exception to the tree
proof. Patch equality alone misses modes or omitted files. The independent
overlay rejects evil merges, hidden additions, conflict edits, mode changes,
and other unreviewed merge content. It preserves review coverage, not semantic
compatibility: required CI must still check the integrated result.

## Shared direct and historical review authority

Use fully paginated current review/comment/reaction inputs from this PR.
Establish a configured Bot identity from a `user.type === "Bot"` comment or
formal-review record. A reaction joins its numeric ID to the canonical Bot
summary: GitHub's actual reaction API can type that same actor as `User`.
Each source establishes a full 40-character reviewed SHA through one of:

- A non-dismissed, submitted clean formal review with that full `commit_id`.
- A separate clean issue/timeline comment with `**Reviewed commit:**` followed
  by that full SHA in backticks (the supported receipt syntax).
- A separate clean comment or PR-body reaction joined to the same numeric Bot
  actor's canonical versioned Codex summary, as described below.

The recorded PR #13 `+1`, its summary author, and the canonical user profile
have identical numeric ID 199175422 but reaction type User versus comment/profile
type Bot. This is an endpoint representation difference, not permission to trust
human reactions. Missing binding or a different ID supplies no authority.
Positive comment/formal sources retain their Bot requirement. Blocking responses,
pending reviews, and conflicting comment copies are not discarded merely for
uncertain account type. Thirty actual Codex formal reviews and PR #12's Bot
timeline comments were checked; all reported Bot, unlike reactions.

No Git branch/tag name or abbreviated commit lookup establishes identity.
`GET /commits/{ref}` accepts mutable names: even before/after namespace probes
cannot make it an immutable SHA-prefix proof. A non-clean formal completion
plus a later unbound signal also cannot identify which overlapping round that
signal finished. Neither path is used.

Codex's recorded public summary contains `codex-review-state:v1` JSON with
`code_review.commit_sha` as a full SHA. Binding requires `status: "completed"`
and both `has_any_findings` and `has_unresolved_findings` exactly false. Require
one canonical summary per numeric actor, the board marker on its first line,
one v1 state record on the next line, and one Completed Code Review row whose
abbreviated display agrees with the full SHA. The row's timestamp must parse
and cannot be later than the comment's update second. Missing, malformed,
unknown-version, contradictory, running, non-clean, or conflicting snapshots
provide no binding. A known newer non-clean or Running Code Review state
invalidates older same-head clean authority without counting as a response.
Only the Code Review row timestamps that state; a later independent clean
completion may supersede it. Optional Security Review state is a separate role and
cannot supply or replace Code Review completion.
An explicitly all-null, never-run Code Review slot is absent evidence rather
than malformed state; it supplies neither positive nor negative completion.

The separate receipt/reaction must have the same numeric Bot actor. A receipt's
short label only cross-checks the full structured SHA; it never resolves through
a mutable namespace. The board alone is still neither a clean signal nor a
review response under ADR 0002. If the provider overwrites historical R's state
and no independent full-SHA clean source survives, carry is unavailable.

For reactions, this is presence plus a freshness cap, not proof that a new run
occurred. Full-head completed clean Code Review metadata supplies coverage;
an old `+1` cannot substitute for it. Static recordings do not establish whether
Codex deletes/recreates reactions per run, so no such lifecycle is assumed.

The public PR #12 and #14 receipts precede their Completed rows. Do not
invent a timestamp tolerance or require receipt-after-summary order. Use the
earlier of signal creation and Code Review completion (floored to API seconds)
for invalidation, so **both** must follow the relevant server boundary. Never
refresh a signal using the board's `updated_at`: another review role can edit
it later. A stale signal cannot cross a newer request even if the board changes.
This explicit full-head completion evidence closes the old backdated Git-date
path; author/committer dates and timeline order cannot authorize success.
The row is the provider's timestamp assertion and the signal is GitHub-stamped.
This assumes truthful provider state/timing; `min()` prevents row/board updates
from refreshing an older signal, not every possible cross-provider clock error.
The row-vs-update check is a fail-closed consistency check, with a diagnostic
reason when it fails; no invented clock-skew grace interval is allowed.

Direct success and carry share this source factory. Requests, ready/force/
restoration events, later findings, unresolved threads, drafts, pending formal
reviews, and newer in-progress signals still block. Unknown or same-second
superseding order fails closed. Carry also checks requests/responses across
the entire R→N chain, so a second sync cannot hide an intermediate pending
round. Comment/timeline copies must be consistent. A normal authored commit
interrupts the chain. A settlement or previous carried status never establishes R.
Explicit responses for heads outside R→N, including R's earlier PR ancestors,
cannot supersede this coverage. A
full-SHA formal review or one valid receipt label establishes that exclusion;
unknown or prefix-colliding identities remain conservative. Direct evaluation
uses the same scope rule for its current head.
A receipt awaiting its binding stays in the existing requested/eyes pending
queue within its existing review-start window. If a plausible current-round
result remains unbound after that window, report identity-verification failure
instead of retaining an indefinite weak-signal pending state. Expiry is never
completion, settlement authority, or a clean source, and does not prevent an
independently verified historical carry. A known running Code Review remains
in progress. A board alone never ends the requested wait.

Known current-head Running state also blocks settlement until an actual later
response supersedes it. Later non-clean state invalidates an older same-head
attestation; known findings that preceded the attestation remain settleable
under the existing exact-pair policy. Closing a PR alone changes neither its
immutable coverage nor these blockers, matching direct-review behavior.

## Exact read API plan

All reads use the existing installation token; no key file, local Git trust
record, KV authority, merge, or mutation constructs the proof. Immutable objects
are deduplicated only within one evaluation. Live refs are reread for publishing.

| API | Required evidence |
| --- | --- |
| Existing PR, paginated issue comments/reviews/reactions/timeline, and GraphQL review threads | Full-head review source and all existing blockers; summary binding uses these existing reads. |
| `GET /repos/{owner}/{repo}/git/ref/heads/{encodedBaseRef}` | L in the PR's current base repository; require a full commit ref. |
| `GET /repos/{owner}/{repo}/git/commits/{fullSha}` | Ordered parents and tree SHA for N, R, each S/M/B, and L; returned SHA must match. |
| `GET /repos/{owner}/{repo}/compare/{M}...{L}?per_page=100&page=1` | `ahead` or `identical`, base and merge-base M, proving M belongs to L's history. Files are unused for ancestry. |
| `GET /repos/{owner}/{repo}/compare/{olderM}...{newerM}?per_page=100&page=1` | Across adjacent syncs require `ahead`/`identical` and merge-base olderM. Reuse the live-tip comparison when the pair is identical. |
| `GET /repos/{owner}/{repo}/compare/{M}...{R}?per_page=100&page=1` | B and original PR patch/file list; full-SHA request and complete tree delta cross-check. |
| `GET /repos/{owner}/{repo}/compare/{M}...{S}?per_page=100&page=1` | Merge-base M, complete merged PR delta, and comparison with M...R. |
| `GET /repos/{owner}/{repo}/git/trees/{treeSha}?recursive=1` | Complete B/R/M/S tree maps; require matching root, `truncated === false`, unique valid paths, types, modes, and SHAs. |
| Repeat all review/lifecycle inputs after Git collection | Fresh requests, findings, threads and drafts still block use of the immutable proof. |
| Repeat PR and base-ref reads immediately before publishing carried success | Same head, snapshot base SHA, base repository/ref, non-draft state, and L. A moved head abstains; other changes prevent the prepared success. Closure alone preserves coverage. |

Compare files appear only on page one and are capped at 300. Refuse lists of
300 or more and reconcile coverage with complete tree deltas, including renames.
Commit pagination cannot extend the file list. There is no `head_commit` field;
when a commit list is complete it must include the requested head, but
ancestry/identity rely on full-SHA requests and fetched commit/tree objects.
Commit date order need not make that head the last item. The RepoClient object
methods reject abbreviated IDs or named refs before issuing a request.
GitHub prohibits branch/tag names consisting of 40 hexadecimal characters,
which prevents full object IDs from being shadowed by such names.

Every PR file needs a non-empty syntactically complete text patch in both
comparisons. Validate hunk counts, totals, and reported additions/deletions.
Two equally truncated patches are not proof. Binary, symlink, submodule, and
metadata-only PR changes without supported text evidence take the normal path.
Unrelated base binaries need no patch; exact tree entries must survive.

Only the optional Git proof needs **Contents: read** on private repositories.
Direct summary binding uses existing permissions. The owner must approve any
needed App permission/installation consent before enabling carry; this task
changes neither. Inaccessible fork objects also fail closed. There is no
unauthenticated fallback or new source-executing capability.

## Failure, status, and runtime boundaries

Any failed condition supplies no carry: zero/one/three parents, reversed
parents, off-base or backward/divergent M, rebase/force push, a new authored commit, settlement-only
R, missing/deleted/dismissed/unbound source, ambiguous order or protocol,
overlap, conflict/hidden/mode edits, missing/binary/truncated patches, inconsistent
counts, unsupported status, capped files, truncated trees, malformed responses,
API/rate-limit/permission errors, or publication races. Preserve independently
valid direct-review/settlement results. Otherwise use normal failure/pending
and log the proof failure; no catch converts an incomplete proof to success.
Malformed summary state carries specific reason codes. Non-success evaluations
warn once when binding is unavailable or malformed, without logging bodies.
An unbound clean signal receives a distinct failure detail. Independent valid
full-SHA evidence is not invalidated merely by an unusable summary.

`src/base-sync.js` is the pure Git verifier, `src/review-state.js` parses binding
metadata, `src/gate.js` owns authority/blockers, and `src/base-sync-github.js`
collects objects through `RepoClient`. `src/index.js` publishes with a final
live recheck. No new KV schema or subscribed webhook is introduced.

| Evidence change | Delivery/recovery |
| --- | --- |
| Head, formal review, ready/draft/force transition, review thread | Existing subscribed webhooks reevaluate. |
| Clean or non-clean created configured-Bot comment | Reevaluate; a later findings response can retract a carry. |
| Configured-Bot comment edit/deletion, including summary edits | Existing issue-comment webhook reevaluates. |
| PR-body/request reaction | No standalone reaction webhook; pending sweep or rotating fallback observes it. |
| Base advance | Merged sibling reevaluation or rotating fallback rereads live L. |

These reads are not atomic with GitHub's status write. Strict protection and
required CI still matter after the last recheck. The optional proof increases
API work with chain length and tree size; no observed history count is used as
a magic safety cutoff. GitHub/platform errors are caught, but hard Worker
termination can prevent any final status write, as it can on existing paginated
reads. Deployment must provision a suitable Worker budget and observe real
cost before enabling carry; default-off rollout does not claim to solve that
platform limit. Strict configuration normalization and server/request/eyes
checks run before graph collection; every walked head must already appear in
the PR timeline. Chain-specific temporal checks run before comparisons/trees.
A single sync normally needs five commit objects, four trees,
three comparisons, and a live ref, with shared objects deduplicated. A chain
also needs ancestry between adjacent integrated bases when that pair is not
already one of the live-tip comparisons.

A created summary gets ordinary evaluation, not the separate three-second
clean-receipt retry. Existing pending/fallback sweeps cover later visibility;
summary creation alone never proves completion. A publication identity/ref
failure reports retry-required without adding a new priority-queue schema.
The next subscribed event or rotating fallback reevaluates it.

Success description (134 characters with full R/M):

`Review gate passed: base sync of reviewed head <full-R-sha> onto <full-M-sha>.`

Link to the original review/receipt, or its binding summary for a reaction. The
status is on N; R/M are full SHAs in its description. Consumers must authenticate
the Review Gate publisher, not accept a matching context or message from anyone.

## Default-off rollout and consumer text changes

Only `BASE_SYNC_REVIEW_ENABLED=true` (case-insensitive, whitespace-trimmed)
enables carry. Missing/false
configuration makes zero Git proof reads. Authority hardening always applies.
Only the owner deploys, after separate authorization; this task does not merge,
deploy, change App settings/permissions, or edit consumer repositories/skills.

The direct hardening intentionally rejects legacy abbreviated receipts without
v1 full-head metadata unless independent full-SHA clean authority exists. Open
legacy PRs in that situation need a fresh review before success, even with carry
disabled. The bounded public history contains an older marker-only PR #11 board;
it is not accepted as head identity. No date-based grandfathering is allowed.
Recorded manual requests #12/#14 supplied receipts, while automatic-ready #13
supplied only a summary and `+1`. PR #12 had completed Code Review, running
optional Security, and no `+1`; its manual receipt supplied the separate signal.
These are observations, not proof of universal lifecycle or causal guarantees.

The existing consumer wording requires a review of the current head, and
its integration guidance says a base advance requires fresh review, not
settlement. Carry is an explicitly approved alternative **review-coverage
proof**, not a settlement. Before activation, consumer owners should apply:

- aimstrings-docs `AGENTS.md`, "PR review loop", and the equivalent
  aimstrings-web definition: accept either a completed clean review of current
  N or a trusted current-N Review Gate base-sync success naming original R and
  integrated M under this ADR. Retain required current CI, no active review,
  and zero unresolved threads, including stricter consumer rules.
  Preserve the separately authorized exact-current-pair settled-disposition path;
  it cannot supply R or transfer to another head/base pair.
- aimstrings-docs `ORCHESTRATION.md`: replace the unconditional fresh-review
  requirement on base advance with fresh direct review or verified base-sync
  carry. Explicitly retain the ban on transferring settlement across bases.
  aimstrings-web has no `ORCHESTRATION.md` at the audited head; update its
  equivalent integration guidance rather than inventing an existing file.
- `connfy-pr-loop` CLEAN: permit the attested carry on N as an alternative to
  a no-findings result naming N. Verify latest N, actual publisher identity,
  full R/M, current required checks, no active review, and all unresolved
  threads. A green name/message alone or a settled disposition cannot prove carry;
  existing exact-pair settlement authority remains separate.

Propose that owners pin the required review context to the Review Gate App's
integration ID and verify the actual publisher in automation. The audited docs
and web rulesets named this context without `integration_id`, so those rules
alone do not establish the publisher identity required above. These are proposed
consumer changes, not claims about their current enforcement; none is applied.

## Base snapshots and strict policy (scope C)

Settlement binds the PR's recorded `base.sha`, not the live branch. Sibling and
fallback reads do not advance that snapshot. Strict up-to-date required checks
force an update push before merge and thereby invalidate the old head/base
pair. Without strict mode that gap remains. It also remains for protection
bypasses/direct pushes. Proposed fixes are owner-managed strict required checks
or separately approved live-ref settlement binding with a publication recheck;
neither is implemented here.

The read-only audit refreshed at **2026-11-04 17:29 UTC** covers the six
owner-listed installations and review-gate itself, observed publishing its own
statuses. It checks applied default-branch rules and classic required-status
protection, including review-gate's unprotected-branch 404.

| Repository | Default branch | Strict required checks |
| --- | --- | --- |
| aimstrings-web | main | Enabled |
| aimstrings-docs | main | Disabled in active required-check ruleset |
| rmo-ai-web | main | No required-status protection |
| rmo-center | main | No required-status protection |
| rmo-maestro | main | No required-status protection |
| bloodmoon-blowfish | master | No required-status protection |
| review-gate | main | No required-status protection |

The token could not enumerate
all App installations, so this is seven checked repositories, not a proven
independent complete installation inventory. No protection settings changed.

## Verification

Tests cover qualifying syncs, evil/conflicting merges, off-base M, rebases,
force pushes, incomplete evidence/API errors, authored commits after carry,
two syncs anchored to R, backward/divergent base history, harmless repeated M,
settlement-only sources, drafts/threads/pending reviews,
metadata ambiguity, stale reaction/backdated Git dates, and publication races.

Unedited compressed public [cli/cli PR #14914](https://github.com/cli/cli/pull/14914)
responses replay actual GitHub Update branch geometry through the production
verifier: one PR file and 196 disjoint base files. Hashes/endpoints/MIT attribution
are committed beside the recording. This asserts no Codex authority on that
upstream PR. Public review-gate PR #14's actual separate receipt and summary
replay the full-head authority binding, including receipt-before-completion.
Public PR #13's actual summary/reaction replays clean authority with no receipt
and an endpoint-specific User-shaped reaction joined to its Bot author's ID.
Public PR #12 records completed Code Review beside running optional Security
Review; its surviving PR-body `eyes` predates Code Review completion. A bounded
read of PRs #1–#13 found no current Code Review Running sample. Running Code
Review tests use a synthetic row in the observed Running presentation format;
they do not claim a captured running Code Review. The optional security
`mergeGateEnabled` field is outside the code-review policy and is not consumed.
PR #14 proves that a summary can appear after completion, not why it did or that
all manual requests have that lifecycle.
Private aimstrings-web geometry was checked only in retained local evidence;
no private source is published.

Required delivery evidence: `npm test`, Claude Sonnet 5.5/max independent review,
and clean Codex review on the final draft PR head. B ships as its own draft PR
and grants no carry authority. Merge and deployment remain owner stop points.

## References

- [GitHub compare API and file cap](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
- [GitHub branch/tag name restrictions](https://docs.github.com/en/get-started/using-git/dealing-with-special-characters-in-branch-and-tag-names#restrictions-on-names-in-github)
- [Git trees and Contents permission](https://docs.github.com/en/rest/git/trees#get-a-tree)
- [Public full-SHA summary](https://github.com/connfy/review-gate/pull/14#issuecomment-6634436926)
- [Its separate clean receipt](https://github.com/connfy/review-gate/pull/14#issuecomment-6634435696)
