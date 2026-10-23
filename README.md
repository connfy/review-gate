# Review Gate

Languages: English | [한국어](README.ko.md)

> An AI said "this PR looks clean." But can you really hit merge on its word alone?

Review Gate is a tiny Cloudflare Worker that removes that awkward moment of
doubt. When Codex (or any other reviewer bot) decides a PR is clean, it flips a
GitHub commit status to green. If the review bot has acknowledged the latest
head with an `eyes` reaction, the status stays pending while review is in
progress. If the PR is still a draft, has unresolved review threads, or the
latest commit hasn't been reviewed yet, it stays red.

In one line: it's the **missing layer between "we asked an AI to review" and
"okay, this is actually safe to merge."** Your PR gets a status with this name,
and that status becomes your merge signal:

`review-gate/codex-clean`

Why you'll want it:

- Event-first, with a light scheduled sweep for signals without a subscribed
  event, including PR body reactions and direct base pushes. No GitHub Actions
  minutes are burned watching the same PR.
- Pending reviews are queued in Workers KV and checked before the broad fallback
  sweep, so latency does not grow with the number of installed repositories.
- One Worker plus one GitHub App covers dozens of repositories at once.
- An optional deployment-wide CI duration budget reports long Actions workflows
  and can request cancellation without adding a polling workflow to each repo.
- Push a new commit and the status automatically resets to red. No more
  accidental merges on stale approvals.
- Use it as a soft signal (soft gate), or wire it into branch protection as a
  required check to lock the merge button outright (hard enforcement).

## When does it turn green?

For the current PR head SHA, all three of these have to be true before the status
goes `success`:

- The PR is not a draft.
- There are no unresolved current review threads.
- A configured reviewer bot left a clean pass after the latest commit.

A "clean pass" counts in any of three forms:

- the bot left a PR timeline comment containing the clean-review text, or
- the bot left a PR review (with the clean text) whose `commit_id` matches the
  current head SHA, or
- the bot left a `+1` reaction on the PR body after the latest head update and
  latest review request.

An optional settled disposition can close reviewed findings without another
review of the unchanged head/base pair. The round anchor depends on how the
round started:

- **Explicitly requested round:** the latest review-request comment newer than
  the latest head update anchors the round.
- **Auto-fired round:** when no review-request comment exists anywhere for the
  PR (the initial review fires on open/ready), a server-generated boundary —
  the PR creation time and any head-ref event times, never client-controlled
  commit timestamps — anchors the round. A request comment that exists but
  cannot be correlated to the timeline yet still fails closed.

After that anchor and a later non-dismissed formal bot review whose `commit_id`
is the exact current head, an allowlisted human attests the reviewed pair with
this exact issue comment:

```text
@review-gate settle <full-lowercase-40-character-head-sha> <full-lowercase-40-character-base-sha>
```

The anchor, review, and disposition must have strictly increasing timestamps.
PR body text does not count. A later review request, head change, or base change
invalidates the signal, and the existing unresolved-thread and
review-in-progress checks still apply. The status names the human and
abbreviated head/base pair and links to the command comment.

When a merged PR advances its base branch, the subscribed `pull_request` close
event immediately re-evaluates the other open PRs targeting that base ref. A
direct push to the base has no subscribed event, so it remains covered by the
rotating scheduled fallback and is invalidated when that fallback selects the
affected PR.

While the review is running, Review Gate reports `pending` when the configured
bot leaves an `eyes` reaction on the PR body or on the latest review request
comment. The status description is deliberately generic:

`Review bot is reviewing the latest head.`

A review that was requested for the latest head is also `pending`, not
`failure`, until the bot responds. The request can be opening the PR, marking a
draft ready, or a review-request comment. The wait lasts at most
`REVIEW_START_WINDOW_MS`, 20 minutes by default, and then the status becomes a
failure. The bot's live summary comment, which Codex creates when a review
starts and edits in place, never counts as the bot's response:

`Review requested for the latest head; waiting for the review bot.`

By default Review Gate trusts these bots,

- `chatgpt-codex-connector`
- `chatgpt-codex-connector[bot]`

and treats this line plus a PR-body `+1` as clean signals:

`Codex Review: Didn't find any major issues.`

