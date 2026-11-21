import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { evaluateGate } from "../src/gate.js";
import { changedLinesFromDiff, reviewPayload, CLEAN_TEXT } from "../scripts/reviewer/contract.mjs";
import {
  GEMINI_REVIEW_MODEL,
  GEMINI_REVIEW_THINKING_LEVEL,
  createReadOnlyTools,
  runGemini,
  verifyGeminiSubmission,
} from "../scripts/reviewer/engine-gemini.mjs";

const execFileAsync = promisify(execFile);

async function gitCmd(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return stdout.trim();
}

async function createSnapshotFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gemini-reviewer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const origin = path.join(root, "origin");
  await mkdir(origin);
  await gitCmd(origin, ["init", "-b", "main"]);
  await mkdir(path.join(origin, "src"));
  await writeFile(path.join(origin, "AGENTS.md"), "# Frozen Base Policy\nCheck auth boundaries.\n");
  await writeFile(path.join(origin, "src/app.js"), "export function check(user) {\n  return user.role === 'admin';\n}\n");
  await writeFile(path.join(origin, "src/removed.js"), "export function legacySecret() {\n  return 'legacy-secret-token';\n}\n");
  await gitCmd(origin, ["add", "."]);
  await gitCmd(origin, ["commit", "-m", "base"]);
  const base = await gitCmd(origin, ["rev-parse", "HEAD"]);

  await writeFile(
    path.join(origin, "src/app.js"),
    "export function check(user) {\n  if (!user) return true;\n  return user.role === 'admin';\n}\n",
  );
  await writeFile(path.join(origin, "src/caller.js"), "export function callCheck() {\n  return true;\n}\n");
  await gitCmd(origin, ["rm", "src/removed.js"]);
  await gitCmd(origin, ["add", "."]);
  await gitCmd(origin, ["commit", "-m", "head"]);
  const head = await gitCmd(origin, ["rev-parse", "HEAD"]);

  const scratch = path.join(root, "scratch");
  const bare = path.join(scratch, "objects.git");
  const checkout = path.join(scratch, "checkout");
  const policies = path.join(scratch, "policies");
  const artifactDir = path.join(root, "artifacts");
  const creditState = path.join(root, "credit-state");
  const outsideSecret = path.join(root, "outside-secret.txt");
  const keyFile = path.join(root, "gemini-key.txt");
  const fakeApiKey = "AIzaTestFakeSecretKey987654321";

  await writeFile(outsideSecret, "TOP_SECRET_DO_NOT_READ\n");
  await writeFile(keyFile, fakeApiKey + "\n", { mode: 0o600 });
  await mkdir(scratch);
  await mkdir(policies);
  await mkdir(artifactDir);
  await mkdir(creditState);

  await gitCmd(scratch, ["init", "--bare", bare]);
  await gitCmd(bare, ["fetch", "--no-tags", origin, head, base]);
  await gitCmd(bare, ["worktree", "add", "--detach", checkout, head]);
  const mergeBase = await gitCmd(checkout, ["merge-base", base, head]);
  const diffText = (await execFileAsync("git", ["-C", checkout, "diff", "--no-ext-diff", "--no-textconv", "--unified=3", mergeBase, head, "--"])).stdout;
  await writeFile(path.join(scratch, "diff.patch"), diffText);
  await writeFile(path.join(policies, "AGENTS.md"), "# Frozen Base Policy\nCheck auth boundaries.\n");

  const snapshot = {
    repo: "connfy/rmo-center",
    number: 95,
    head,
    base,
    reviewBoundary: Date.parse("2026-11-21T00:00:00Z"),
  };
  const prepared = {
    bare,
    checkout,
    mergeBase,
    policies,
    changedLines: changedLinesFromDiff(diffText),
  };
  return { root, scratch, bare, checkout, mergeBase, policies, artifactDir, creditState, outsideSecret, keyFile, fakeApiKey, diffText, snapshot, prepared };
}

