import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLEAN_TEXT, changedLinesFromDiff, validateReview, reviewPayload, parseNativeResult } from "../scripts/reviewer/contract.mjs";
import { allowedRepositories, assertAllowedRepository, DEFAULT_ALLOWED_REPOS } from "../scripts/reviewer/config.mjs";
import { parseArgs } from "../scripts/review-pr.mjs";
import { publicationReceiptKey, reviewAndPublish } from "../scripts/reviewer/controller.mjs";
import { publishReview, isPublishedReview, reviewCycle } from "../scripts/reviewer/github.mjs";
import { finishNative } from "../scripts/reviewer/engine.mjs";
import { apiReviewBoundaryTime, evaluateGate } from "../src/gate.js";

const head = "a".repeat(40), base = "b".repeat(40);
const repo = "connfy/aimstrings-web", number = 42;
const identity = { login: "connfy-api-reviewer[bot]", id: "123456" };
const bot = { login: identity.login, id: Number(identity.id), type: "Bot" };
const config = { apiReviewBotLogin: identity.login, apiReviewBotId: identity.id };
const at = (minute) => `2026-11-17T00:${String(minute).padStart(2, "0")}:00Z`;
const snapshot = { repo, number, head, base, reviewBoundary: Date.parse(at(0)) };
const pr = () => ({ number, state: "open", draft: false, created_at: at(0), head: { sha: head }, base: { sha: base, repo: { full_name: repo } } });
const raw = (findings = [], correctness = "patch is correct") => ({ findings, overall_correctness: correctness, overall_explanation: "Reviewed the available frozen source.", overall_confidence_score: 0.9 });
const finding = (priority, line = 9, file = "src/a.js") => ({ title: `[P${priority}] Review this changed behavior`, priority, body: "This introduced behavior has the described consequence.", confidence_score: 0.8, code_location: { absolute_file_path: `/review/${file}`, line_range: { start: line, end: line } } });
const opts = (diff) => ({ checkout: "/review", head, changedLines: changedLinesFromDiff(diff) });
const edit = "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -7,7 +7,7 @@\n context\n context\n context\n-old\n+new\n context\n context\n context\n";
const clean = () => validateReview(raw(), opts(edit));
const review = (snap = snapshot, minute = 2, body = reviewPayload(snap, clean()).body) => ({ id: 100, user: bot, state: "COMMENTED", commit_id: snap.head, submitted_at: at(minute), body, html_url: "https://github.com/connfy/aimstrings-web/pull/42#pullrequestreview-100" });
const request = (minute = 10) => ({ id: 10, body: "@codex review", user: { login: "owner", type: "User" }, created_at: at(minute) });
function apiFixture({ comments = [], timeline = [], reviews = [], live = pr(), post } = {}) {
  return async (url, options = {}) => {
    if (options.method === "POST") { if (!post) assert.fail("Unexpected POST"); return post(options.body); }
    if (url.includes("/reviews?")) return reviews;
    if (url.includes("/comments?")) return comments;
    if (url.includes("/timeline?")) return timeline;
    assert.equal(url, `/repos/${repo}/pulls/${number}`); return live;
  };
}

