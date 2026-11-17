# API-credit native Codex reviewer

## Status and purpose

Local implementation authorized by the owner on 2026-11-17. App creation,
installation, Worker activation and published-review acceptance are separate
operator steps, not implied by this source. No GitHub Actions reviewer is used.
The coordinator has since created the dedicated App with an all-connfy-repos
installation, per the owner's decision. That installation scope does not
authorize the runner to review every installed repository.

Use this reviewer when hosted `chatgpt-codex-connector` cannot review because of
plan usage. Keep Review Gate as the sole writer of `review-gate/codex-clean`.
Do not allowlist `github-actions[bot]`, and do not append this new App to
`REVIEW_BOT_LOGINS`: it has a stricter identity/protocol below.

The owner removed historical-PR calibration on 2026-11-17 because repeated LLM
outputs do not establish deterministic quality. Mock tests verify protocol and
failure behavior. A dry-run smoke verifies plumbing, not defect recall or
false-positive rates. Human judgement still validates individual findings.

## Run on this host

Prerequisites: Node 24+, Git, authenticated `gh` with read access to the target,
`bwrap` with unprivileged user namespaces, and the existing
`/home/minhun/.local/bin/codex-credit`. Native CLI **0.169.0** and its sibling
`codex-code-mode-host`/`codex-exec-server` executables are the inspected adapter
version. Revalidate the adapter against source before changing that version.
The wrapper's key file must exist; it is mounted privately, never printed or
loaded into the controller. No custom key or App credential goes in an argument.

From this trusted checkout, with a live open PR:

```bash
# Default: dry run. Does not need the reviewer App or post anything to GitHub.
node scripts/review-pr.mjs connfy/aimstrings-web 586

# Only after App setup, deployment activation and permission to post:
set -a
. /absolute/private/path/api-reviewer.env
set +a
node scripts/review-pr.mjs connfy/aimstrings-web 586 --publish
```

Optional `--artifacts /absolute/directory` selects the retained output parent.
Drafts may be dry-run reviewed but cannot be published by this command. There
is no historical SHA override, request-comment watcher, background daemon,
automatic retry, or `@codex review` comment emission.

`API_REVIEW_ALLOWED_OWNERS` (comma-separated account names, default `connfy`)
admits every repository of those accounts; `API_REVIEW_ALLOWED_REPOS` adds exact
repositories (owner, 2026-11-17: all connfy repositories may use the reviewer).
Wildcards or malformed entries are errors; an empty owner list admits only the
listed repositories. The CLI rejects other repos before reading App credentials, accessing
GitHub or starting inference. The controller/publisher also enforce the same
list. An owner-approved additional repository must be explicitly named in this
config; an all-repositories App installation never broadens it implicitly.

## Review and publication contract

1. Read the real PR and paginated issue comments/timeline; freeze repository,
   PR number, full head/base SHAs and the current server/request freshness
   boundary shared with the gate.
   Fetch those objects into a fresh private bare repository and detached temp
   worktree. Compute the merge base and save the three-context-line diff. Disable Git hooks,
   external diff/textconv and inherited Git configuration during preparation.
2. Run **native `codex exec review --base <frozen-base>`**, using
   `gpt-6.1-sol` at `high`, through the existing credit wrapper. The native
   rubric favors no findings over speculative, pre-existing, intentional,
   stylistic or low-value issues. There is no finding minimum and no review
   loop demanding successive clean passes. Only actionable P0–P2 findings an
   author would fix open inline threads where an anchor exists; otherwise the
   finding stays blocking in the Review body. P3 is counted, retained locally
   and never posted as a thread. A valid P3-only result is clean even when the
   model's overall label disagrees or its non-blocking location is outside the
   diff. Severity, not that label, determines publication.
3. Isolate the reviewer with a sparse Bubblewrap filesystem and empty process
   environment. Mount only system runtime files, the Codex executable directory,
   the frozen source, job state and private inference-key/ledger locations. WSL's
   actual resolver symlink target is mounted explicitly. The native read-only
   tool sandbox denies key/job-state reads and tool network access, clears tool
   environment inheritance and places tools in a PID namespace that hides the
   credential-bearing parent. The model receives no GitHub/App credentials,
   neighboring repositories, host home, SSH agent, user MCP, plugins, memories,
   or agent delegation. No blanket `--trust`, scripts, builds, dependencies or
   tests from the PR are executed.
