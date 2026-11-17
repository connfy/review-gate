import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLEAN_TEXT, marker, validateReview, parseNativeResult, nativeEvidence, changedLinesFromDiff, reviewPayload } from "../scripts/reviewer/contract.mjs";
import { freezePullRequest, reviewAndPublish } from "../scripts/reviewer/controller.mjs";
import { appClient, githubClient, publishReview, isPublishedReview } from "../scripts/reviewer/github.mjs";
import { engineConfig, isolationArgs } from "../scripts/reviewer/engine.mjs";
import { parseArgs } from "../scripts/review-pr.mjs";
import { evaluateGate, resolveConfig } from "../src/gate.js";

const head = "a".repeat(40), base = "b".repeat(40), other = "c".repeat(40);
const snapshot = { repo: "connfy/aimstrings-web", number: 42, head, base, reviewBoundary: Date.parse("2026-11-17T00:00:00Z") };
const identity = { login: "connfy-api-reviewer[bot]", id: "123456" };
const config = { apiReviewBotLogin: identity.login, apiReviewBotId: identity.id };
const pr = () => ({ number: 42, state: "open", draft: false, created_at: "2026-11-17T00:00:00Z", head: { sha: head }, base: { sha: base, repo: { full_name: snapshot.repo } } });
const raw = () => ({ findings: [], overall_correctness: "patch is correct", overall_explanation: "No actionable introduced defect found.", overall_confidence_score: 0.8 });
const options = { checkout: "/review", head, changedLines: changedLinesFromDiff("--- a/src/a.js\n+++ b/src/a.js\n@@ -3,2 +3,2 @@\n-old\n+new\n") };
const finding = (priority = 2) => ({ title: `[P${priority}] Preserve the account boundary`, body: "This changed branch sends another account's data to the current session.", priority, confidence_score: 0.9, code_location: { absolute_file_path: "/review/src/a.js", line_range: { start: 3, end: 4 } } });
const resultWith = (priority) => validateReview({ ...raw(), findings: [finding(priority)], overall_correctness: priority <= 2 ? "patch is incorrect" : "patch is correct" }, options);
const clean = () => validateReview(raw(), options);
const review = () => ({ id: 999, user: { ...identity, id: Number(identity.id), type: "Bot" }, state: "COMMENTED", commit_id: head, submitted_at: "2026-11-17T00:02:00Z", body: reviewPayload(snapshot, clean()).body, html_url: "https://github.com/connfy/example/pull/42#pullrequestreview-999" });
const evaluate = (r = review(), extra = {}) => evaluateGate({ pr: pr(), reviews: [r], config, now: Date.parse("2026-11-17T01:00:00Z"), ...extra });

test("native result: empty findings is a complete clean result, with publisher-owned text", () => {
  const payload = reviewPayload(snapshot, clean());
  assert.equal(payload.commit_id, head); assert.equal(payload.event, "COMMENT");
  assert.ok(payload.body.includes(CLEAN_TEXT)); assert.equal(payload.comments.length, 0);
  assert.ok(!payload.body.includes(raw().overall_explanation));
});
for (const priority of [0, 1, 2, 3]) test(`P${priority} has the intended blocking boundary`, () => {
  const r = resultWith(priority), payload = reviewPayload(snapshot, r);
  assert.equal(r.blocking.length, priority <= 2 ? 1 : 0);
  assert.equal(payload.comments.length, priority <= 2 ? 1 : 0);
  assert.equal(payload.body.includes(CLEAN_TEXT), priority === 3);
});
for (const [label, mutate] of [
  ["native prose fallback", (r) => { r.overall_correctness = ""; }],
  ["missing findings", (r) => { delete r.findings; }],
  ["missing explanation", (r) => { r.overall_explanation = ""; }],
  ["extra fields", (r) => { r.status = "complete"; }],
  ["invalid confidence", (r) => { r.overall_confidence_score = 2; }],
  ["empty incorrect verdict", (r) => { r.overall_correctness = "patch is incorrect"; }],
  ["unprioritized finding", (r) => { r.findings = [finding()]; delete r.findings[0].priority; }],
  ["unknown priority", (r) => { r.findings = [finding(4)]; }],
  ["outside path", (r) => { r.findings = [finding()]; r.findings[0].code_location.absolute_file_path = "/secret/key"; }],
  ["invalid line range", (r) => { r.findings = [finding()]; r.findings[0].code_location.line_range = { start: 0, end: 0 }; }],
  ["priority/title disagreement", (r) => { r.findings = [finding()]; r.findings[0].title = "[P1] Wrong label"; }],
  ["incomplete verdict sentinel", (r) => { r.overall_explanation = "REVIEW_INCOMPLETE: unable to read source"; }],
]) test(`incomplete/malformed review rejects: ${label}`, () => {
  const r = raw(); mutate(r); assert.throws(() => validateReview(r, options));
});
test("removed-only actionable lines become LEFT inline comments", () => {
  const opts = { ...options, changedLines: changedLinesFromDiff("--- a/src/a.js\n+++ /dev/null\n@@ -3,2 +0,0 @@\n-old\n") };
  const r = validateReview({ ...raw(), findings: [finding()], overall_correctness: "patch is incorrect" }, opts);
  assert.equal(reviewPayload(snapshot, r).comments[0].side, "LEFT");
});

