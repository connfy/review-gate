import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { evaluateGate, resolveConfig, DEFAULT_CLEAN_TEXT, DEFAULT_STATUS_BOARD_MARKER } from "../src/gate.js";
import { evaluateFromGitHub } from "../src/index.js";
import { reviewStateComment, reviewBot } from "./fixtures/review-state.js";

const R = "1111111111111111111111111111111111111111";
const N = "2222222222222222222222222222222222222222";
const B = "3333333333333333333333333333333333333333";
const bot = reviewBot;
const at = (second) => `2026-08-04T00:00:${String(second).padStart(2, "0")}Z`;

function inputs(overrides = {}) {
  return {
    pr: { number: 123, state: "open", draft: false, created_at: "2026-08-01T00:00:00Z",
      head: { sha: N }, base: { sha: B } },
    timelineEvents: [R, N].map((sha) => ({ event: "committed", sha,
      committer: { date: "2026-08-02T00:00:00Z" } })),
    reviews: [], issueComments: [], issueReactions: [], issueEyesReactions: [],
    reviewRequestReactions: [], reviewThreads: [],
    config: resolveConfig(), now: Date.parse("2026-08-04T00:05:00Z"),
    ...overrides,
  };
}

function review(overrides = {}) {
  return { id: 1, user: bot, state: "COMMENTED", commit_id: N,
    submitted_at: at(1), body: "Review completed; see the following clean signal.",
    html_url: "https://github.com/example/project/pull/123#pullrequestreview-1", ...overrides };
}

function reaction(overrides = {}) {
  return { user: bot, content: "+1", created_at: at(3), ...overrides };
}

function comment(overrides = {}) {
  return { id: 2, user: bot, created_at: at(3),
    body: `${DEFAULT_CLEAN_TEXT}\n**Reviewed commit:** \`${N}\``,
    html_url: "https://github.com/example/project/pull/123#issuecomment-2", ...overrides };
}

test("a backdated new authored head cannot reuse the old head's PR-body reaction", () => {
  const result = evaluateGate(inputs({ issueReactions: [reaction({ created_at: "2026-08-03T00:00:00Z" })] }));
  assert.equal(result.state, "failure");
  assert.equal(result.baseSync, undefined);
});

test("old-head formal completion does not bind a later reaction to the new head", () => {
  assert.equal(evaluateGate(inputs({ reviews: [review({ commit_id: R })],
    issueReactions: [reaction()] })).state, "failure");
});

test("a clean reaction bound by full-head completed state remains valid", () => {
  const result = evaluateGate(inputs({ issueComments: [reviewStateComment(N, at(2))], issueReactions: [reaction()] }));
  assert.equal(result.state, "success");
  assert.match(result.details[0], /completed Code Review state/);
});