4. Disable automatic project instruction injection; supply applicable root and
   scoped `AGENTS.md`/`AGENTS.override.md` guidance from the frozen **base** as
   review data. Head-side instruction/config changes are reviewed, not allowed
   to reconfigure the reviewer. This intentional departure from automatic
   head-side discovery avoids giving PR-controlled instructions authority.
5. Read the native review child's original JSON in its persisted
   `task_complete.last_agent_message`, not the parent's human summary or a
   clean-looking sentence. Require its `session_meta.parent_thread_id`, native
   review source, version, cwd, head and selected model/effort to match the run.
   The source's structured `exited_review_mode.review_output` is a live protocol
   item, not persisted by this CLI as an `event_msg`. This version's
   `--output-schema` is not passed into the native review delegate. Require a unique complete result,
   valid P0–P3 priority/location/confidence/correctness fields, completed runtime,
   recorded usage and successful nonempty tool
   output (rejecting the known zero-tool-output failure, not enforcing a
   particular source-reader command). This is diagnostic evidence, not proof
   every relevant file was read. One enclosing JSON Markdown fence is accepted;
   arbitrary surrounding prose is not. Unknown priority, an empty incorrect
   result, an explicit incomplete sentinel, prose-parser fallback,
   interruption, quota, runtime error, missing output or incomplete access
   produces **no publication**. These checks establish usable evidence, not
   model-review quality. Logs remain available to diagnose rejected evidence.
6. Build the summary in trusted publisher code. A complete result without
   P0–P2 findings gets the configured clean sentence; model prose never supplies
   that sentence. A findings summary never contains it. Post one GitHub Review
   with `event: COMMENT`, **explicit `commit_id: frozen-head`**, a provenance
   marker containing the frozen head/base, and all blocking findings in that
   same request. Surviving files use HEAD/RIGHT coordinates including context;
   only fully deleted files use LEFT coordinates. A blocking finding outside
   inline geometry is quoted in the Review body, without losing the finding or
   producing a clean signal. Model-authored body text cannot inject a standalone
   clean line. The gate treats the authenticated body-only blocker section as
   outstanding negative evidence even if a hosted clean signal already exists.
   P3 locations do not need inline anchors.
7. Immediately before POST, re-fetch and require the same open, ready head/base
   and repository, and require the same freshness boundary. A push, base move
   or new request boundary during review aborts publication.
   A later head change invalidates gate authority. After publication, a later
   base advance follows existing direct-hosted-review semantics; the provenance
   base is not a new forever-blocking base freshness rule. Existing branch/CI
   up-to-date requirements and settled-disposition pair checks remain intact.

The App client retains GitHub's installation-token `expires_at`. Before every
request it refreshes credentials if they will expire within the HTTP request's
one-minute maximum lifetime, coalescing simultaneous refresh requests. Each
refresh signs a fresh App JWT, so a completed review is not stranded by the
one-hour installation-token or ten-minute JWT lifetime. Missing/invalid expiry
or refresh failure aborts publication. No automatic retry of the original
request is added, especially not of an ambiguous Review POST.

Prompt injection and missed/overstated defects are still model limitations.
Isolation separates model output from credentials and publication authority;
it does not prove the semantic correctness of every finding.

## Deduplication, failure and recovery

The default state directory is `~/.local/state/api-credit-reviewer`. An atomic
local directory lock serializes a repository/PR/head. Remote, paginated review
reads deduplicate an already-published signed Review only when it is newer than
the current gate boundary. Local receipts also include that boundary in their
key. Thus a later request or force-push/restore to the same SHA starts a new
generation instead of stranding a stale result behind permanent deduplication.
Within one generation, a POST-intent receipt is saved before the only POST. A lost
response or interrupted write is ambiguous: subsequent invocations refuse to
automatically retry it. Reconcile the remote Review and local receipt first.
This assumes a single trusted host/state directory; multiple independent hosts
do not have a distributed publication lock. Do not operate a second publisher
against the same installation without coordination.