Heads up: GitHub exposes PR body reactions through the issue reactions API, not
as a standalone reaction webhook. Review Gate reads them whenever another PR,
review, or issue-comment webhook causes the PR to be re-evaluated. It also runs
a small scheduled sweep. PR heads that are already pending are recorded in
Workers KV and checked first, so a late PR-body `+1` can flip the status to green
on a priority sweep even when no comment/review webhook follows. A rotating scan
of other open PRs remains as a fallback for signals that never entered the
pending state.

## Setup (quicker than it looks)

Five steps total. Create a GitHub App → convert the key → deploy the Worker →
connect the App → done.

### 1. Create a GitHub App

In GitHub, create a new GitHub App under your personal account or an organization.
There's a bit to configure, but just follow the tables below.

Give it these **Repository permissions**:

| Permission | Access | Why it's needed |
| --- | --- | --- |
| Commit statuses | Read and write | To write the review status and optional CI budget status onto commit SHAs. |
| Pull requests | Read-only | To read PR state, reviews, inline comments, and review threads. |
| Issues | Read-only | To receive PR timeline comments and read PR body reactions. GitHub models PR comments and PR bodies as issues internally. |
| Actions (optional CI budget) | Read-only for `report`; Read and write for `cancel` | To inspect workflow attempts and job timing; write is required to cancel a run. |

Subscribe it to these five events:

- Pull request
- Pull request review
- Pull request review comment
- Pull request review thread
- Issue comment

For the optional CI budget, also subscribe to **Workflow run** (`workflow_run`:
`requested`, `in_progress`, and `completed`). No `workflow_job` subscription is
needed; the Worker reads jobs for the exact workflow attempt through the API.

Do not skip that last one, **Issue comment**. Codex clean-pass messages usually
arrive as PR timeline comments, and GitHub sends those as `issue_comment`
webhooks. Forget it and you'll spend ages wondering "why isn't this working?"

The **Webhook URL** doesn't have to be correct yet. Drop in a placeholder like
`https://example.com/review-gate` and swap in the real one after you deploy the
Worker.

Set a strong random **Webhook secret** and copy it somewhere handy. You'll use it
in the next step.

### 2. Convert the private key