test("client-controlled past and future Git dates do not decide head-bound review completion", async (context) => {
  for (const date of ["1970-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
    await context.test(date, () => {
      const value = inputs({ issueComments: [reviewStateComment(N, at(2))], issueReactions: [reaction()] });
      value.timelineEvents[1].committer.date = date;
      assert.equal(evaluateGate(value).state, "success");
    });
  }
});

test("same-second request and completion ordering cannot prove a fresh result", () => {
  const request = { id: 8, user: { login: "owner", type: "User" },
    body: "@codex review", created_at: at(1) };
  const value = inputs({ issueComments: [request,reviewStateComment(N,at(1))],
    issueReactions: [reaction()] });
  assert.notEqual(evaluateGate(value).state,"success");
  value.issueComments[1]=reviewStateComment(N,at(2));
  assert.equal(evaluateGate(value).state,"success");
});

test("dismissed, pending, malformed and human formal responses cannot authorize bare reactions", async (context) => {
  for (const invalid of [
    { state: "DISMISSED" }, { state: "PENDING", submitted_at: null },
    { submitted_at: "not a timestamp" }, { state: "unknown" },
    { user: { ...bot, type: "User" } },
  ]) {
    await context.test(JSON.stringify(invalid), () => {
      assert.notEqual(evaluateGate(inputs({ reviews: [review(invalid)],
        issueReactions: [reaction()] })).state, "success");
    });
  }
});

test("dismissal of the latest formal review cannot fall back to an earlier completed review", () => {
  assert.equal(evaluateGate(inputs({ reviews: [review(), review({ id: 2,
    state: "DISMISSED", submitted_at: at(2) })], issueReactions: [reaction()] })).state, "failure");
});

test("both unbound comment representations need full-head completed state", async (context) => {
  for (const representation of ["issue", "timeline"]) {
    await context.test(representation, () => {
      const value = inputs();
      const receipt = comment({ body: DEFAULT_CLEAN_TEXT });
      if (representation === "issue") value.issueComments = [receipt];
      else value.timelineEvents.push({ event: "commented", ...receipt });
      assert.equal(evaluateGate(value).state, "failure");
      value.reviews = [review()];
      assert.equal(evaluateGate(value).state, "failure");
      value.issueComments.push(reviewStateComment(N, at(2)));
      assert.equal(evaluateGate(value).state, "success");
    });
  }
});

test("a complete explicit clean receipt preserves the comment-only review workflow", () => {
  assert.equal(evaluateGate(inputs({ issueComments: [comment()] })).state, "success");
});

test("an abbreviated receipt needs full identity from the provider rather than startsWith or a ref lookup", () => {
  const prefix = N.slice(0, 10);
  const receipt = comment({ body: `${DEFAULT_CLEAN_TEXT}\n**Reviewed commit:** \`${prefix}\`` });
  assert.equal(evaluateGate(inputs({ issueComments: [receipt] })).state, "failure");
  assert.equal(evaluateGate(inputs({ issueComments: [receipt],
    resolvedReviewedCommits: { [prefix]: N } })).state, "failure");
  assert.equal(evaluateGate(inputs({ issueComments: [receipt, reviewStateComment(N, at(2))] })).state, "success");
  // Same displayed prefix cannot replace the full SHA asserted by the provider.
  assert.equal(evaluateGate(inputs({ issueComments: [receipt,
    reviewStateComment(prefix + "4".repeat(30), at(2))] })).state, "failure");
});

test("a newer same-head review request invalidates all earlier direct clean forms", async (context) => {
  for (const form of ["formal", "comment", "reaction"]) {
    await context.test(form, () => {
      const value = inputs();
      if (form === "formal") value.reviews = [review({ body: DEFAULT_CLEAN_TEXT })];
      if (form === "comment") value.issueComments = [comment()];
      if (form === "reaction") { value.reviews = [review()]; value.issueReactions = [reaction()]; }
      const request = { id: 3, user: { login: "owner", type: "User" },
        body: "@codex review", created_at: at(5) };
      value.issueComments.push(request);
      value.timelineEvents.push({ event: "commented", ...request });
      assert.notEqual(evaluateGate(value).state, "success");
    });
  }
});

test("server force-push and restoration boundaries invalidate earlier exact-head receipts", async (context) => {
  for (const event of ["head_ref_force_pushed", "head_ref_restored"]) {
    await context.test(event, () => {
      const value = inputs({ issueComments: [comment()] });
      value.timelineEvents.push({ event, created_at: at(4) });
      assert.equal(evaluateGate(value).state, "failure");
      value.issueComments = [comment({ created_at: at(6) })];
      assert.equal(evaluateGate(value).state, "success");
    });
  }
});

test("pending formal review blocks an older clean receipt and stays pending", () => {
  assert.equal(evaluateGate(inputs({ issueComments: [comment()],
    reviews: [review({ state: "PENDING", submitted_at: null })] })).state, "pending");
});

test("the live status board never supplies exact-head completion for a bare reaction", () => {
  const value = inputs({ issueComments: [comment({ body:
    `${DEFAULT_STATUS_BOARD_MARKER}\n${DEFAULT_CLEAN_TEXT}\n**Reviewed commit:** \`${N}\`` })],
    issueReactions: [reaction()] });
  assert.equal(evaluateGate(value).state, "failure");
});

test("conflicting copies and newer non-clean responses cannot preserve an earlier clean pass", () => {
  const receipt = comment();
  assert.equal(evaluateGate(inputs({ issueComments: [receipt], timelineEvents: [
    ...inputs().timelineEvents, { event: "commented", ...receipt, body: "A finding remains." },
  ] })).state, "failure");
  assert.equal(evaluateGate(inputs({ issueComments: [receipt, comment({ id: 3,
    body: "A finding remains.", created_at: at(4) })] })).state, "failure");
});

test("direct metadata binding works with carry off and never resolves a mutable Git ref", async () => {
  const prefix = N.slice(0, 10);
  const value = inputs({ issueComments: [comment({ body:
    `${DEFAULT_CLEAN_TEXT}\n**Reviewed commit:** \`${prefix}\`` }), reviewStateComment(N, at(2))] });
  const calls = [];
  const client = {
    pullRequest: async () => value.pr, issueComments: async () => value.issueComments,
    issueReactions: async () => [], reviews: async () => [], reviewThreads: async () => [],
    timelineEvents: async () => value.timelineEvents, issueCommentReactions: async () => [],
    resolveReviewedCommit: async (ref, sha) => { calls.push([ref, sha]); return N; },
    gitCommit: async () => { throw new Error("Disabled carry must not read the Git graph"); },
  };
  const result = await evaluateFromGitHub(client, { prNumber: 123 }, resolveConfig());
  assert.equal(result.state, "success");
  assert.equal(result.baseSync, undefined);
  assert.deepEqual(calls, []);
});


test("a non-clean formal completion cannot attribute a delayed old signal to the current head", () => {
  for (const signal of ["reaction", "comment"]) {
    const value = inputs({ reviews: [review()] });
    if (signal === "reaction") value.issueReactions = [reaction()];
    else value.issueComments = [comment({ body: DEFAULT_CLEAN_TEXT })];
    assert.equal(evaluateGate(value).state, "failure");
  }
});

test("structured summary alone never grants a pass or ends the requested-review wait", () => {
  const request = { id: 8, user: { login: "owner", type: "User" },
    body: "@codex review", created_at: at(0) };
  const value = inputs({ issueComments: [request, reviewStateComment(N, at(2))] });
  value.timelineEvents[1].committer.date = at(0);
  value.timelineEvents.push({ event: "commented", ...request });
  assert.equal(evaluateGate(value).state, "pending");
  assert.equal(evaluateGate(inputs({ issueComments: [reviewStateComment(N, at(2))] })).state, "failure");
});

test("receipt preceding the provider completion timestamp remains valid without a grace interval", () => {
  const receipt = comment({ body: `${DEFAULT_CLEAN_TEXT}\n**Reviewed commit:** \`${N.slice(0, 10)}\``, created_at: at(2) });
  const board = reviewStateComment(N, at(3));
  assert.equal(evaluateGate(inputs({ issueComments: [receipt, board] })).state, "success");
});

test("later summary edits cannot refresh a signal past a new request", () => {
  const request = { id: 8, user: { login: "owner", type: "User" }, body: "@codex review", created_at: at(4) };
  for (const completedAt of [at(2), at(5)]) {
    const board = reviewStateComment(N, completedAt, { updated_at: at(7) });
    assert.notEqual(evaluateGate(inputs({ issueComments: [board, request],
      issueReactions: [reaction()], timelineEvents: [...inputs().timelineEvents,
        { event: "commented", ...request }] })).state, "success");
  }
});

test("metadata binding rejects missing, malformed, conflicting, non-clean and wrong-actor evidence", async (context) => {
  const modifiers = {
    "missing board": () => [],
    "unknown version": (x) => [{ ...x, body: x.body.replace("state:v1", "state:v2") }],
    "broken JSON": (x) => [{ ...x, body: x.body.replace('"code_review":', '"code_review"') }],
    "not full SHA": (x) => [{ ...x, body: x.body.replace(N, N.slice(0, 10)) }],
    "array SHA": (x) => [{ ...x, body: x.body.replace(`"${N}"`, `["${N}"]`) }],
    "findings": (x) => [{ ...x, body: x.body.replace('"has_any_findings":false', '"has_any_findings":true') }],
    "unresolved": (x) => [{ ...x, body: x.body.replace('"has_unresolved_findings":false', '"has_unresolved_findings":true') }],
    "running": (x) => [{ ...x, body: x.body.replace('"status":"completed"', '"status":"running"') }],
    "wrong role": (x) => [{ ...x, body: x.body.replace('"code_review"', '"security_review"') }],
    "quoted board": (x) => [{ ...x, body: `Quoted example:\n${x.body}` }],
    "wrong actor": (x) => [{ ...x, user: { ...bot, id: 12 } }],
    "missing actor id": (x) => [{ ...x, user: { login: bot.login, type: "Bot" } }],
    "human alias": (x) => [{ ...x, user: { ...bot, type: "User" } }],
    "wrong display commit": (x) => [{ ...x, body: x.body.replace(`| \`${N.slice(0, 7)}\` |`, '| `1111111` |') }],
    "missing completion date": (x) => [{ ...x, body: x.body.replace(/<relative-time.*<\/relative-time>/, "") }],
    "invalid completion date": (x) => [{ ...x, body: x.body.replaceAll(at(2), "nonsense") }],
    "completion after update": (x) => [{ ...x, updated_at: at(1) }],
    "two summaries": (x) => [x, { ...x, id: 9001 }],
    "two state records": (x) => [{ ...x, body: `${x.body}\n${x.body.split("\n")[1]}` }],
  };
  for (const [name, modify] of Object.entries(modifiers)) {
    await context.test(name, () => {
      const boards = modify(reviewStateComment(N, at(2)));
      assert.equal(evaluateGate(inputs({ issueComments: boards, issueReactions: [reaction()] })).state, "failure");
    });
  }
  const board = reviewStateComment(N, at(2));
  assert.equal(evaluateGate(inputs({ issueComments: [board], issueReactions: [reaction()],
    timelineEvents: [...inputs().timelineEvents, { event: "commented", ...board, body: "A different snapshot" }] })).state, "failure");
});

test("an optional Security Review state does not change a completed Code Review binding", () => {
  const board = reviewStateComment(N, at(2));
  board.body = board.body.replace('"security_review":{"status":null}',
    '"security_review":{"commit_sha":null,"status":"running"}');
  assert.equal(evaluateGate(inputs({ issueComments: [board], issueReactions: [reaction()] })).state, "success");
});

test("recorded public Codex receipt binds to the full reviewed head with no formal review", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/review-state-real/${name}.json`, import.meta.url)));
  const board = read("summary");
  const receipt = read("receipt");
  const sha = "ffe21a41d595dc5ed9b2eb1ac0ea669412f4fb2c";
  const value = inputs({ issueComments: [receipt, board] });
  value.pr.head.sha = sha;
  assert.equal(evaluateGate(value).state, "success");
  value.pr.head.sha = sha.slice(0, 10) + "0".repeat(30);
  assert.equal(evaluateGate(value).state, "failure");
});

test("recorded optional Security Review and older surviving eyes do not block completed Code Review", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/review-state-real/${name}.json`, import.meta.url)));
  const value = inputs({ issueComments: [read("summary-pr12"), read("receipt-pr12")],
    issueEyesReactions: read("reactions-pr12") });
  value.pr.head.sha = "d6fa9c6bb5806b3fe8a217868df0870b49b0147e";
  assert.equal(evaluateGate(value).state, "success");
});