Inspect the lock's `owner.json` (PID, frozen pair, artifact directory), confirm
the process is no longer running, then inspect the retained events, native
session, ledger and receipt. A stale lock can be removed manually after that
inspection. Never delete a live lock or an ambiguous POST receipt just to retry.
If GitHub contains the signed exact-head Review for the current generation, the
next invocation deduplicates it. A newer boundary allows a fresh review rather
than requiring a dummy commit. If remote history confirms no Review in the
ambiguous generation, the operator can archive the failed
receipt before an explicitly chosen retry. No timeout or quota condition is
ever a clean result. No automatic watchdog kills a review.

Successful runs save snapshot, input merge base, diff, invocation, trusted
engine config, JSON events, stderr, native sessions, token ledger receipt,
validated result, proposed review payload and completion receipt, then remove
their own temporary source checkout. Failed runs keep partial outputs and the
scratch path in `failure.json`. Interruptions may leave the lock/scratch and
partial transcript. This retention is deliberate: a signal can arrive before
the native sessions, diff or other inputs have been copied/finished. After
confirming the job is dead, archive its native-session files and any still-needed
frozen inputs before removing the recorded scratch directory and lock. Retained
source is not an unattended job; check disk use during recovery. Do not add an
unconditional signal handler that deletes evidence or a lock while publication
may still be ambiguous. The Codex credit ledger remains at its ordinary host path.
**The inspected CLI reports zero outer tokens for native review**, even though
the review child spent tokens. Keep that original `ledger.json` receipt as-is;
`native-usage.json` and the append-only
`~/.local/state/codex-credit/native-review-usage.jsonl` record the linked review
child's last observed `token_count.info.total_token_usage`, including before
rejecting failed wrapper/runtime completion. A failed run's counter is partial,
not a verified final bill. Do not add the two if a future
CLI reports nonzero outer usage: they describe the same run. These are token
records, not billed USD or evidence of which credit balance paid. Even a
malformed review can spend tokens; accounting recovery precedes verdict parsing.

## Create and install the dedicated App (coordinator)

The reproducible settings are in
[`config/api-reviewer-app-manifest.json`](../config/api-reviewer-app-manifest.json).
The manifest has no events and its hook is inactive. Its `.invalid` URL only
fills the manifest's required hook URL field; no webhook receiver is needed.

The ordinary manual settings flow needs no callback service or secret exchange:

1. Open the account/organization's **Settings → Developer settings → GitHub
   Apps → New GitHub App**. For the `connfy` user account use
   <https://github.com/settings/apps/new>; for an organization use its
   organization settings. Confirm which account owns `connfy` before choosing.
2. Name it `connfy-api-reviewer` (or another available name, recording its actual
   slug). Homepage: `https://github.com/connfy/review-gate`. Disable **Active**
   under Webhook. Do not configure OAuth callbacks, user permissions or events.
   Choose installation only on this account.
3. Repository permissions: **Pull requests: Read and write**, **Contents:
   Read-only**, **Metadata: Read-only** (automatic). No Issues, Actions,
   Administration, Checks or Commit statuses write permission. Create the App.
4. Record its **App ID**, generate/download a private key, move it to a private
   directory outside any repository, and `chmod 600 /absolute/path/key.pem`.
   The Node publisher accepts GitHub's PKCS#1 PEM directly. This is a different
   key from the existing Review Gate App's Worker key; do not replace that key.
5. Install on the scope the owner authorized; the current connfy installation
   covers **all connfy repositories**. Record the installation ID and recheck
   displayed permissions/scope. Keep the runner allowlist independently narrow.
6. Get the actual login/user ID with this read-only command, replacing the
   actual slug if renamed:

   ```bash
   gh api 'users/connfy-api-reviewer[bot]' --jq '{login,id,type}'
   ```

   Require `type: Bot`. **Bot user ID is not App ID or installation ID.** Copy
   `config/api-reviewer.env.example` outside the repo; fill the App ID,
   installation ID, empty private-key path, bot login and numeric user ID.
   Never paste a PEM or inference key into an agent conversation.