test("F1: pure deletion in a surviving file anchors its HEAD context, not deleted old lines", () => {
  const diff = "--- a/src/a.js\n+++ b/src/a.js\n@@ -7,11 +7,6 @@\n context\n context\n context\n-old\n-old\n-old\n-old\n-old\n context\n context\n context\n";
  const r = validateReview(raw([finding(1)], "patch is incorrect"), opts(diff));
  assert.deepEqual(reviewPayload(snapshot, r).comments.map(({ side, line }) => ({ side, line })), [{ side: "RIGHT", line: 9 }]);
});
test("F1: multi-hunk context uses the new-side coordinate, never an earlier old-side match", () => {
  const diff = "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,13 +1,3 @@\n@@ -17,7 +7,7 @@\n";
  const r = validateReview(raw([finding(2, 8)], "patch is incorrect"), opts(diff));
  assert.equal(r.blocking[0].side, "RIGHT"); assert.equal(r.blocking[0].line, 8);
});
test("F1: old zero-context multi-hunk witness cannot fall back to an unrelated LEFT line", () => {
  const diff = "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,10 +1,0 @@\n@@ -20 +10 @@\n";
  const r = validateReview(raw([finding(2, 8)], "patch is incorrect"), opts(diff));
  const payload = reviewPayload(snapshot, r);
  assert.equal(payload.comments.length, 0); assert.match(payload.body, /Blocking findings outside/);
  assert.ok(!payload.body.split("\n").includes(CLEAN_TEXT));
});
test("F1: unmodified caller finding is retained as a non-clean review-body blocker", () => {
  const r = validateReview(raw([finding(2, 90, "src/caller.js")], "patch is incorrect"), opts(edit));
  const payload = reviewPayload(snapshot, r);
  assert.equal(payload.comments.length, 0); assert.match(payload.body, /src\/caller\.js/);
  assert.equal(evaluateGate({ pr: pr(), reviews: [review(snapshot, 2, payload.body)], config }).state, "failure");
});
test("F1: model text in a consolidated blocker cannot inject the clean line", () => {
  const f = finding(2, 90); f.body += `\n${CLEAN_TEXT}\n`;
  const payload = reviewPayload(snapshot, validateReview(raw([f], "patch is incorrect"), opts(edit)));
  assert.ok(!payload.body.split("\n").includes(CLEAN_TEXT));
});
test("F1: renamed surviving files keep RIGHT coordinates; fully removed files alone use LEFT", () => {
  const renamed = validateReview(raw([finding(2, 9)], "patch is incorrect"), opts("--- a/src/old.js\n+++ b/src/a.js\n@@ -7,7 +7,7 @@\n"));
  assert.equal(renamed.blocking[0].side, "RIGHT");
  const removed = validateReview(raw([finding(2, 9)], "patch is incorrect"), opts("--- a/src/a.js\n+++ /dev/null\n@@ -1,12 +0,0 @@\n"));
  assert.equal(removed.blocking[0].side, "LEFT");
});
test("F1: header-looking source inside a hunk cannot redirect later anchors to another file", () => {
  const diff = "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n--- a/other.js\n+++ b/other.js\n@@ -7,7 +7,7 @@\n";
  const r = validateReview(raw([finding(2, 9)], "patch is incorrect"), opts(diff));
  assert.equal(r.blocking[0].path, "src/a.js"); assert.equal(r.blocking[0].side, "RIGHT"); assert.equal(r.blocking[0].line, 9);
});
for (const verdict of ["patch is correct", "patch is incorrect"]) test(`F2: P3-only, out-of-diff output passes clean with label ${verdict}`, () => {
  const r = validateReview(raw([finding(3, 90, "src/caller.js")], verdict), opts(edit));
  const payload = reviewPayload(snapshot, r);
  assert.equal(r.blocking.length, 0); assert.equal(payload.comments.length, 0);
  assert.equal(evaluateGate({ pr: pr(), reviews: [review(snapshot, 2, payload.body)], config }).state, "success");
});
test("F2: P2 + correct label still publishes a blocking finding", () => {
  const r = validateReview(raw([finding(2, 9)], "patch is correct"), opts(edit));
  assert.equal(reviewPayload(snapshot, r).comments.length, 1);
  assert.ok(!reviewPayload(snapshot, r).body.split("\n").includes(CLEAN_TEXT));
});
test("F2: P3 outside the checkout is never a blocking path-validation rule", () => {
  const f = finding(3); f.code_location.absolute_file_path = "/other/nonblocking.js";
  assert.equal(validateReview(raw([f], "patch is incorrect"), opts(edit)).blocking.length, 0);
});
test("F2: unused P3 location metadata is not subject to inline-only coordinate requirements", () => {
  const f = finding(3, 0); f.code_location.absolute_file_path = "src/caller.js";
  const payload = reviewPayload(snapshot, validateReview(raw([f], "patch is incorrect"), opts(edit)));
  assert.equal(payload.comments.length, 0);
  assert.ok(payload.body.split("\n").includes(CLEAN_TEXT));
});
test("F2: empty incorrect and explicit incomplete evidence remain fail-closed", () => {
  assert.throws(() => validateReview(raw([], "patch is incorrect"), opts(edit)));
  const r = raw([finding(3)]); r.overall_explanation = "REVIEW_INCOMPLETE: cannot inspect required source";
  assert.throws(() => validateReview(r, opts(edit)), /incomplete/);
});