Download a private key from the GitHub App settings page. The catch: GitHub hands
you a PKCS#1 PEM, but Cloudflare Workers' Web Crypto wants PKCS#8. So convert it
once. Copy-paste the command as-is:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in your-app.private-key.pem -out your-app.pkcs8.pem
```

Replace `your-app.private-key.pem` with the file you just downloaded. The
resulting `your-app.pkcs8.pem` is what you'll use next.

### 3. Deploy the Worker

```bash
cd review-gate
npm install
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler deploy
```

Wrangler 4.45 or later automatically provisions the `PENDING_REVIEWS` Workers
KV namespace declared in `wrangler.toml`. If you deploy from the Cloudflare
dashboard or a Git integration, the generated resource ID stays in Cloudflare
rather than being written back to this repository.

Each `wrangler secret put` prompts you to paste a value. Fill them in like this:

- `GITHUB_APP_ID`: the numeric App ID (it's at the top of the App settings page)
- `GITHUB_WEBHOOK_SECRET`: the webhook secret from step 1
- `GITHUB_APP_PRIVATE_KEY`: the full contents of the PKCS#8 PEM from step 2
  (everything from `-----BEGIN` to `END-----`)

After deploy, the Worker URL prints in your terminal. Copy it.

### 4. Connect the Worker to the GitHub App

Go back to the GitHub App settings and replace the placeholder **Webhook URL**
with the real Worker URL you just copied.

To confirm the wiring, redeliver the `ping` event under **Advanced > Recent
deliveries**. A healthy setup returns `200` with `pong`.

Finally, install the App on whichever repositories you want to gate. That's it.

> If you change the App's permissions later, each installation owner has to
> approve the new permissions before they take effect. Easy to forget, so keep it
> in mind.

### 5. Use it on a real PR

Open a PR or push a new commit, and Review Gate starts reporting a status right
away. It stays failed until the latest commit has a clean review and all review
threads are resolved.

If you use Codex, you usually summon a review like this:

```text
@codex review
```

Shortly after the bot leaves a clean-pass comment, after a later webhook causes
Review Gate to observe the bot's PR body `+1`, or after one of the
scheduled sweeps sees that `+1`, the Worker recomputes the PR and flips the
status to green. If the bot has only acknowledged the review with `eyes`, the
status becomes pending instead.

## Soft gate, or lock it down?

Out of the box, Review Gate only *reports* a status. Often that's plenty: tell
your people (and AI agents) "if `review-gate/codex-clean` isn't green, don't
merge." That's the soft gate.

Want GitHub itself to disable the merge button? Add `review-gate/codex-clean` as a
required status check in branch protection or a repository ruleset for the
protected branch. That's hard enforcement.

Note that this App deliberately does not ask for heavy permissions like
`Administration: write` just to create rulesets for you. Not holding that
permission makes it much easier — and safer — to install.

## Optional CI duration budget

Actions minutes are a budget. Long CI is a finding to review for excess and
optimize, not a reason to raise its timeout. To apply a ten-minute limit to
**all Actions workflows in every repository installed on this deployment**,
add these non-secret deployment variables:

```toml
CI_BUDGET_MINUTES = "10"
CI_BUDGET_MODE = "report" # status only; use "cancel" to also request cancellation
```

Leave `CI_BUDGET_MINUTES` absent (or empty) to disable the feature. Existing
deployments keep their review-only behavior. The default enabled mode is
`report`; cancellation always requires the explicit `cancel` mode. There are no
repository overrides: settings are deployment-wide, like the existing review
policy, so each installed repository follows the same limit.

Before enabling, grant **Actions: Read-only** for reporting, or **Actions: Read
and write** for cancellation, retain **Commit statuses: Read and write**, and
subscribe to **Workflow run** as described above. **The owner of each existing
installation must approve the new permissions**; changing the App's settings
alone is not enough. The Worker checks the permissions on the installation
token, including for public repositories where successful reads alone do not
prove permission approval. A cached token may take up to an hour to refresh
after approval.

The separate `review-gate/ci-budget` commit status links to the workflow attempt
on its `head_sha`. It is proactively green while no breach is known, including
while workflows are queued or running, and turns red when a workflow exceeds
the budget. Normal completed runs therefore reach success. Require this context
in branch protection **alongside your actual CI checks**, not instead of them:
budget success does not mean CI is finished or tests passed. A reported breach
stays failed on that SHA, even if another workflow or a rerun is shorter. Fix the
excess in a new commit rather than rerunning the same SHA to erase the finding.
Repositories/branches with no Actions run receive no budget status; do not
require the context there. Enabling the feature does not backfill old runs.

The budget measures **workflow-attempt wall time**, from the first executed
job's `started_at` to the last executed job's `completed_at` (or now while the
workflow is active). Initial runner queue time and skipped jobs do not count;
once execution starts, dependency gaps between jobs count as pipeline wall time.
Parallel jobs are not added together, and rerun attempts have their own clocks.
Never-started cancelled jobs are also excluded. Job timestamps avoid treating
the run's mutable `updated_at` as completion time.
This is a duration limit, not a calculation of billed, rounded runner minutes.

Signed workflow webhooks enqueue attempts in the existing `PENDING_REVIEWS` KV
namespace. The scheduled sweep checks due attempts before the review sweeps,
using its own `SWEEP_MAX_CI_RUNS` cap (default `2`). Each sweep scans at most ten
1,000-key pages and persists the continuation cursor for the next sweep, wrapping
at the end. Later installations therefore remain reachable even when earlier
queue entries are not due yet. Due attempts are ordered by deadline within the
scanned segment. Once the first sweep discovers the execution start, it schedules
the next API check for the deadline. Completed
webhooks report promptly; scheduled live reads settle queue entries. Verified
active records renew their retention of budget duration plus 24 hours. Failed
reads preserve the previous expiry, so removed installations cannot accumulate
forever. Accepted-cancel receipts use the same retention window. After an outage
outlasts retention, redeliver the workflow event to restore tracking.

**Timing is best-effort, not a hard ten-minute kill switch.** With the default
three-minute cron, a due run is normally checked on the next sweep; KV
propagation, capped backlogs, GitHub outages, and cooperative cancellation can
add delay. A cancellation request is not proof the runner has stopped. Operators
can choose a one-minute cron and size the sweep cap for their workload; both
increase API/KV use. `limited` summaries warn when the cap delays work. Keep
workflow-native timeout controls when an exact runner stop bound is required.

Unknown/invalid settings disable budgeting and log a configuration error.
Missing Actions read permission, missing KV, incomplete timing, or API failures
remain visible in logs and never trigger cancellation. `cancel` with only
Actions read permission still reports breaches but logs that cancellation needs
approved Actions write access. Cancellation also requires approved Commit
statuses write permission, even if the breach status was already present. The
Worker rechecks the live run and attempt before requesting ordinary cancellation;
it never force-cancels or intentionally
cancels a newer rerun. Accepted requests are remembered in KV to avoid repeated
cancellation on redelivery; KV is eventually consistent, so overlapping workers
cannot promise exactly-once API delivery. No App settings or branch rules are
changed by the feature.

## Configuration

Non-secret settings live in `wrangler.toml`. Tweak them here if you want to use a
different reviewer bot or change the trigger text.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATUS_CONTEXT` | `review-gate/codex-clean` | The commit status name to write. |
| `CI_BUDGET_MINUTES` | absent (disabled) | Positive decimal minutes, at whole-millisecond precision. One limit for all installed repositories. |
| `CI_BUDGET_MODE` | `report` | `report` writes status only; `cancel` also requests cancellation after a breach if Actions write is approved. Other values disable budgeting. |
| `CI_BUDGET_STATUS_CONTEXT` | `review-gate/ci-budget` | Separate budget status context; must be nonempty and different from the effective `STATUS_CONTEXT`, ignoring case. A collision disables budgeting and logs an error. |
| `SWEEP_MAX_CI_RUNS` | `2` | Positive integer cap on due workflow attempts evaluated per sweep, separate from both review budgets. |
| `REVIEW_BOT_LOGINS` | `chatgpt-codex-connector,chatgpt-codex-connector[bot]` | Bot logins whose clean pass counts (comma-separated). |
| `CLEAN_REVIEW_TEXT` | `Codex Review: Didn't find any major issues.` | Text that marks a clean review pass. |
| `CLEAN_REACTION_CONTENT` | `+1` | PR body reaction that marks a clean review pass. |
| `REVIEW_IN_PROGRESS_REACTION_CONTENT` | `eyes` | Reaction that marks the latest head as currently under review. |
| `REVIEW_REQUEST_TEXT` | `@codex review` | Comment text that marks the latest review request boundary for reaction freshness. |
| `REVIEW_STATUS_BOARD_MARKER` | `<!-- codex-pull-request-review-summary -->` | Marker of the bot's live summary comment, which is never treated as a review response. |
| `REVIEW_START_WINDOW_MS` | `1200000` | How long a review requested for the latest head stays `pending` without a bot response. |
| `SETTLED_DISPOSITION_LOGINS` | empty (disabled) | Human GitHub logins allowed to attest exact head/base settled dispositions (comma-separated). |
| `REVIEW_START_RETRY_DELAY_MS` | `15000` | Delay before re-checking a PR-open/review-request event for late `eyes`. |
| `REVIEW_PENDING_RETRY_INTERVAL_MS` | `7000` | Delay between optional webhook-bound re-checks while the latest review is pending. |
| `REVIEW_PENDING_RETRY_ATTEMPTS` | `0` | Maximum pending-review re-checks inside the webhook task. Disabled by default because scheduled sweeps catch late PR-body `+1` reactions. |
| `PENDING_REVIEW_TTL_SECONDS` | `86400` | How long a pending PR head remains in the KV priority queue before automatic expiry. |
| `SWEEP_MAX_INSTALLATIONS` | `10` | Safety cap for GitHub App installations checked per scheduled sweep. |
| `SWEEP_MAX_REPOSITORIES` | `4` | Safety cap for repositories checked per scheduled sweep. |
| `SWEEP_MAX_PENDING_PULL_REQUESTS` | `2` | Separate safety cap for KV-queued pending PRs evaluated per sweep. |
| `SWEEP_MAX_PULL_REQUESTS` | `2` | Safety cap for fallback open PRs evaluated per sweep; pending work never consumes it. |
| `SWEEP_PAGE_SPAN` | `10` | Initial page probe window for scheduled sweeps; when GitHub exposes the last page, the sweep rotates across the full list. |