test("recorded reaction-only clean review authenticates its User-shaped reaction through the Bot summary ID", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/review-state-real/${name}.json`, import.meta.url)));
  const board = read("summary-pr13");
  const signals = read("reactions-pr13");
  assert.equal(signals[0].user.type, "User");
  assert.equal(board.user.type, "Bot");
  assert.equal(signals[0].user.id, board.user.id);
  const value = inputs({ issueComments: [board], issueReactions: signals });
  value.pr.head.sha = "008230b5d2c5f4ca6efb7f1e163f7be24828bdf0";
  assert.equal(evaluateGate(value).state, "success");
  value.issueComments = [];
  assert.equal(evaluateGate(value).state, "failure");
  value.issueComments = [board];
  value.issueReactions = [{ ...signals[0], user: { ...signals[0].user, id: board.user.id + 1 } }];
  assert.equal(evaluateGate(value).state, "failure");
  value.issueReactions = signals;
  value.issueComments = [reviewStateComment(value.pr.head.sha, signals[0].created_at, {
    body: board.body.replace('"status":"completed"', '"status":"running"')
      .replace('✅ **Completed**', '🔄 **Running** since'), updated_at: board.updated_at,
  })];
  assert.notEqual(evaluateGate(value).state, "success");
});

test("uncertain actor type does not discard later findings or pending formal review", async (context) => {
  for (const kind of ["formal findings", "pending formal", "comment findings", "timeline findings"]) {
    await context.test(kind, () => {
      const value = inputs({ issueComments: [comment()] });
      const uncertain = { ...bot, type: "User" };
      if (kind === "formal findings") value.reviews = [review({ user: uncertain,
        submitted_at: at(5), body: "A finding remains." })];
      if (kind === "pending formal") value.reviews = [review({ user: uncertain,
        state: "PENDING", submitted_at: null })];
      const finding = comment({ id: 4, user: uncertain, created_at: at(5), body: "A finding remains." });
      if (kind === "comment findings") value.issueComments.push(finding);
      if (kind === "timeline findings") value.timelineEvents.push({ event: "commented", ...finding });
      assert.equal(evaluateGate(value).state, kind === "pending formal" ? "pending" : "failure");
    });
  }
});

test("another configured actor's unbound result cannot expire a known current Running review", () => {
  const board = reviewStateComment(N, at(4));
  board.body = board.body.replace('"status":"completed"', '"status":"running"')
    .replace('✅ **Completed**', '🔄 **Running** since');
  const value = inputs({ issueComments: [board, comment({
    id: 5, user: { id: 1234, login: "second-reviewer[bot]", type: "Bot" },
    created_at: at(5), body: DEFAULT_CLEAN_TEXT,
  })], config: resolveConfig({ botLogins: [bot.login, "second-reviewer[bot]"] }),
    now: Date.parse("2026-08-05T00:00:00Z") });
  assert.equal(evaluateGate(value).state, "pending");
});

test("a canonical never-run Code Review slot is absent evidence, not malformed state", () => {
  const board = reviewStateComment(N, at(4));
  board.body = board.body.replace(/"code_review":\{[^}]+\}/, '"code_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}');
  const result = evaluateGate(inputs({ issueComments: [board] }));
  assert.equal(result.state, "failure");
  assert.equal(result.reviewIdentityFailures, undefined);
});

test("a clean receipt awaiting its binding remains in the requested-review queue", () => {
  const request = { id: 8, user: { login: "owner", type: "User" },
    body: "@codex review", created_at: at(0) };
  const receipt = comment({ body: `${DEFAULT_CLEAN_TEXT}\n**Reviewed commit:** \`${N.slice(0, 10)}\`` });
  const value = inputs({ issueComments: [request, receipt] });
  value.timelineEvents[1].committer.date = at(0);
  value.timelineEvents.push({ event: "commented", ...request });
  assert.equal(evaluateGate(value).state, "pending");
  value.issueComments.push(reviewStateComment(N, at(4)));
  assert.equal(evaluateGate(value).state, "success");
});


