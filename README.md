# Review Gate

A Cloudflare Worker that reports a required commit status (default
`review-gate/codex-clean`) from **GitHub App webhooks**, blocking merges until an
AI/code reviewer has left a clean review and all review threads are resolved.

It is reusable: the reviewer bot login(s), the clean-review marker text, and the
status context are all configurable, so it is not tied to Codex or to any single
repository. A single GitHub App + single Worker can gate any number of repos.

## Why this exists

A common approach runs such a gate on a `schedule` cron in GitHub Actions.
Actions bills each job rounded **up to the whole minute**, so frequent polling
(e.g. every 5 minutes) burns thousands of billable minutes per month. This Worker
is purely event-driven:

- One GitHub App is installed on any number of repositories.
- Every pull-request event is delivered to a single Worker URL.
- The Worker recomputes the gate for the affected PR and sets the commit status.
- No cron, no polling, so it stays inside the Cloudflare Workers free tier and
  consumes zero GitHub Actions minutes.

## Gate rule

The status is `success` only when **all** of the following hold for the PR head SHA:

- The PR is not a draft.
- There are no unresolved current review threads.
- The configured review bot left a clean pass after the latest head update —
  either an issue comment containing the clean-review marker text posted after the
  head commit, or a review whose `commit_id` matches the head SHA with that text.

> A reviewer's 👍-reaction shortcut is intentionally **not** supported. GitHub
> does not deliver reaction webhooks, so a pure webhook gate cannot observe
> reactions. Rely on the reviewer's clean review comment instead.

## Configuration

Non-secret settings live in `wrangler.toml` under `[vars]` and can be overridden
per deployment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATUS_CONTEXT` | `review-gate/codex-clean` | Commit status context required by branch protection. |
| `REVIEW_BOT_LOGINS` | `chatgpt-codex-connector,chatgpt-codex-connector[bot]` | Comma-separated bot login(s) whose clean review counts as a pass. |
| `CLEAN_REVIEW_TEXT` | `Codex Review: Didn't find any major issues.` | Substring that marks a clean review from the bot above. |

Secrets are set with `wrangler secret put` and never committed:

| Secret | Meaning |
| --- | --- |
| `GITHUB_APP_ID` | App ID from the GitHub App settings page. |
| `GITHUB_APP_PRIVATE_KEY` | App private key in PKCS#8 PEM format. |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret configured on the GitHub App. |

## Events handled

`pull_request`, `pull_request_review`, `pull_request_review_comment`,
`pull_request_review_thread`, and `issue_comment` (PR comments only).

`pull_request_review_thread` means thread resolution is reflected in real time —
something the GitHub Actions trigger set could not do.

## Setup

### 1. Create the GitHub App

Create a GitHub App (org or personal account) with:

- **Repository permissions**
  - Commit statuses: **Read and write**
  - Pull requests: **Read-only**
  - Contents: **Read-only**
- **Subscribe to events:** Pull request, Pull request review, Pull request review
  comment, Pull request review thread, Issue comment
- **Webhook URL:** the deployed Worker URL (fill in after step 3, or use a
  placeholder and update it).
- **Webhook secret:** generate a strong random string and keep it.

Generate and download a private key, then convert it to PKCS#8 (Web Crypto
cannot import GitHub's default PKCS#1 key):

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in your-app.private-key.pem -out your-app.pkcs8.pem
```

Install the App on the repositories you want gated.

### 2. Configure secrets

```bash
cd review-gate
npm install
npx wrangler secret put GITHUB_APP_ID            # numeric App ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET     # the webhook secret from step 1
npx wrangler secret put GITHUB_APP_PRIVATE_KEY    # paste the PKCS#8 PEM contents
```

### 3. Deploy

```bash
npx wrangler deploy
```

Copy the deployed URL into the GitHub App's Webhook URL field (and re-deliver the
`ping` event to confirm it returns `200`).

### 4. Branch protection

Keep the status context (default `review-gate/codex-clean`) as a required status
check on your protected branch. Because the context name is configurable and
stable, no branch protection changes are needed when cutting over from an Actions
workflow that used the same context — but make sure the App is installed and the
Worker is live **before** removing the old workflow, otherwise the status is
simply not reported (PRs stay blocked, which is the safe failure mode).

## Security notes

- Security depends on the **secrets**, never on source secrecy. The webhook
  endpoint is protected by `X-Hub-Signature-256` HMAC verification against
  `GITHUB_WEBHOOK_SECRET`; the clean-review check only trusts comments authored by
  the configured bot login(s), which cannot be spoofed by other accounts.
- Never commit secrets. `.gitignore` excludes `*.pem` and `.dev.vars`. On public
  repos, enable Push Protection / Secret Scanning, and rotate immediately if a key
  ever lands in git history.

## Local development and tests

```bash
npm test        # node --test, runs the pure gate + webhook unit tests
npm run dev     # wrangler dev, local Worker runtime
```

## Files

- `src/gate.js` — pure gate evaluation (runtime-agnostic, unit tested).
- `src/webhook.js` — signature verification and event-to-PR routing.
- `src/github.js` — GitHub App auth (JWT + installation token) and API calls.
- `src/index.js` — Worker `fetch` handler that ties it together.
- `test/` — `node --test` unit tests.

## License

MIT. See `LICENSE`.