The default cron in `wrangler.toml` runs every three minutes:

```toml
[triggers]
crons = [ "*/3 * * * *" ]
```

Each scheduled run has separate budgets for KV-queued pending heads and the
rotating open-PR fallback. Long-running pending reviews therefore cannot starve
the fallback. The conservative default caps protect the GitHub App installation
rate limit. Both paths rotate their candidates so capped runs do not always
start in the same place.

At a three-minute interval the priority queue performs about 14,400 KV list
operations per month for a one-page queue. Cursor pagination is capped at ten
pages, so the implementation ceiling is about 144,000 list operations per
month, still below the Workers Paid included allowance. Queue records are stored
in KV metadata, so the sweep does not need a separate KV read per PR.

Enabled CI budgeting adds a separate KV list traversal (up to ten 1,000-key
pages per sweep), one cursor read, and a cursor write or deletion when advancing
or wrapping a partial traversal. The `queued` count covers the scanned segment,
not the entire queue. Run/job/status reads only cover due attempts within the
evaluation cap. Job inspection is capped at 1,000 jobs per attempt and status
inspection at 1,000 statuses per SHA. Incomplete or oversized histories log an error and stay
retryable rather than silently passing or cancelling from partial evidence.

## Architecture and decisions

See [Architecture](docs/architecture.md) for module and data-flow relationships.
Major trade-offs are recorded under [docs/decisions](docs/decisions/).