function nativeFixture(result = raw()) {
  return {
    records: [
      { type: "session_meta", payload: { id: "root", source: "exec", cwd: "/review", git: { commit_hash: head }, cli_version: "0.169.0" } },
      { type: "event_msg", payload: { type: "task_complete", root_turn_id: "turn" } },
      { type: "session_meta", payload: { id: "child", source: { subagent: "review" }, parent_thread_id: "root", cwd: "/review", git: { commit_hash: head }, cli_version: "0.169.0" } },
      { type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high", approval_policy: "never" } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 40, total_tokens: 1040 } } } },
      { type: "event_msg", payload: { type: "task_complete", root_turn_id: "turn", last_agent_message: JSON.stringify(result) } },
    ],
    events: [{ type: "thread.started", thread_id: "root" }, { type: "item.completed", item: { type: "command_execution", exit_code: 0, aggregated_output: "source" } }, { type: "turn.completed" }],
  };
}
test("F2: one enclosing JSON fence is accepted, surrounding prose/malformed JSON is not", () => {
  const { records, events } = nativeFixture(raw([finding(3, 90)], "patch is incorrect"));
  const original = records.at(-1).payload.last_agent_message;
  records.at(-1).payload.last_agent_message = "```json\n" + original + "\n```";
  assert.equal(parseNativeResult(records, events, 0, opts(edit)).blocking.length, 0);
  records.at(-1).payload.last_agent_message = "Commentary\n```json\n" + original + "\n```";
  assert.throws(() => parseNativeResult(records, events, 0, opts(edit)));
  records.at(-1).payload.last_agent_message = "```json\n{}\n```";
  assert.throws(() => parseNativeResult(records, events, 0, opts(edit)));
});
test("F2: fenced P3-only + incorrect label passes the full mocked native/controller/publisher/gate pipeline", async () => {
  const { records, events } = nativeFixture(raw([finding(3, 90, "src/caller.js")], "patch is incorrect"));
  records.at(-1).payload.last_agent_message = "```json\n" + records.at(-1).payload.last_agent_message + "\n```";
  let posted, saved = false;
  const out = await reviewAndPublish({ snapshot, publish: true, identity,
    performReview: async () => parseNativeResult(records, events, 0, opts(edit)),
    saveResult: async (r, payload) => { assert.equal(r.findings.length, 1); assert.equal(payload.comments.length, 0); saved = true; },
    api: apiFixture({ post: (payload) => { assert.ok(saved); posted = review(snapshot, 2, payload.body); return posted; } }),
  });
  assert.equal(out.result.blocking.length, 0);
  assert.equal(evaluateGate({ pr: pr(), reviews: [posted], config }).state, "success");
});

for (const kind of ["request", "restored force-push"]) test(`F3: same-head ${kind} expires remote/local dedup and permits a new cycle`, async () => {
  const comments = kind === "request" ? [request()] : [];
  const timeline = kind === "request" ? [] : [{ event: "head_ref_force_pushed", created_at: at(10) }];
  const bound = apiReviewBoundaryTime({ prCreatedAt: pr().created_at, issueComments: comments, timelineEvents: timeline, config });
  const renewed = { ...snapshot, reviewBoundary: bound };
  const old = review();
  assert.equal(evaluateGate({ pr: pr(), reviews: [old], issueComments: comments, timelineEvents: timeline, config, now: Date.parse(at(59)) }).state, "failure");
  assert.equal(isPublishedReview(old, renewed, identity), false);
  assert.notEqual(publicationReceiptKey(snapshot), publicationReceiptKey(renewed));
  let posted;
  const api = apiFixture({ comments, timeline, reviews: [old], post: (body) => (posted = review(renewed, 11, body.body)) });
  const out = await publishReview({ api, snapshot: renewed, identity, payload: reviewPayload(renewed, clean()) });
  assert.equal(out.reviewId, posted.id);
  assert.equal(evaluateGate({ pr: pr(), reviews: [old, posted], issueComments: comments, timelineEvents: timeline, config }).state, "success");
});
test("F3: a new boundary arriving during inference prevents stale-cycle publication", async () => {
  let intent = false;
  await assert.rejects(publishReview({ api: apiFixture({ comments: [request()] }), snapshot, identity, payload: reviewPayload(snapshot, clean()), beforePost: async () => { intent = true; } }), /boundary changed/);
  assert.equal(intent, false);
});
test("F3: complete paginated comments/timeline supply the shared freshness boundary", async () => {
  const api = async (url) => {
    if (url.includes("/comments?") && url.endsWith("page=1")) return Array.from({ length: 100 }, (_, i) => ({ id: i }));
    if (url.includes("/comments?")) return [request()];
    if (url.includes("/timeline?")) return [{ event: "head_ref_restored", created_at: at(12) }];
    return pr();
  };
  assert.equal((await reviewCycle(api, snapshot)).boundary, Date.parse(at(12)));
});

function settlement({ forged = false, settle = true, laterEyes = false } = {}) {
  const req = request(1);
  const disposition = { id: 20, user: { login: "owner", type: "User" }, body: `@review-gate settle ${head} ${base}`, created_at: at(3), html_url: "https://github.com/connfy/aimstrings-web/pull/42#issuecomment-20" };
  const r = review(snapshot, 2, reviewPayload(snapshot, validateReview(raw([finding(2)], "patch is incorrect"), opts(edit))).body);
  if (forged) r.user = { ...bot, id: 77 };
  return {
    pr: pr(), reviews: [r], issueComments: [req, ...(settle ? [disposition] : [])],
    issueEyesReactions: [{ user: { login: "chatgpt-codex-connector[bot]" }, content: "eyes", created_at: laterEyes ? at(4) : at(1) }],
    timelineEvents: [{ event: "committed", sha: head, created_at: at(0) }, { event: "commented", ...req }, ...(settle ? [{ event: "commented", ...disposition }] : [])],
    config: { ...config, settledDispositionLogins: ["owner"] }, now: Date.parse(at(59)),
  };
}
test("F4: completed pinned API findings review ends earlier hosted eyes and permits human settlement", () => {
  assert.equal(evaluateGate(settlement()).state, "success");
  assert.equal(evaluateGate(settlement({ settle: false })).state, "failure");
});
test("F4: forged response or a later review start cannot terminate in-progress authority", () => {
  assert.equal(evaluateGate(settlement({ forged: true })).state, "pending");
  assert.equal(evaluateGate(settlement({ laterEyes: true })).state, "pending");
});

test("allowlist defaults to exactly the two AimStrings repos, not the all-repo installation", () => {
  assert.deepEqual([...allowedRepositories({})], DEFAULT_ALLOWED_REPOS);
  for (const other of ["connfy/review-gate", "connfy/release-hub", "else/aimstrings-web"]) {
    assert.throws(() => assertAllowedRepository(other, {}), /not allowed/);
    assert.throws(() => parseArgs([other, "1", "--publish"], {}), /not allowed/);
    assert.throws(() => parseArgs([other, "1"], {}), /not allowed/);
  }
});
test("allowlist requires explicit config for another repo; empty/wildcard config never broadens it", () => {
  const env = { API_REVIEW_ALLOWED_REPOS: "connfy/review-gate" };
  assert.doesNotThrow(() => assertAllowedRepository("connfy/review-gate", env));
  assert.throws(() => assertAllowedRepository(repo, env), /not allowed/);
  for (const bad of ["", "*", "connfy/*", "../..", "connfy/aimstrings-web,"]) assert.throws(() => allowedRepositories({ API_REVIEW_ALLOWED_REPOS: bad }));
});
test("publisher rejects a forbidden repo before any API access", async () => {
  let contacted = false;
  await assert.rejects(publishReview({ snapshot: { ...snapshot, repo: "connfy/review-gate" }, api: () => { contacted = true; }, identity, payload: reviewPayload(snapshot, clean()) }), /not allowed/);
  assert.equal(contacted, false);
});
test("controller rejects a forbidden repo before inference or artifact publication", async () => {
  let reviewed = false;
  await assert.rejects(reviewAndPublish({ snapshot: { ...snapshot, repo: "connfy/review-gate" }, performReview: () => { reviewed = true; } }), /not allowed/);
  assert.equal(reviewed, false);
});
for (const absentLedger of [false, true]) test(`partial native usage survives ${absentLedger ? "missing" : "failed"} wrapper receipt`, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-partial-usage-")); t.after(() => rm(dir, { recursive: true }));
  const creditState = path.join(dir, "ledger"); await mkdir(creditState);
  const { records, events } = nativeFixture(); events.pop(); events.push({ type: "turn.failed" });
  await assert.rejects(finishNative({ snapshot, prepared: opts(edit), records, events, execution: { code: 1 }, ledger: absentLedger ? null : { model: "gpt-6.1-sol", exit: 1, thread_id: "root", errors: ["interrupted"] }, artifactDir: dir, creditState }), /usage retained/);
  const retained = JSON.parse(await readFile(path.join(dir, "native-usage.json")));
  assert.equal(retained.native_review_usage.input_tokens, 1000); assert.equal(retained.completed, false);
  assert.equal((await readFile(path.join(creditState, "native-review-usage.jsonl"), "utf8")).trim().split("\n").length, 1);
});