function mockGeminiResponse({ parts, finishReason = "STOP", promptTokens = 120, candidatesTokens = 30, thoughtsTokens = 40 }) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason, content: { role: "model", parts } }],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: candidatesTokens,
      thoughtsTokenCount: thoughtsTokens,
      cachedContentTokenCount: 10,
      totalTokenCount: promptTokens + candidatesTokens + thoughtsTokens,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("multi-turn Gemini 4 Hydrogen clean review preserves signatures/ids, emits Engine label, updates ledger, and passes gate", async (t) => {
  const fx = await createSnapshotFixture(t);
  const requests = [];
  let turn = 0;

  const fetcher = async (url, opts) => {
    turn++;
    assert.ok(url.includes(`/models/${GEMINI_REVIEW_MODEL}:generateContent`));
    assert.equal(opts.headers["x-goog-api-key"], fx.fakeApiKey);
    const body = JSON.parse(opts.body);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, GEMINI_REVIEW_THINKING_LEVEL);
    requests.push(body);

    if (turn === 1) {
      return mockGeminiResponse({
        parts: [
          { thought: true, text: "Inspect src/app.js first." },
          { functionCall: { id: "call_1", name: "read_file", args: { path: "src/app.js", start_line: 1, end_line: 10 } }, thoughtSignature: "sig_turn_1" },
        ],
      });
    }
    assert.equal(body.contents.at(-2).parts[1].thoughtSignature, "sig_turn_1");
    assert.equal(body.contents.at(-1).role, "user");
    assert.equal(body.contents.at(-1).parts[0].functionResponse.id, "call_1");
    assert.equal(body.contents.at(-1).parts[0].functionResponse.name, "read_file");
    assert.ok(body.contents.at(-1).parts[0].functionResponse.response.content.includes("2:   if (!user) return true;"));

    return mockGeminiResponse({
      parts: [{
        functionCall: {
          id: "call_2",
          name: "submit_review",
          args: {
            findings: [],
            overall_correctness: "patch is correct",
            overall_explanation: "Verified src/app.js and no blocking issues were identified in this mock clean path.",
            overall_confidence_score: 0.92,
          },
        },
        thoughtSignature: "sig_turn_2",
      }],
    });
  };

  const result = await runGemini({ ...fx, fetcher });
  assert.equal(requests.length, 2);
  assert.equal(result.blocking.length, 0);

  const payload = reviewPayload(fx.snapshot, result, CLEAN_TEXT, { engineLabel: "gemini-4-hydrogen (xhigh)" });
  assert.ok(payload.body.includes("Engine: `gemini-4-hydrogen (xhigh)`"));
  assert.ok(payload.body.includes(CLEAN_TEXT));

  const gateOut = evaluateGate({
    pr: { number: 95, state: "open", draft: false, created_at: "2026-11-21T00:00:00Z", head: { sha: fx.snapshot.head }, base: { sha: fx.snapshot.base, repo: { full_name: fx.snapshot.repo } } },
    reviews: [{
      id: 1,
      user: { login: "connfy-api-reviewer[bot]", id: 357773408, type: "Bot" },
      state: "COMMENTED",
      commit_id: fx.snapshot.head,
      submitted_at: "2026-11-21T00:05:00Z",
      body: payload.body,
    }],
    config: { apiReviewBotLogin: "connfy-api-reviewer[bot]", apiReviewBotId: "357773408" },
  });
  assert.equal(gateOut.state, "success");

  const usage = JSON.parse(await readFile(path.join(fx.artifactDir, "gemini-usage.json"), "utf8"));
  assert.equal(usage.completed, true);
  assert.equal(usage.turns, 2);
  assert.equal(usage.usage.prompt_tokens, 240);
  const ledgerLines = (await readFile(path.join(fx.creditState, "ledger.jsonl"), "utf8")).trim().split("\n");
  assert.equal(ledgerLines.length, 1);
  assert.equal(JSON.parse(ledgerLines[0]).model, GEMINI_REVIEW_MODEL);
});