Secrets are stored separately in Cloudflare via `wrangler secret put`:

| Secret | Meaning |
| --- | --- |
| `GITHUB_APP_ID` | The numeric GitHub App ID. |
| `GITHUB_APP_PRIVATE_KEY` | The private key converted to PKCS#8 PEM. |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret set on the GitHub App. |

## When things go wrong (troubleshooting)

### The status never shows up

- Is the App actually installed on that repository?
- Is the Worker URL saved as the GitHub App's webhook URL?
- Does redelivering the `ping` event return `200 pong`?
- Still stuck? Check the Cloudflare Worker logs for signature or GitHub API
  errors.

### Codex says clean, but the status stays failed

- Was the clean-pass comment posted *after* the latest head commit? Anything
  before it doesn't count.
- If you rely on the PR body `+1`, was the reaction created after both the latest
  head update and the latest `@codex review` request?
- If the bot is still reviewing, does the PR body or latest review-request
  comment have a fresh `eyes` reaction from the configured bot? That should show
  as pending, not failed.
- If the bot only uses a PR-body `+1`, wait for the next scheduled sweep.
  GitHub does not emit a separate webhook for that reaction.
- Are there still unresolved review threads?
- Under **Advanced > Recent deliveries** in the App settings, is there an
  `issue_comment` delivery at the time of that comment?
- If there's no delivery, double-check both the `Issues: Read-only` permission and
  the `Issue comment` event subscription. (This is the most common culprit.)
- If the delivery exists and returns `202 Accepted`, the webhook was received
  fine — so the problem is later, during PR re-evaluation or status reporting.
  Check the Worker logs.

### The status is failed but GitHub still lets you merge

That means the status isn't a required check yet. Either treat it as a soft
"failed means don't merge" rule, or add `review-gate/codex-clean` as a required
status check to let GitHub block the merge for you.

## Want to hack on it? (local development)

```bash
npm test
npm run dev
```

Files worth knowing when you poke around:

- `src/gate.js` - the gate decision logic (pure functions, easy to read).
- `src/webhook.js` - signature verification, event routing, and cheap comment
  filtering.
- `src/github.js` - GitHub App auth, installation token caching, GitHub API calls.
- `src/index.js` - the Cloudflare Worker entrypoint.
- `src/ci-budget.js` - optional Actions duration policy, queue, and enforcement.
- `test/` - `node --test` unit tests.

## A word on security

- Security comes from guarding your secrets, not from hiding the source.
- Webhooks are verified with `X-Hub-Signature-256` and `GITHUB_WEBHOOK_SECRET`.
- A clean pass only counts when authored by a configured bot login — nobody can
  sneak through by just copying the magic text.
- Never commit private keys or `.dev.vars`. If a secret ever lands in git history,
  rotate it immediately.

## License

MIT. See `LICENSE`.