const runtime = () => ({
  records: [
    { type: "session_meta", payload: { id: "test-thread", source: "exec", cwd: "/review", git: { commit_hash: head }, cli_version: "0.169.0" } },
    { type: "event_msg", payload: { type: "task_complete", root_turn_id: "root-turn" } },
    { type: "session_meta", payload: { id: "review-thread", parent_thread_id: "test-thread", source: { subagent: "review" }, cwd: "/review", git: { commit_hash: head }, cli_version: "0.169.0" } },
    { type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high", approval_policy: "never" } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 40, total_tokens: 1040 } } } },
    { type: "event_msg", payload: { type: "task_complete", root_turn_id: "root-turn", last_agent_message: JSON.stringify(raw()) } },
  ],
  events: [{ type: "thread.started", thread_id: "test-thread" }, { type: "item.completed", item: { type: "command_execution", command: "git diff base", exit_code: 0, aggregated_output: "+ changed source" } }, { type: "item.completed", item: { type: "command_execution", command: "sed -n '1,80p' src/a.js", exit_code: 0, aggregated_output: "source contents" } }, { type: "turn.completed", usage: { input_tokens: 1000 } }],
});
test("native adapter accepts structured result with completed runtime and source inspection", () => {
  const { records, events } = runtime(); assert.equal(parseNativeResult(records, events, 0, options).blocking.length, 0);
});
for (const label of ["quota", "timeout", "missing output", "prose fallback", "zero native usage", "no source read", "unexpected MCP", "nonzero exit", "duplicate result", "wrong review parent", "wrong native head", "wrong model", "missing completion IDs"]) test(`native execution fails closed: ${label}`, () => {
  const { records, events } = runtime(); let exit = 0;
  if (label === "quota") events.splice(-1, 0, { type: "error", message: "credit_balance_exhausted" });
  if (label === "timeout") events.pop();
  if (label === "missing output") records.length = 0;
  if (label === "prose fallback") records.at(-1).payload.last_agent_message = "The patch looks clean";
  if (label === "zero native usage") records[4].payload.info.total_token_usage.input_tokens = 0;
  if (label === "no source read") events.splice(1, 2);
  if (label === "unexpected MCP") events.splice(-1, 0, { type: "item.completed", item: { type: "mcp_tool_call" } });
  if (label === "nonzero exit") exit = 1;
  if (label === "duplicate result") records.push(records.at(-1));
  if (label === "wrong review parent") records[2].payload.parent_thread_id = "other-thread";
  if (label === "wrong native head") records[2].payload.git.commit_hash = other;
  if (label === "wrong model") records[3].payload.model = "other-model";
  if (label === "missing completion IDs") { delete records[1].payload.root_turn_id; delete records.at(-1).payload.root_turn_id; }
  assert.throws(() => parseNativeResult(records, events, exit, options));
});
test("native child usage, not the CLI's observed zero root usage, establishes accounting", () => {
  const { records, events } = runtime(); events.at(-1).usage.input_tokens = 0;
  assert.equal(parseNativeResult(records, events, 0, options).blocking.length, 0);
  assert.equal(nativeEvidence(records, events, options).usage.input_tokens, 1000);
});
test("alternative successful source readers do not fail a command-name heuristic", () => {
  const { records, events } = runtime(); events.splice(1, 2, { type: "item.completed", item: { type: "command_execution", command: "git show HEAD:src/a.js", exit_code: 0, aggregated_output: "reviewed source" } });
  assert.equal(parseNativeResult(records, events, 0, options).blocking.length, 0);
});

test("controller freezes target SHAs instead of retaining a mutable PR object", () => {
  const p = pr(), frozen = freezePullRequest(p, snapshot.repo, 42); p.head.sha = other;
  assert.equal(frozen.head, head); assert.ok(Object.isFrozen(frozen));
  assert.throws(() => freezePullRequest({ ...pr(), state: "closed" }, snapshot.repo, 42));
});
test("dry run saves the payload and never calls the publisher API", async () => {
  let saved = 0;
  const out = await reviewAndPublish({ snapshot, performReview: async () => clean(), saveResult: async (_r, payload) => { saved++; assert.equal(payload.commit_id, head); }, api: () => assert.fail("network mutation on dry run") });
  assert.equal(saved, 1); assert.equal(out.publication.dryRun, true);
});
test("review failure saves/posts no clean result", async () => {
  await assert.rejects(reviewAndPublish({ snapshot, publish: true, performReview: async () => { throw new Error("quota"); }, saveResult: () => assert.fail("saved clean"), api: () => assert.fail("published clean") }), /quota/);
});
test("artifact write failure prevents publication", async () => {
  await assert.rejects(reviewAndPublish({ snapshot, publish: true, performReview: async () => clean(), saveResult: async () => { throw new Error("disk full"); }, api: () => assert.fail("publication before save") }), /disk full/);
});
test("publisher makes one atomic COMMENT review with explicit commit_id and inline blockers", async () => {
  const posts = []; let intent = false;
  const api = async (url, options = {}) => {
    if (url.includes("?per_page")) return [];
    if (options.method === "POST") { assert.ok(intent); posts.push(options.body); return review(); }
    return pr();
  };
  await publishReview({ api, snapshot, payload: reviewPayload(snapshot, resultWith(2)), identity, beforePost: async () => { intent = true; } });
  assert.equal(posts.length, 1); assert.equal(posts[0].commit_id, head); assert.equal(posts[0].comments.length, 1);
  assert.ok(!posts[0].body.includes(CLEAN_TEXT));
});
for (const label of ["new head", "new base", "draft", "closed", "wrong target", "wrong commit_id"]) test(`publisher rejects changed target: ${label}`, async () => {
  const p = pr(), payload = reviewPayload(snapshot, clean());
  if (label === "new head") p.head.sha = other;
  if (label === "new base") p.base.sha = other;
  if (label === "draft") p.draft = true;
  if (label === "closed") p.state = "closed";
  if (label === "wrong target") p.base.repo.full_name = "other/repo";
  if (label === "wrong commit_id") payload.commit_id = other;
  const api = async (url, opts) => { assert.notEqual(opts?.method, "POST"); return url.includes("?per_page") ? [] : p; };
  await assert.rejects(publishReview({ api, snapshot, payload, identity }));
});
test("remote signed review deduplicates per head, including after a later base advance", async () => {
  const r = review(); r.body = r.body.replace(`base=${base}`, `base=${other}`);
  const api = async (url, opts) => { assert.notEqual(opts?.method, "POST"); if (url.includes("/reviews?")) return [r]; return url.includes("?per_page") ? [] : pr(); };
  const out = await publishReview({ api, snapshot, payload: reviewPayload(snapshot, clean()), identity });
  assert.equal(out.deduplicated, true);
  assert.equal(isPublishedReview({ ...r, user: { ...r.user, id: 77 } }, snapshot, identity), false);
});
test("ambiguous POST failure is attempted once, with intent already persisted", async () => {
  let posted = 0, intent = 0;
  const api = async (url, opts) => { if (opts?.method === "POST") { posted++; throw new Error("lost response"); } return url.includes("?per_page") ? [] : pr(); };
  await assert.rejects(publishReview({ api, snapshot, payload: reviewPayload(snapshot, clean()), identity, beforePost: async () => { intent++; } }), /lost response/);
  assert.equal(posted, 1); assert.equal(intent, 1);
});
for (const priority of [null, 2, 3]) test(`integrated mocked controller → App Review → gate, priority ${priority ?? "none"}`, async () => {
  let posted, saved = false;
  const api = async (url, opts) => {
    if (opts?.method === "POST") { assert.ok(saved); posted = { ...review(), body: opts.body.body, commit_id: opts.body.commit_id }; return posted; }
    return url.includes("?per_page") ? [] : pr();
  };
  const out = await reviewAndPublish({ snapshot, api, identity, publish: true,
    performReview: async () => priority === null ? clean() : resultWith(priority),
    saveResult: async () => { saved = true; } });
  assert.equal(out.publication.reviewId, 999);
  assert.equal(evaluate(posted, { reviewThreads: priority === 2 ? [{ isResolved: false, isOutdated: false }] : [] }).state, priority === 2 ? "failure" : "success");
});
test("GitHub client throws HTTP errors without printing response/token material", async () => {
  const api = githubClient("dummy-test-token", async () => new Response("sensitive server detail", { status: 403 }));
  await assert.rejects(api("/test"), (e) => /HTTP 403/.test(e.message) && !/dummy|sensitive/.test(e.message));
});
test("App authentication reads an env-named key path and pins App slug + numeric Bot identity", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "app-auth-test-")); t.after(() => rm(dir, { recursive: true }));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(path.join(dir, "key.pem"), privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  const env = { API_REVIEW_APP_ID: "10", API_REVIEW_INSTALLATION_ID: "11", API_REVIEW_PRIVATE_KEY_PATH: path.join(dir, "key.pem"), API_REVIEW_BOT_LOGIN: identity.login, API_REVIEW_BOT_ID: identity.id };
  let count = 0;
  const fetcher = async (url, opts) => {
    count++; assert.ok(opts.headers.Authorization.startsWith("Bearer "));
    assert.equal(opts.headers["Content-Type"], "application/json"); assert.equal(opts.headers["User-Agent"], "connfy-api-reviewer");
    if (url.endsWith("/app")) return Response.json({ slug: "connfy-api-reviewer" });
    if (url.includes("/users/")) { assert.equal(opts.headers.Authorization, "Bearer dummy-installation-token"); return Response.json({ login: identity.login, id: Number(identity.id), type: "Bot" }); }
    assert.equal(opts.method, "POST"); assert.deepEqual(JSON.parse(opts.body).permissions, { contents: "read", pull_requests: "write" });
    return Response.json({ token: "dummy-installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  };
  assert.equal(typeof await appClient(env, fetcher), "function"); assert.equal(count, 3);
  await assert.rejects(appClient({ ...env, API_REVIEW_BOT_ID: "77" }, fetcher), /identity mismatch/);
  await assert.rejects(appClient({}), /Missing/);
});

test("gate accepts only a pinned App's fresh exact-head formal clean review", () => { assert.equal(evaluate().state, "success"); });
for (const [label, mutate] of [
  ["forged author login", (r) => { r.user.login = "attacker"; }],
  ["forged numeric id", (r) => { r.user.id = 77; }],
  ["human account", (r) => { r.user.type = "User"; }],
  ["stale commit_id", (r) => { r.commit_id = other; }],
  ["missing commit_id", (r) => { delete r.commit_id; }],
  ["wrong body commit", (r) => { r.body = r.body.replace(`head=${head}`, `head=${other}`); }],
  ["dismissed review", (r) => { r.state = "DISMISSED"; }],
  ["pending review", (r) => { r.state = "PENDING"; }],
  ["missing submitted_at", (r) => { delete r.submitted_at; }],
  ["review predates server boundary", (r) => { r.submitted_at = "2026-11-16T00:00:00Z"; }],
  ["quoted clean sentence", (r) => { r.body = `${marker(snapshot)}\n\n> ${CLEAN_TEXT}`; }],
]) test(`gate rejects ${label}`, () => { const r = review(); mutate(r); assert.equal(evaluate(r).state, "failure"); });
test("App cannot use issue-comment/reaction fallback, even if appended to legacy bot logins", () => {
  const r = review(), c = { ...config, botLogins: [identity.login] };
  assert.equal(resolveConfig(c).botLogins.has(identity.login), false);
  assert.equal(evaluate(r, { reviews: [], config: c, issueComments: [{ id: 3, user: r.user, body: CLEAN_TEXT, created_at: r.submitted_at }], issueReactions: [{ user: r.user, content: "+1", created_at: r.submitted_at }], timelineEvents: [{ event: "committed", sha: head, created_at: pr().created_at }, { event: "commented", id: 3, user: r.user, body: CLEAN_TEXT }] }).state, "failure");
});
test("missing/invalid numeric id fails closed, not login-only", () => {
  for (const id of [undefined, "", "0", "not-an-id", "1.2"]) assert.equal(evaluate(review(), { config: { ...config, apiReviewBotId: id, botLogins: [identity.login] } }).state, "failure");
});
test("new head, fresh request, draft or unresolved current thread cannot pass", () => {
  assert.equal(evaluate(review(), { pr: { ...pr(), head: { sha: other } } }).state, "failure");
  assert.equal(evaluate(review(), { pr: { ...pr(), draft: true } }).state, "failure");
  assert.equal(evaluate(review(), { reviewThreads: [{ isResolved: false, isOutdated: false }] }).state, "failure");
  assert.equal(evaluate(review(), { issueComments: [{ user: { login: "owner" }, body: "@codex review", created_at: "2026-11-17T00:03:00Z" }] }).state, "failure");
});
test("configured new clean text is shared by publisher and gate", () => {
  const text = "Reviewer completed with no material findings.";
  const r = { ...review(), body: reviewPayload(snapshot, clean(), text).body };
  assert.equal(evaluate(r).state, "failure"); assert.equal(evaluate(r, { config: { ...config, apiReviewCleanText: text } }).state, "success");
});
test("legacy hosted clean reviews keep their existing behavior alongside the new App", () => {
  assert.equal(evaluate({ user: { login: "chatgpt-codex-connector[bot]" }, commit_id: head, submitted_at: review().submitted_at, body: "Codex Review: Didn't find any major issues." }).state, "success");
});
test("CLI accepts only live PR inputs, dry-run by default", () => {
  assert.deepEqual(parseArgs(["Connfy/Aimstrings-Web", "42"]), { repo: snapshot.repo, number: 42, publish: false });
  assert.equal(parseArgs([snapshot.repo, "42", "--publish"]).publish, true);
  for (const args of [[snapshot.repo, "0"], ["--evil", "42"], [snapshot.repo, "42", "--head", head]]) assert.throws(() => parseArgs(args));
});
test("review environment has no project trust/MCP, inherited credentials or writable source mounts", () => {
  const cfg = engineConfig({ checkout: "/tmp/source/checkout", policies: "/tmp/source/policies", artifactDir: "/job" });
  assert.match(cfg, /trust_level = "untrusted"/); assert.match(cfg, /inherit = "none"/);
  assert.match(cfg, /project_doc_max_bytes = 0/); assert.doesNotMatch(cfg, /mcp_servers|danger-full-access/);
  assert.match(cfg, /enabled = false/); assert.match(cfg, /model_reasoning_effort = "high"/);
  const args = isolationArgs({ codexBin: "/runtime/bin/codex", resolverPath: "/mnt/wsl/resolv.conf", keyFile: "/key", creditState: "/ledger", artifactDir: "/job", scratch: "/tmp/source", codexHome: "/job/codex-home", args: ["review", "--base", base] });
  assert.ok(args.includes("--clearenv")); assert.ok(args.includes("--unshare-pid")); assert.ok(!args.includes("--trust"));
  assert.ok(!args.includes(process.env.API_REVIEW_PRIVATE_KEY_PATH ?? "unmounted-private-key"));
});