test("blocking findings verify verbatim evidence_quote on surviving HEAD (RIGHT) and deleted BASE (LEFT) files", async (t) => {
  const fx = await createSnapshotFixture(t);
  let turn = 0;

  const fetcher = async () => {
    turn++;
    if (turn === 1) {
      return mockGeminiResponse({
        parts: [
          { functionCall: { id: "c1", name: "read_file", args: { path: "src/app.js" } } },
          { functionCall: { id: "c2", name: "read_file", args: { path: "src/removed.js", source: "base" } } },
        ],
      });
    }
    return mockGeminiResponse({
      parts: [{
        functionCall: {
          id: "c3",
          name: "submit_review",
          args: {
            findings: [
              {
                title: "[P1] Null user bypasses admin check",
                body: "Returning true when !user grants admin access to unauthenticated callers.",
                priority: 1,
                confidence_score: 0.99,
                file_path: "src/app.js",
                line_start: 2,
                line_end: 2,
                side: "HEAD",
                evidence_quote: "if (!user) return true;",
              },
              {
                title: "[P2] Removed legacy helper still referenced by deployment note",
                body: "legacySecret() was removed in this commit.",
                priority: 2,
                confidence_score: 0.85,
                file_path: "src/removed.js",
                line_start: 1,
                line_end: 3,
                side: "BASE",
                evidence_quote: "return 'legacy-secret-token';",
              },
            ],
            overall_correctness: "patch is incorrect",
            overall_explanation: "Auth bypass introduced in src/app.js.",
            overall_confidence_score: 0.95,
          },
        },
      }],
    });
  };

  const result = await runGemini({ ...fx, fetcher });
  assert.equal(result.blocking.length, 2);
  const payload = reviewPayload(fx.snapshot, result);
  assert.equal(payload.comments.length, 2);
  assert.deepEqual(payload.comments.map((c) => ({ path: c.path, side: c.side, line: c.line })), [
    { path: "src/app.js", side: "RIGHT", line: 2 },
    { path: "src/removed.js", side: "LEFT", line: 1 },
  ]);
  const evidence = JSON.parse(await readFile(path.join(fx.artifactDir, "gemini-evidence.json"), "utf8"));
  assert.equal(evidence.verified_quotes.length, 2);
});