test("malformed and contradictory reviewed-commit labels cannot borrow a clean binding", () => {
  for (const label of ["**Reviewed commit:** `not-hex`",
    `**Reviewed commit:** \`${N}\`\n**Reviewed commit:** \`${R}\``]) {
    const receipt = comment({ body: `${DEFAULT_CLEAN_TEXT}\n${label}` });
    assert.equal(evaluateGate(inputs({ issueComments: [receipt, reviewStateComment(N, at(2))] })).state, "failure");
  }
});


test("a later known non-clean Code Review state retracts older independently bound clean authority", () => {
  const old=review({ body: DEFAULT_CLEAN_TEXT });
  const board=reviewStateComment(N, at(4));
  board.body=board.body.replace('"has_any_findings":false','"has_any_findings":true');
  assert.equal(evaluateGate(inputs({ reviews:[old], issueComments:[board] })).state,"failure");
  assert.equal(evaluateGate(inputs({ reviews:[old, review({ id:9, body:DEFAULT_CLEAN_TEXT, submitted_at:at(5) })],
    issueComments:[board] })).state,"success");
});

test("a newer known running Code Review blocks old full-head clean evidence and reports pending", () => {
  const old=comment({ created_at:at(1) });
  const board=reviewStateComment(N,at(4));
  board.body=board.body.replace('"status":"completed"','"status":"running"')
    .replace('✅ **Completed**','🔄 **Running** since');
  assert.equal(evaluateGate(inputs({ issueComments:[old,board] })).state,"pending");
});

