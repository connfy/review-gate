# Review Gate

Languages: English | [한국어](README.ko.md)

> An AI said "this PR looks clean." But can you really hit merge on its word alone?

Review Gate is a tiny Cloudflare Worker that removes that awkward moment of
doubt. When Codex (or any other reviewer bot) decides a PR is clean, it flips a
GitHub commit status to green. If the PR is still a draft, has unresolved review
threads, or the latest commit hasn't been reviewed yet, it stays red.

In one line: it's the **missing layer between "we asked an AI to review" and
"okay, this is actually safe to merge."** Your PR gets a status with this name,
and that status becomes your merge signal:

`review-gate/codex-clean`

Why you'll want it:

- No cron, no polling workflow, no GitHub Actions minutes burned re-checking the
  same PR. GitHub sends a webhook, the Worker recomputes once, done. It runs for
  very little.
- One Worker plus one GitHub App covers dozens of repositories at once.
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

A "clean pass" counts in either of two forms:

- the bot left a PR timeline comment containing the clean-review text, or
- the bot left a PR review (with the clean text) whose `commit_id` matches the
  current head SHA.

By default Review Gate trusts these bots,

- `chatgpt-codex-connector`
- `chatgpt-codex-connector[bot]`

and treats this line as the clean signal:

`Codex Review: Didn't find any major issues.`

Heads up: reviewer thumbs-up reactions are ignored on purpose. GitHub doesn't
deliver reaction webhooks, so a webhook-only tool can't observe them reliably.

## Setup (quicker than it looks)

Five steps total. Create a GitHub App → convert the key → deploy the Worker →
connect the App → done.

### 1. Create a GitHub App

In GitHub, create a new GitHub App under your personal account or an organization.
There's a bit to configure, but just follow the tables below.

Give it these **Repository permissions**:

| Permission | Access | Why it's needed |
| --- | --- | --- |
| Commit statuses | Read and write | To write `review-gate/codex-clean` onto the PR head SHA. |
| Pull requests | Read-only | To read PR state, reviews, inline comments, and review threads. |
| Issues | Read-only | To receive PR timeline comments. GitHub models PR comments as issue comments internally. |

Subscribe it to these five events:

- Pull request
- Pull request review
- Pull request review comment
- Pull request review thread
- Issue comment

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

Shortly after Codex leaves a clean-pass comment, Review Gate recomputes the PR
and flips the status to green.

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

## Configuration

Non-secret settings live in `wrangler.toml`. Tweak them here if you want to use a
different reviewer bot or change the trigger text.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STATUS_CONTEXT` | `review-gate/codex-clean` | The commit status name to write. |
| `REVIEW_BOT_LOGINS` | `chatgpt-codex-connector,chatgpt-codex-connector[bot]` | Bot logins whose clean pass counts (comma-separated). |
| `CLEAN_REVIEW_TEXT` | `Codex Review: Didn't find any major issues.` | Text that marks a clean review pass. |

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
- `src/webhook.js` - signature verification, event routing, webhook fast paths.
- `src/github.js` - GitHub App auth, installation token caching, GitHub API calls.
- `src/index.js` - the Cloudflare Worker entrypoint.
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