test("hallucination guards reject fabricated files, out-of-range lines, bad quotes, short substring cheats, and zero-inspection submits", async (t) => {
  const fx = await createSnapshotFixture(t);

  // 1. Zero-inspection submit rejected
  const zeroInspect = await verifyGeminiSubmission({
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "Looks good.",
    overall_confidence_score: 0.8,
  }, { checkout: fx.checkout, bare: fx.bare, mergeBase: fx.mergeBase, changedLines: fx.prepared.changedLines, inspectCount: 0 });
  assert.equal(zeroInspect.ok, false);
  assert.match(zeroInspect.errors[0], /inspect/i);

  const baseSub = (findingOverride) => ({
    findings: [{
      title: "[P2] Test finding",
      body: "Concrete issue.",
      priority: 2,
      confidence_score: 0.9,
      file_path: "src/app.js",
      line_start: 2,
      line_end: 2,
      evidence_quote: "if (!user) return true;",
      ...findingOverride,
    }],
    overall_correctness: "patch is incorrect",
    overall_explanation: "Found defect.",
    overall_confidence_score: 0.9,
  });

  // 2. Fabricated file path
  const badPath = await verifyGeminiSubmission(baseSub({ file_path: "src/hallucinated.js" }), {
    checkout: fx.checkout, bare: fx.bare, mergeBase: fx.mergeBase, changedLines: fx.prepared.changedLines, inspectCount: 1,
  });
  assert.equal(badPath.ok, false);

  // 3. Out-of-range line
  const badLines = await verifyGeminiSubmission(baseSub({ line_start: 1, line_end: 999 }), {
    checkout: fx.checkout, bare: fx.bare, mergeBase: fx.mergeBase, changedLines: fx.prepared.changedLines, inspectCount: 1,
  });
  assert.equal(badLines.ok, false);
  assert.match(badLines.errors[0], /exceeds/);

  // 4. Mismatched quote
  const badQuote = await verifyGeminiSubmission(baseSub({ evidence_quote: "return false;" }), {
    checkout: fx.checkout, bare: fx.bare, mergeBase: fx.mergeBase, changedLines: fx.prepared.changedLines, inspectCount: 1,
  });
  assert.equal(badQuote.ok, false);
  assert.match(badQuote.errors[0], /evidence_quote does not match/);

  // 5. Short (<8 chars) quote must match trimmed line, not generic substring
  const shortCheat = await verifyGeminiSubmission(baseSub({ evidence_quote: "true;" }), {
    checkout: fx.checkout, bare: fx.bare, mergeBase: fx.mergeBase, changedLines: fx.prepared.changedLines, inspectCount: 1,
  });
  assert.equal(shortCheat.ok, false);

  // 5b. BASE side rejected on surviving file
  const baseOnSurviving = await verifyGeminiSubmission(baseSub({ side: "BASE", line_start: 1, line_end: 3, evidence_quote: "export function check(user) {" }), {
    checkout: fx.checkout, bare: fx.bare, mergeBase: fx.mergeBase, changedLines: fx.prepared.changedLines, inspectCount: 1,
  });
  assert.equal(baseOnSurviving.ok, false);
  assert.match(baseOnSurviving.errors[0], /only allowed for files deleted in HEAD/);

  // 6. Self-correction retry loop: first submit rejected, model corrects on retry -> succeeds
  let turn = 0;
  const selfCorrectFetcher = async () => {
    turn++;
    if (turn === 1) return mockGeminiResponse({ parts: [{ functionCall: { id: "r1", name: "read_file", args: { path: "src/app.js" } } }] });
    if (turn === 2) return mockGeminiResponse({ parts: [{ functionCall: { id: "s1", name: "submit_review", args: baseSub({ evidence_quote: "wrong quote" }) } }] });
    return mockGeminiResponse({ parts: [{ functionCall: { id: "s2", name: "submit_review", args: baseSub() } }] });
  };
  const corrected = await runGemini({ ...fx, fetcher: selfCorrectFetcher, maxSubmitRetries: 2 });
  assert.equal(corrected.blocking.length, 1);

  // 7. Retries exhausted fails closed and keeps partial ledger
  let failTurn = 0;
  const exhaustedFetcher = async () => {
    failTurn++;
    if (failTurn === 1) return mockGeminiResponse({ parts: [{ functionCall: { id: "r1", name: "read_file", args: { path: "src/app.js" } } }] });
    return mockGeminiResponse({ parts: [{ functionCall: { id: `s${failTurn}`, name: "submit_review", args: baseSub({ evidence_quote: "hallucinated" }) } }] });
  };
  await assert.rejects(
    runGemini({ ...fx, fetcher: exhaustedFetcher, maxSubmitRetries: 1 }),
    /failed verification after 2 attempts/,
  );
  const failedUsage = JSON.parse(await readFile(path.join(fx.artifactDir, "gemini-usage.json"), "utf8"));
  assert.equal(failedUsage.completed, false);
  assert.ok(failedUsage.usage.prompt_tokens > 0);
});