test("unbound results exhaust verification time without becoming review completion", () => {
  const receipt = comment({ body: DEFAULT_CLEAN_TEXT });
  const value = inputs({ issueComments: [receipt],
    issueEyesReactions: [reaction({ content: "eyes", created_at: at(1) })] });
  assert.equal(evaluateGate(value).state, "pending");
  value.now += value.config.reviewStartWindowMs;
  const result = evaluateGate(value);
  assert.equal(result.state, "failure");
  assert.match(result.description, /identity verification exceeded/);
  assert.ok(result.reviewIdentityFailures.some((failure) => failure.code === "missing-full-head-binding"));
  value.issueComments.push(reviewStateComment(N, at(2)));
  assert.equal(evaluateGate(value).state, "success");
});

test("User-shaped reaction results retain binding diagnostics and bounded pending verification", async (context) => {
  const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/review-state-real/${name}.json`, import.meta.url)));
  const board = read("summary-pr13");
  const signals = read("reactions-pr13");
  const signalTime = Date.parse(signals[0].created_at);
  const sha = "008230b5d2c5f4ca6efb7f1e163f7be24828bdf0";
  for (const kind of ["missing", "unsupported"]) {
    await context.test(kind, () => {
      const value = inputs({ issueComments: kind === "missing" ? [] : [{
        ...board, body: board.body.replace("state:v1", "state:v2"),
      }], issueReactions: signals, issueEyesReactions: [{ ...signals[0], content: "eyes",
        created_at: new Date(signalTime - 1000).toISOString() }], now: signalTime + 60_000 });
      value.pr.head.sha = sha;
      value.pr.created_at = new Date(signalTime - 600_000).toISOString();
      value.timelineEvents = [{ event: "committed", sha,
        committer: { date: new Date(signalTime - 300_000).toISOString() } }];
      const pending = evaluateGate(value);
      assert.equal(pending.state, "pending");
      assert.ok(pending.reviewIdentityFailures.some((failure) => failure.commentId === signals[0].id));
      value.now += value.config.reviewStartWindowMs;
      const failed = evaluateGate(value);
      assert.equal(failed.state, "failure");
      assert.ok(failed.reviewIdentityFailures.some((failure) => failure.commentId === signals[0].id));
      const running = { ...board, body: board.body.replace('"status":"completed"', '"status":"running"')
        .replace('✅ **Completed**', '🔄 **Running** since') };
      value.issueComments = [running];
      assert.equal(evaluateGate(value).state, "pending");
    });
  }
});

test("known running Code Review cannot expire through an unbound or informational comment", () => {
  const board = reviewStateComment(N, at(4));
  board.body = board.body.replace('"status":"completed"', '"status":"running"')
    .replace('✅ **Completed**', '🔄 **Running** since');
  const value = inputs({ issueComments: [board, comment({ created_at: at(5), body: DEFAULT_CLEAN_TEXT }),
    comment({ id: 3, created_at: at(6), body: "Additional review information." })],
    now: Date.parse("2026-08-05T00:00:00Z") });
  assert.equal(evaluateGate(value).state, "pending");
});

test("an older metadata completion cannot refresh a late receipt past newer eyes", () => {
  const value = inputs({ issueComments: [reviewStateComment(N, at(1)),
    comment({ body: DEFAULT_CLEAN_TEXT, created_at: at(4) })],
    issueEyesReactions: [reaction({ content: "eyes", created_at: at(3) })] });
  assert.equal(evaluateGate(value).state, "pending");
});

test("unsupported provider state is diagnosed once per evaluation without logging comment bodies", async (context) => {
  const receipt = comment({ body: DEFAULT_CLEAN_TEXT });
  const board = reviewStateComment(N, at(2));
  board.body = board.body.replace("state:v1", "state:v2");
  const value = inputs({ issueComments: [receipt, board] });
  const warnings = [];
  context.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const client = {
    pullRequest: async () => value.pr, issueComments: async () => value.issueComments,
    issueReactions: async () => [], reviews: async () => [], reviewThreads: async () => [],
    timelineEvents: async () => value.timelineEvents,
  };
  const result = await evaluateFromGitHub(client, { prNumber: 123 }, resolveConfig());
  assert.equal(result.state, "failure");
  assert.match(result.description, /no verified full-head binding/);
  assert.ok(result.reviewIdentityFailures.some((failure) => failure.code === "unsupported-state-format"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unsupported-state-format/);
  assert.ok(!warnings[0].includes(DEFAULT_CLEAN_TEXT));
  value.issueComments = [board];
  assert.ok(evaluateGate(value).reviewIdentityFailures.some((failure) => failure.code === "unsupported-state-format"));
});