7. For Review Gate, configure non-secret `API_REVIEW_BOT_LOGIN` and
   `API_REVIEW_BOT_ID`; optionally `API_REVIEW_CLEAN_TEXT` (must match the runner).
   A Git-connected deployment (Workers Builds) replaces dashboard vars with the
   `wrangler.toml` `[vars]` on every build, so keep the identity there; the
   connfy deployment does (2026-11-17: a manual `--var` deploy was overwritten by
   the main build 12 seconds later). A fork replaces those two values with its
   own App bot or deletes them. If request text or
   legacy bot logins differ from defaults, mirror `REVIEW_REQUEST_TEXT` and
   `REVIEW_BOT_LOGINS` in the runner env so the shared boundary gets identical
   configuration.
   Leave the hosted bot login configuration unchanged. Activation requires the
   separately authorized review/merge/Worker deployment process. No new
   reviewer-App private key belongs in the Worker. Review Gate's existing
   `pull_request_review` and thread subscriptions already observe publication.
8. With explicit posting authority and the Worker activated, run the publisher
   once on each final ready head of docs #999 and web #586. Verify actual author
   login/ID/type, `commit_id`, marker, inline threads, Worker evaluation and
   current-head `review-gate/codex-clean`. A dry run is not this acceptance test.
   Do not merge while another review is active or any current thread remains
   unresolved. Do not substitute the reviewer App as the required-status writer:
   that stays the existing Review Gate App.

For automated manifest registration, use the official three-step
[manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
with an operator-owned redirect URL and a private response destination. The
manifest is supplied, but this local reviewer does not start an App-creation
web server or perform that external action.

## Gate configuration

`API_REVIEW_BOT_LOGIN` plus `API_REVIEW_BOT_ID` opts in to the new authority.
Missing or malformed IDs disable it. It accepts only a submitted `COMMENTED`
Review with exact native `commit_id` and matching full-head provenance marker,
from that exact login **and** numeric ID with `type: Bot`. The clean text must
be a standalone line. The Review must be newer than the server-stamped PR/head
boundary and latest existing review-request boundary. The same boundary expires
publisher deduplication. Its completed findings Review also ends an earlier
hosted `eyes` cycle for response/settlement purposes. Issue comments and
reactions from this App never count. Drafts and unresolved current threads
continue to fail. A human settlement may refer to its signed exact-head formal
review under the existing settlement conditions; no new settlement author is
authorized. An exact-head authenticated body-only P0–P2 section overrides clean
signals until an authorized exact-head/base settlement newer than the latest
blocking Review, or a head change. Re-requesting a review or receiving another
clean signal does not silently close outstanding findings, just as it does not
resolve an inline thread. Wrong actors/IDs/commit markers, dismissed Reviews and
quoted model text cannot create these body blockers; P3-only results cannot
create them either. Hosted Codex behavior is otherwise unchanged.

## Verification

```bash
npm test
```

Tests cover freeze/head races, no-post dry runs, artifact/review failures,
identity and commit forgery, stale results, removed-line anchors, P0–P3 policy,
native parser fallback, quota/interruption, atomic COMMENT payloads,
deduplication, ambiguous POST failure and App authentication with a generated
test-only private key. Mock-clock regressions cover one-hour inference and fresh
JWT/token renewal, concurrent refresh, missing expiry and no Review POST retry.
Gate regressions cover earlier hosted clean versus body blockers, P3-only clean,
forged/stale evidence and authorized settlement ordering.
Live smoke and production acceptance evidence belong
in the build report, not in a unit-test claim.

## Sources and limits of parity

- [Codex GitHub review docs](https://learn.chatgpt.com/docs/third-party/github)
  document scoped project rules, focused review and request/eyes behavior. The
  current page says P0/P1 only; observed connfy reviews include P2. Neither proves
  the private hosted service uses precisely this CLI version/model/rubric.
- [Pinned native rubric](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/prompts/templates/review/rubric.md),
  [review task/parser](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tasks/review.rs),
  [request construction](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/prompts/src/review_request.rs)
  and [result types](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/protocol/src/protocol.rs)
  establish the native prompt family, schema and prose fallback.
- [Non-interactive permissions/auth](https://learn.chatgpt.com/docs/non-interactive-mode)
  explain API-key scope, untrusted project config/MCP and output/schema surfaces.
- [Create a PR Review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)
  documents explicit `commit_id` (omitting it defaults to the latest head) and
  review comments. Binding and publisher identity are our protocol, not an
  OpenAI clean-pass guarantee.
- [Installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
  expire after one hour and return `expires_at`.
  [App JWTs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
  have a maximum ten-minute lifetime. The pre-request refresh and no-POST-retry
  policy above are local implementation choices, not a GitHub retry guarantee.