test("read-only tools block path traversal, symlink escapes, binary reads, and grep injection", async (t) => {
  const fx = await createSnapshotFixture(t);
  await symlink(fx.outsideSecret, path.join(fx.checkout, "leak-link.txt"));
  await writeFile(path.join(fx.checkout, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));

  const tools = createReadOnlyTools({
    checkout: fx.checkout,
    bare: fx.bare,
    mergeBase: fx.mergeBase,
    policies: fx.policies,
    diffText: fx.diffText,
    headFiles: ["src/app.js", "src/caller.js", "leak-link.txt", "bin.dat"],
    baseFiles: ["src/app.js", "src/removed.js"],
    policyFiles: ["AGENTS.md"],
  });

  for (const badPath of ["../outside-secret.txt", "/etc/passwd", "src/../../outside-secret.txt", "leak-link.txt", "bin.dat", "does-not-exist.js"]) {
    const out = await tools.dispatch("read_file", { path: badPath });
    assert.equal(out.ok, false, `Expected rejection for ${badPath}`);
  }
  assert.equal(tools.getInspectCount(), 0);

  for (const badPrefix of ["../", ":glob", "-n", "/abs"]) {
    const out = await tools.dispatch("grep_repo", { query: "check", path_prefix: badPrefix });
    assert.equal(out.ok, false, `Expected grep_repo rejection for prefix ${badPrefix}`);
  }

  const diffList = await tools.dispatch("read_diff", {});
  assert.equal(diffList.ok, true);
  assert.equal(tools.getInspectCount(), 0);

  const diffFile = await tools.dispatch("read_diff", { path: "src/app.js" });
  assert.equal(diffFile.ok, true);
  assert.equal(tools.getInspectCount(), 1);

  const grepHit = await tools.dispatch("grep_repo", { query: "if (!user)" });
  assert.equal(grepHit.ok, true);
  assert.equal(grepHit.count, 1);
  assert.match(grepHit.matches[0], /^src\/app\.js:2:/);
  assert.equal(tools.getInspectCount(), 2);
});

test("fail-closed handling for HTTP 429 (redacts key), REVIEW_INCOMPLETE, prose after nudge, zero usage, and missing key file", async (t) => {
  const fx = await createSnapshotFixture(t);

  // HTTP 429 with accidental key echo in upstream body -> redacted everywhere
  await assert.rejects(
    runGemini({
      ...fx,
      fetcher: async () => new Response(JSON.stringify({ error: { message: `Quota exceeded for key ${fx.fakeApiKey}` } }), { status: 429 }),
    }),
    (err) => err.message.includes("HTTP 429") && !err.message.includes(fx.fakeApiKey) && err.message.includes("[REDACTED]"),
  );
  const ledgerRaw = await readFile(path.join(fx.creditState, "ledger.jsonl"), "utf8");
  assert.ok(!ledgerRaw.includes(fx.fakeApiKey));

  // REVIEW_INCOMPLETE fails immediately (not retried)
  let incompleteTurns = 0;
  await assert.rejects(
    runGemini({
      ...fx,
      fetcher: async () => {
        incompleteTurns++;
        if (incompleteTurns === 1) return mockGeminiResponse({ parts: [{ functionCall: { id: "r1", name: "read_file", args: { path: "src/app.js" } } }] });
        return mockGeminiResponse({
          parts: [{
            functionCall: {
              id: "s1",
              name: "submit_review",
              args: {
                findings: [],
                overall_correctness: "patch is correct",
                overall_explanation: "REVIEW_INCOMPLETE: binary dependency unverifiable",
                overall_confidence_score: 0.1,
              },
            },
          }],
        });
      },
    }),
    /REVIEW_INCOMPLETE/,
  );
  assert.equal(incompleteTurns, 2);

  // Prose-only replies fail after 1 nudge
  let proseTurns = 0;
  await assert.rejects(
    runGemini({
      ...fx,
      fetcher: async () => {
        proseTurns++;
        return mockGeminiResponse({ parts: [{ text: "LGTM!" }] });
      },
    }),
    /prose nudge/,
  );
  assert.equal(proseTurns, 2);

  // Zero usageMetadata fails closed
  await assert.rejects(
    runGemini({
      ...fx,
      fetcher: async () => mockGeminiResponse({ parts: [{ text: "ok" }], promptTokens: 0, candidatesTokens: 0, thoughtsTokens: 0 }),
    }),
    /zero Gemini usageMetadata/i,
  );

  // Missing key file fails closed
  await assert.rejects(
    runGemini({ ...fx, keyFile: path.join(fx.root, "missing-key.txt"), fetcher: async () => assert.fail("should not fetch") }),
    /ENOENT/,
  );
});
