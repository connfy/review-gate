import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateGate } from "../src/gate.js";
import { validateReview, changedLinesFromDiff, reviewPayload, CLEAN_TEXT } from "../scripts/reviewer/contract.mjs";
import { appClient, publishReview } from "../scripts/reviewer/github.mjs";

const head = "a".repeat(40), base = "b".repeat(40), other = "c".repeat(40);
const at = (minute) => `2026-11-17T00:${String(minute).padStart(2, "0")}:00Z`;
const identity = { login: "connfy-api-reviewer[bot]", id: "123456" };
const bot = { login: identity.login, id: Number(identity.id), type: "Bot" };
const config = { apiReviewBotLogin: identity.login, apiReviewBotId: identity.id };
const snapshot = { repo: "connfy/review-gate", number: 16, head, base, reviewBoundary: Date.parse(at(0)) };
const pr = () => ({ number: 16, draft: false, state: "open", created_at: at(0), head: { sha: head }, base: { sha: base, repo: { full_name: snapshot.repo } } });
const raw = (priority) => ({
  findings: priority === undefined ? [] : [{ title: `[P${priority}] Preserve this behavior`, body: "The changed path has an actionable regression.", priority, confidence_score: 0.9, code_location: { absolute_file_path: "/review/src/caller.js", line_range: { start: 90, end: 90 } } }],
  overall_correctness: priority === undefined || priority === 3 ? "patch is correct" : "patch is incorrect", overall_explanation: "Reviewed the frozen source.", overall_confidence_score: 0.9,
});
const result = (priority) => validateReview(raw(priority), { checkout: "/review", changedLines: changedLinesFromDiff("--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n") });
const apiReview = (priority = 2, minute = 2) => ({ user: bot, state: "COMMENTED", commit_id: head, submitted_at: at(minute), body: reviewPayload(snapshot, result(priority)).body });
const hostedClean = { user: { login: "chatgpt-codex-connector[bot]", type: "Bot" }, state: "COMMENTED", commit_id: head, submitted_at: at(1), body: "Codex Review: Didn't find any major issues." };
const evaluate = (review, extra = {}) => evaluateGate({ pr: pr(), reviews: [hostedClean, review], config, ...extra });

test("PR16 P1: real publisher body-only P0–P2 findings override an earlier hosted clean", () => {
  for (const priority of [0, 1, 2]) {
    const payload = reviewPayload(snapshot, result(priority)); assert.equal(payload.comments.length, 0);
    const out = evaluate(apiReview(priority));
    assert.equal(out.state, "failure"); assert.match(out.details.join(" "), /body-only/i);
  }
});
test("PR16 P1: P3-only reviews do not create negative authority", () => {
  const payload = reviewPayload(snapshot, result(3)); assert.ok(payload.body.split("\n").includes(CLEAN_TEXT));
  assert.equal(evaluate(apiReview(3)).state, "success");
});
for (const kind of ["issue comment", "PR reaction"]) test(`PR16 P1: a hosted clean ${kind} cannot hide body-only blockers`, () => {
  const comment = { id: 30, user: hostedClean.user, body: hostedClean.body, created_at: at(1) };
  const input = { pr: pr(), config, timelineEvents: [{ event: "committed", sha: head, created_at: at(0) }],
    ...(kind === "issue comment"
      ? { issueComments: [comment] }
      : { issueReactions: [{ user: hostedClean.user, content: "+1", created_at: at(1) }] }),
  };
  if (kind === "issue comment") input.timelineEvents.push({ event: "commented", ...comment });
  assert.equal(evaluateGate(input).state, "success");
  assert.equal(evaluateGate({ ...input, reviews: [apiReview()] }).state, "failure");
});
for (const [label, mutate] of [
  ["forged numeric actor", (r) => { r.user = { ...bot, id: 77 }; }],
  ["wrong commit", (r) => { r.commit_id = other; }],
  ["wrong marker", (r) => { r.body = r.body.replace(`head=${head}`, `head=${other}`); }],
  ["dismissed", (r) => { r.state = "DISMISSED"; }],
  ["quoted body section", (r) => { r.body = r.body.replace("\n### Blocking findings outside the inline diff\n", "\n> ### Blocking findings outside the inline diff\n"); }],
]) test(`PR16 P1: ${label} cannot manufacture a body-only blocker`, () => {
  const r = apiReview(); mutate(r); assert.equal(evaluate(r).state, "success");
});
function settled(minute = 3, blockerMinute = 2) {
  const req = { id: 10, user: { login: "owner", type: "User" }, body: "@codex review", created_at: at(1) };
  const disposition = { id: 20, user: { login: "owner", type: "User" }, body: `@review-gate settle ${head} ${base}`, created_at: at(minute), html_url: "https://github.com/connfy/review-gate/pull/16#issuecomment-20" };
  return evaluate(apiReview(2, blockerMinute), {
    config: { ...config, settledDispositionLogins: ["owner"] }, issueComments: [req, disposition],
    timelineEvents: [{ event: "committed", sha: head, created_at: at(0) }, { event: "commented", ...req }, { event: "commented", ...disposition }],
  });
}
test("PR16 P1: a later authorized exact-pair settlement closes the body-only findings", () => {
  const out = settled(); assert.equal(out.state, "success"); assert.match(out.description, /Settled by @owner/);
});
test("PR16 P1: settlement predating a newer body-only review cannot clear that review", () => {
  assert.equal(settled(3, 4).state, "failure");
});
test("PR16 P1: pushing a different reviewed head makes old body findings stale", () => {
  assert.equal(evaluate(apiReview(), { pr: { ...pr(), head: { sha: other } }, reviews: [{ ...hostedClean, commit_id: other }, apiReview()] }).state, "success");
});

async function authFixture(t, { expires = true, failRefresh = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reviewer-token-pr16-")); t.after(() => rm(dir, { recursive: true }));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = path.join(dir, "synthetic.pem"); await writeFile(keyPath, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  const env = { API_REVIEW_APP_ID: "10", API_REVIEW_INSTALLATION_ID: "11", API_REVIEW_PRIVATE_KEY_PATH: keyPath, API_REVIEW_BOT_LOGIN: identity.login, API_REVIEW_BOT_ID: identity.id };
  let time = Date.now(), issued = 0, currentToken, expiry, reviewPosts = 0;
  const jwtClaims = [];
  const fetcher = async (url, options) => {
    if (url.endsWith("/app")) return Response.json({ slug: "connfy-api-reviewer" });
    if (url.endsWith("/access_tokens")) {
      if (failRefresh && issued > 0) return Response.json({}, { status: 401 });
      jwtClaims.push(JSON.parse(Buffer.from(options.headers.Authorization.split(" ")[1].split(".")[1], "base64url")));
      currentToken = `synthetic-token-${++issued}`; expiry = time + 3_600_000;
      return Response.json({ token: currentToken, ...(expires ? { expires_at: new Date(expiry).toISOString() } : {}) });
    }
    if (options.headers.Authorization !== `Bearer ${currentToken}` || time >= expiry) return Response.json({}, { status: 401 });
    if (url.includes("/users/")) return Response.json(bot);
    if (options.method === "POST") {
      reviewPosts++; throw new Error("ambiguous review POST transport failure");
    }
    if (url.includes("?per_page")) return Response.json([]);
    if (url.endsWith("/pulls/16")) return Response.json(pr());
    return Response.json({ ok: true });
  };
  return { env, fetcher, now: () => time, advance: (ms) => { time += ms; }, get issued() { return issued; }, get reviewPosts() { return reviewPosts; }, jwtClaims };
}
test("PR16 P2: long review refreshes expired installation credentials using a fresh App JWT", async (t) => {
  const fixture = await authFixture(t);
  const api = await appClient(fixture.env, fixture.fetcher, { now: fixture.now });
  fixture.advance(65 * 60_000);
  assert.equal((await api("/repos/connfy/review-gate/metadata")).ok, true);
  assert.equal(fixture.issued, 2);
  const claims = fixture.jwtClaims.at(-1), nowSeconds = Math.floor(fixture.now() / 1000);
  assert.ok(claims.iat <= nowSeconds && claims.exp > nowSeconds);
  assert.ok(claims.iat > fixture.jwtClaims[0].exp);
});
test("PR16 P2: parallel publication reads share one pre-expiry refresh", async (t) => {
  const fixture = await authFixture(t);
  const api = await appClient(fixture.env, fixture.fetcher, { now: fixture.now });
  fixture.advance(59.5 * 60_000);
  await Promise.all([api("/one"), api("/two")]);
  assert.equal(fixture.issued, 2);
});
test("PR16 P2: invalid token lifetime fails closed", async (t) => {
  const fixture = await authFixture(t, { expires: false });
  await assert.rejects(appClient(fixture.env, fixture.fetcher, { now: fixture.now }), /expir|lifetime/i);
});
test("PR16 P2: credential refresh failure aborts before Review POST intent", async (t) => {
  const fixture = await authFixture(t, { failRefresh: true });
  const api = await appClient(fixture.env, fixture.fetcher, { now: fixture.now });
  fixture.advance(65 * 60_000);
  let intents = 0;
  await assert.rejects(publishReview({ api, snapshot, identity, payload: reviewPayload(snapshot, result()), beforePost: async () => { intents++; } }), /HTTP 401/);
  assert.equal(fixture.reviewPosts, 0); assert.equal(intents, 0);
});
test("PR16 P2: refreshed publication never retries an ambiguous Review POST", async (t) => {
  const fixture = await authFixture(t);
  const api = await appClient(fixture.env, fixture.fetcher, { now: fixture.now });
  fixture.advance(65 * 60_000);
  let intents = 0;
  await assert.rejects(publishReview({ api, snapshot, identity, payload: reviewPayload(snapshot, result()), beforePost: async () => { intents++; } }), /ambiguous review POST/);
  assert.equal(fixture.issued, 2); assert.equal(fixture.reviewPosts, 1); assert.equal(intents, 1);
});
