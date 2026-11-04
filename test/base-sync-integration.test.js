import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateGate, resolveConfig } from "../src/gate.js";
import { collectBaseSyncEvidence } from "../src/base-sync-github.js";
import { evaluateFromGitHub, reportStatus } from "../src/index.js";
import { RepoClient } from "../src/github.js";
import { baseSyncFixture, baseSyncTestHelpers } from "./fixtures/base-sync-synthetic.js";
import { reviewBot, reviewStateComment } from "./fixtures/review-state.js";

const bot = reviewBot;
const clean = "Codex Review: Didn't find any major issues.";
const time = (minute) => `2026-08-02T00:${String(minute).padStart(2, "0")}:00Z`;

function fixture(evidence = baseSyncFixture()) {
  Object.assign(evidence, {
    baseRef: "main", baseRepository: "connfy/example",
  });
  const heads = [];
  let cursor = evidence.headSha;
  while (cursor !== evidence.reviewedSha) {
    heads.unshift(cursor);
    cursor = evidence.commits[cursor].parents[0].sha;
  }
  const inputs = {
    pr: {
      number: 123, state: "open", draft: false, created_at: time(0),
      head: { sha: evidence.headSha },
      base: {
        sha: evidence.integratedBaseSha ?? evidence.commits[evidence.headSha].parents[1].sha,
        ref: evidence.baseRef, repo: { full_name: evidence.baseRepository },
      },
    },
    reviews: [{
      id: 1, user: bot, state: "COMMENTED", body: clean,
      commit_id: evidence.reviewedSha, submitted_at: time(2),
      html_url: "https://github.com/connfy/example/pull/123#pullrequestreview-1",
    }],
    timelineEvents: [evidence.reviewedSha, ...heads].map((sha, index) => ({
      event: "committed", sha, committer: { date: time(index === 0 ? 1 : index + 2) },
    })),
    issueComments: [], issueReactions: [], issueEyesReactions: [],
    reviewThreads: [], reviewRequestReactions: [],
    config: resolveConfig({ baseSyncEnabled: true }), now: Date.parse(time(10)),
    baseSyncEvidence: evidence,
  };
  return { evidence, inputs };
}

function clientFor(inputs, evidence) {
  const calls = [];
  const read = (kind, key, values) => {
    calls.push([kind, key]);
    if (!Object.hasOwn(values, key)) throw new Error(`Missing recorded ${kind}: ${key}`);
    return structuredClone(values[key]);
  };
  return {
    owner: "connfy", repo: "example", calls,
    pullRequest: async () => structuredClone(inputs.pr),
    issueComments: async () => structuredClone(inputs.issueComments),
    issueReactions: async (_number, content) =>
      structuredClone(content === "+1" ? inputs.issueReactions : inputs.issueEyesReactions),
    reviews: async () => structuredClone(inputs.reviews),
    reviewThreads: async () => structuredClone(inputs.reviewThreads),
    timelineEvents: async () => structuredClone(inputs.timelineEvents),
    issueCommentReactions: async () => [],
    branchRef: async (ref) => {
      calls.push(["ref", ref]);
      return { object: { type: "commit", sha: evidence.liveBaseSha } };
    },
    gitCommit: async (sha) => read("commit", sha, evidence.commits),
    gitTree: async (sha) => read("tree", sha, evidence.trees),
    compareCommits: async (base, head) => read("compare", `${base}...${head}`, evidence.comparisons),

  };
}

function request(id, minute) {
  return { id, user: { login: "human" }, body: "@codex review", created_at: time(minute) };
}

test("verified base sync carries an actual bound clean review and names original R and M", () => {
  const { inputs, evidence } = fixture();
  const result = evaluateGate(inputs);
  assert.equal(result.state, "success");
  assert.equal(result.baseSync.reviewedSha, evidence.reviewedSha);
  assert.equal(result.baseSync.liveBaseSha, evidence.liveBaseSha);
  assert.equal(result.targetUrl, inputs.reviews[0].html_url);
  assert.equal(result.description,
    `Review gate passed: base sync of reviewed head ${evidence.reviewedSha} onto ${inputs.pr.base.sha}.`);
  assert.ok(result.description.length <= 140);
  assert.ok(result.details[0].includes(evidence.headSha));
});

test("two syncs use the original reviewed R instead of trusting the intermediate success", async () => {
  const { inputs, evidence } = fixture(baseSyncTestHelpers.twoSyncs());
  const client = clientFor(inputs, evidence);
  const result = await evaluateFromGitHub(client, { prNumber: inputs.pr.number }, inputs.config);
  assert.equal(result.state, "success");
  assert.equal(result.baseSync.reviewedSha, evidence.reviewedSha);
  assert.ok(result.description.includes(evidence.reviewedSha.slice(0, 12)));
  const bases = [baseSyncTestHelpers.M, baseSyncTestHelpers.M2];
  for (const base of bases) {
    assert.ok(client.calls.some(([kind, key]) => kind === "compare" && key === `${base}...${evidence.reviewedSha}`));
  }
});

test("a directly reviewed new head keeps the ordinary success and needs no Git reads", async () => {
  const { inputs, evidence } = fixture();
  inputs.reviews[0].commit_id = evidence.headSha;
  const client = clientFor(inputs, evidence);
  const result = await evaluateFromGitHub(client, { prNumber: 123 }, inputs.config);
  assert.equal(result.description, "Review gate passed.");
  assert.equal(result.baseSync, undefined);
  assert.deepEqual(client.calls, []);
});

test("base-sync carry is disabled by default and makes no graph reads while off", async () => {
  const { inputs, evidence } = fixture();
  inputs.config = resolveConfig();
  assert.equal(inputs.config.baseSyncEnabled, false);
  assert.equal(evaluateGate(inputs).state, "failure");
  const client = clientFor(inputs, evidence);
  assert.equal((await evaluateFromGitHub(client, { prNumber: 123 }, inputs.config)).state, "failure");
  assert.deepEqual(client.calls, []);
  assert.equal(resolveConfig({ baseSyncEnabled: "true" }).baseSyncEnabled, false);
});

test("collector rejects a backward base sync that would discard an earlier base change", async (context) => {
  context.mock.method(console, "warn", () => {});
  const { inputs, evidence } = fixture(baseSyncTestHelpers.backwardSyncs());
  const client = clientFor(inputs, evidence);
  const result = await evaluateFromGitHub(client, { prNumber: 123 }, inputs.config);
  assert.equal(result.state, "failure");
  assert.match(result.baseSyncFailure, /moves backward or diverges/);
});

test("known non-clean and running intermediate Code Review states still block a later sync", async (context) => {
  for (const status of ["completed", "running"]) {
    await context.test(status, () => {
      const { inputs } = fixture(baseSyncTestHelpers.twoSyncs());
      const board = reviewStateComment(baseSyncTestHelpers.S, "2026-08-02T00:03:30Z");
      board.body = status === "completed"
        ? board.body.replace('"has_any_findings":false', '"has_any_findings":true')
        : board.body.replace('"status":"completed"', '"status":"running"')
          .replace('✅ **Completed**', '🔄 **Running** since');
      inputs.issueComments.push(board);
      assert.equal(evaluateGate(inputs).state, "failure");
    });
  }
});

test("settled disposition and reaction-only authority do not carry", async (context) => {
  for (const kind of ["settlement", "reaction", "unbound comment", "dismissed review"]) {
    await context.test(kind, async () => {
      const { inputs, evidence } = fixture();
      if (kind === "dismissed review") inputs.reviews[0].state = "DISMISSED";
      else inputs.reviews = [];
      if (kind === "settlement") {
        inputs.config = resolveConfig({ settledDispositionLogins: ["human"], baseSyncEnabled: true });
        inputs.issueComments = [{
          id: 2, user: { login: "human", type: "User" }, created_at: time(2),
          body: `@review-gate settle ${evidence.reviewedSha} ${inputs.pr.base.sha}`,
          html_url: "https://github.com/connfy/example/pull/123#issuecomment-2",
        }];
      }
      if (kind === "reaction") inputs.issueReactions = [{ user: bot, content: "+1", created_at: time(2) }];
      if (kind === "unbound comment") inputs.issueComments = [{
        id: 2, user: bot, body: clean, created_at: time(2),
        html_url: "https://github.com/connfy/example/pull/123#issuecomment-2",
      }];
      const client = clientFor(inputs, evidence);
      const result = await evaluateFromGitHub(client, { prNumber: 123 }, inputs.config);
      assert.notEqual(result.state, "success");
      assert.deepEqual(client.calls, []);
    });
  }
});

test("drafts, unresolved threads, current requested reviews, and ongoing reviews block carry", async (context) => {
  for (const blocker of ["draft", "thread", "request", "eyes"]) {
    await context.test(blocker, () => {
      const { inputs } = fixture();
      if (blocker === "draft") inputs.pr.draft = true;
      if (blocker === "thread") inputs.reviewThreads = [{ isResolved: false, isOutdated: false }];
      if (blocker === "request") {
        const value = request(2, 4);
        inputs.issueComments.push(value);
        inputs.timelineEvents.push({ event: "commented", ...value });
      }
      if (blocker === "eyes") inputs.issueEyesReactions.push({ user: bot, content: "eyes", created_at: time(4) });
      const result = evaluateGate(inputs);
      assert.equal(result.state, ["request", "eyes"].includes(blocker) ? "pending" : "failure");
      assert.equal(result.baseSync, undefined);
    });
  }
});

test("an intermediate-head review request or eyes cannot disappear behind the next sync", async (context) => {
  for (const blocker of ["request", "eyes", "findings"]) {
    await context.test(blocker, () => {
      const { inputs } = fixture(baseSyncTestHelpers.twoSyncs());
      if (blocker === "request") {
        const value = { ...request(2, 3), created_at: "2026-08-02T00:03:30Z" };
        inputs.issueComments.push(value);
        inputs.timelineEvents.splice(2, 0, { event: "commented", ...value });
      }
      if (blocker === "eyes") inputs.issueEyesReactions.push({ user: bot, content: "eyes", created_at: "2026-08-02T00:03:30Z" });
      if (blocker === "findings") inputs.reviews.push({
        id: 2, user: bot, state: "COMMENTED", commit_id: baseSyncTestHelpers.S,
        submitted_at: "2026-08-02T00:03:30Z", body: "A new finding remains.",
      });
      const result = evaluateGate(inputs);
      assert.equal(result.state, "failure");
      assert.match(result.baseSyncFailure, /no uninvalidated/);
    });
  }
});

test("a request completed on R before the sync does not force a duplicate review", () => {
  const { inputs } = fixture();
  const value = { ...request(2, 1), created_at: "2026-08-02T00:01:30Z" };
  inputs.issueComments.push(value);
  inputs.timelineEvents.splice(1, 0, { event: "commented", ...value });
  inputs.reviewRequestReactions = [{ comment: value, reactions: [{
    user: bot, content: "eyes", created_at: "2026-08-02T00:01:45Z",
  }] }];
  assert.equal(evaluateGate(inputs).state, "success");
});

test("newer findings, ambiguous response order, force pushes, and missing timeline proof refuse carry", async (context) => {
  for (const blocker of ["findings", "equal-time response", "force push", "missing head", "unmatched request"]) {
    await context.test(blocker, () => {
      const { inputs } = fixture();
      if (blocker === "findings" || blocker === "equal-time response") inputs.reviews.push({
        id: 2, user: bot, state: "COMMENTED", commit_id: inputs.baseSyncEvidence.reviewedSha,
        submitted_at: time(blocker === "findings" ? 4 : 2), body: "A new finding.",
      });
      if (blocker === "force push") inputs.timelineEvents.push({ event: "head_ref_force_pushed", created_at: time(4) });
      if (blocker === "missing head") inputs.timelineEvents.shift();
      if (blocker === "unmatched request") inputs.issueComments.push(request(2, 1));
      assert.notEqual(evaluateGate(inputs).state, "success");
    });
  }
});

test("a metadata-bound abbreviated receipt carries its original full reviewed head without ref lookup", async () => {
  const { inputs, evidence } = fixture();
  const prefix = evidence.reviewedSha.slice(0, 12);
  inputs.reviews = [];
  const receipt = {
    id: 2, user: bot, body: `${clean}\n**Reviewed commit:** \`${prefix}\``,
    created_at: time(2), html_url: "https://github.com/connfy/example/pull/123#issuecomment-2",
  };
  inputs.issueComments = [receipt, reviewStateComment(evidence.reviewedSha, time(2))];
  inputs.timelineEvents.splice(1, 0, { event: "commented", ...receipt });
  const client = clientFor(inputs, evidence);
  client.resolveReviewedCommit = () => { throw new Error("Mutable ref lookup must never run"); };
  const result = await evaluateFromGitHub(client, { prNumber: 123 }, inputs.config);
  assert.equal(result.state, "success");
  assert.equal(result.baseSync.reviewedSha, evidence.reviewedSha);
});

test("a metadata-bound PR reaction can carry a completed clean review but the board alone cannot", () => {
  const { inputs, evidence } = fixture();
  inputs.reviews = [];
  inputs.issueComments = [reviewStateComment(evidence.reviewedSha, time(2))];
  assert.equal(evaluateGate(inputs).state, "failure");
  inputs.issueReactions = [{ id: 3, user: bot, content: "+1", created_at: time(2) }];
  assert.equal(evaluateGate(inputs).state, "success");
});

test("an edited clean receipt cannot erase a force push after its original review", () => {
  const { inputs, evidence } = fixture();
  inputs.reviews = [];
  const comment = {
    id: 2, user: bot, body: `${clean}\n**Reviewed commit:** \`${evidence.reviewedSha}\``,
    created_at: time(2), updated_at: time(5),
    html_url: "https://github.com/connfy/example/pull/123#issuecomment-2",
  };
  inputs.issueComments.push(comment);
  inputs.timelineEvents.splice(1, 0, { event: "commented", ...comment });
  inputs.timelineEvents.splice(2, 0, { event: "head_ref_force_pushed", created_at: time(3) });
  assert.equal(evaluateGate(inputs).state, "failure");
});

test("carry requires a Bot identity and consistent comment/timeline response evidence", async (context) => {
  for (const problem of ["human alias", "timeline-only finding", "comment-only finding", "different comment versions"]) {
    await context.test(problem, () => {
      const { inputs } = fixture();
      if (problem === "human alias") inputs.reviews[0].user = { ...bot, type: "User" };
      else {
        const value = { id: 2, user: bot, body: "A new finding.", created_at: time(4) };
        if (problem !== "timeline-only finding") inputs.issueComments.push(value);
        if (problem !== "comment-only finding") inputs.timelineEvents.push({
          event: "commented", ...value,
          ...(problem === "different comment versions" ? { body: "A different finding." } : {}),
        });
      }
      assert.equal(evaluateGate(inputs).state, "failure");
    });
  }
});

test("API errors, truncated trees and patches fail closed", async (context) => {
  for (const failure of ["compare", "tree", "patch"]) {
    await context.test(failure, async (item) => {
      const warnings = [];
      item.mock.method(console, "warn", (...args) => warnings.push(args));
      const { inputs, evidence } = fixture();
      const client = clientFor(inputs, evidence);
      if (failure === "compare") client.compareCommits = async () => { throw new Error("GitHub 403 rate limit"); };
      if (failure === "tree") Object.values(evidence.trees)[0].truncated = true;
      if (failure === "patch") {
        const key = `${evidence.commits[evidence.headSha].parents[1].sha}...${evidence.headSha}`;
        evidence.comparisons[key].files[0].patch = "@@ -1 +1 @@\n-old";
      }
      const result = await evaluateFromGitHub(client, { prNumber: 123 }, inputs.config);
      assert.equal(result.state, "failure");
      assert.ok(result.baseSyncFailure);
      assert.ok(warnings.length > 0);
    });
  }
});

test("collector reads live L rather than the PR snapshot and deduplicates immutable object reads", async () => {
  const { inputs, evidence } = fixture();
  const client = clientFor(inputs, evidence);
  const collected = await collectBaseSyncEvidence(client, inputs);
  assert.equal(collected.liveBaseSha, evidence.liveBaseSha);
  assert.notEqual(collected.liveBaseSha, inputs.pr.base.sha);
  assert.ok(collected.commits[evidence.liveBaseSha]);
  const immutable = client.calls.filter(([kind]) => kind === "commit" || kind === "tree" || kind === "compare");
  assert.equal(new Set(immutable.map((value) => value.join(":"))).size, immutable.length);
});

test("new authored commits, rebase heads and unrelated second parents use the ordinary rule", async (context) => {
  for (const shape of ["new authored commit", "rebase", "off-base"]) {
    await context.test(shape, async (item) => {
      item.mock.method(console, "warn", () => {});
      const { inputs, evidence } = fixture();
      const parents = evidence.commits[evidence.headSha].parents;
      if (shape === "new authored commit" || shape === "rebase") parents.pop();
      if (shape === "off-base") evidence.comparisons[`${parents[1].sha}...${evidence.liveBaseSha}`] = {
        ...evidence.comparisons[`${parents[1].sha}...${evidence.liveBaseSha}`], status: "diverged",
        merge_base_commit: { sha: baseSyncTestHelpers.B },
      };
      const result = await evaluateFromGitHub(clientFor(inputs, evidence), { prNumber: 123 }, inputs.config);
      assert.equal(result.state, "failure");
    });
  }
});

test("carried publication rechecks head, snapshot, live base tip, draft and base identity", async (context) => {
  for (const changed of ["none", "head", "snapshot", "tip", "draft", "base ref", "base repository", "closed", "API error"]) {
    await context.test(changed, async (item) => {
      item.mock.method(console, "warn", () => {});
      const { inputs, evidence } = fixture();
      const result = evaluateGate(inputs);
      assert.equal(result.state, "success");
      const client = clientFor(inputs, evidence);
      const written = [];
      client.setStatus = async (sha, status) => written.push({ sha, status });
      if (changed === "head") inputs.pr.head.sha = baseSyncTestHelpers.B;
      if (changed === "snapshot") inputs.pr.base.sha = baseSyncTestHelpers.B;
      if (changed === "tip") client.branchRef = async () => ({ object: { type: "commit", sha: baseSyncTestHelpers.B } });
      if (changed === "draft") inputs.pr.draft = true;
      if (changed === "base ref") inputs.pr.base.ref = "other";
      if (changed === "base repository") inputs.pr.base.repo.full_name = "connfy/other";
      if (changed === "closed") inputs.pr.state = "closed";
      if (changed === "API error") client.branchRef = async () => { throw new Error("GitHub unavailable"); };
      assert.equal(await reportStatus(client, result), ["none", "closed"].includes(changed));
      if (changed === "head") assert.deepEqual(written, []);
      else assert.equal(written[0].status.state, ["none", "closed"].includes(changed) ? "success" : "failure");
    });
  }
});

test("GitHub object reads use fixed SHA endpoints, page-one file evidence and encoded refs", async (context) => {
  const requests = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), method: options.method });
    return Response.json({});
  });
  const api = new RepoClient("test-token", "connfy", "example", "review-gate/codex-clean");
  const { reviewedSha: r, headSha: n } = baseSyncFixture();
  await api.branchRef("release/next");
  await api.gitCommit(n);
  await api.gitTree(n);
  await api.compareCommits(r, n);
  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
    "/repos/connfy/example/git/ref/heads/release%2Fnext",
    `/repos/connfy/example/git/commits/${n}`,
    `/repos/connfy/example/git/trees/${n}`,
    `/repos/connfy/example/compare/${r}...${n}`,
  ]);
  assert.equal(new URL(requests[2].url).search, "?recursive=1");
  assert.equal(new URL(requests[3].url).search, "?per_page=100&page=1");
  assert.ok(requests.every(({ method }) => method === "GET"));
});


test("closing the PR preserves verified immutable review coverage", async () => {
  const { inputs, evidence } = fixture();
  inputs.pr.state = "closed";
  const client = clientFor(inputs,evidence);
  const result = await evaluateFromGitHub(client,{prNumber:123},inputs.config);
  assert.equal(result.state,"success");
  assert.equal(result.prState,"closed");
  assert.equal(result.baseSync.reviewedSha,evidence.reviewedSha);
});

test("late results explicitly targeting heads outside the covered chain cannot retract coverage", async (context) => {
  for (const kind of ["formal", "comment", "state"]) {
    await context.test(kind, async () => {
      const { inputs, evidence } = fixture(baseSyncTestHelpers.twoSyncs());
      const olderHead = "a".repeat(40);
      if (kind === "formal") inputs.reviews.push({
        id: 11, user: bot, commit_id: olderHead, submitted_at: time(5), state: "COMMENTED", body: "Old-head findings.",
      });
      if (kind === "comment") inputs.issueComments.push({
        id: 11, user: bot, created_at: time(5), body: `Old-head findings.\n**Reviewed commit:** \`${olderHead}\``,
      });
      if (kind === "state") {
        const board = reviewStateComment(olderHead, time(5));
        board.body = board.body.replace('"has_any_findings":false', '"has_any_findings":true');
        inputs.issueComments.push(board);
      }
      const result = await evaluateFromGitHub(clientFor(inputs, evidence), { prNumber: 123 }, inputs.config);
      assert.equal(result.state, "success");
      assert.equal(result.baseSync.reviewedSha, evidence.reviewedSha);
    });
  }
});

test("an old clean reaction can still carry its reviewed head after the pending window", async () => {
  const { inputs, evidence } = fixture();
  inputs.reviews = [];
  const board = reviewStateComment(evidence.reviewedSha, time(2));
  inputs.issueComments = [board];
  inputs.issueReactions = [{ id: 8, user: bot, content: "+1", created_at: time(2) }];
  inputs.now = Date.parse("2026-08-05T00:00:00Z");
  const result = await evaluateFromGitHub(clientFor(inputs, evidence), { prNumber: 123 }, inputs.config);
  assert.equal(result.state, "success");
  assert.equal(result.baseSync.reviewedSha, evidence.reviewedSha);
});

test("review inputs are refreshed after graph collection before using its proof", async (context) => {
  for (const change of ["draft", "thread", "request", "findings"]) {
    await context.test(change, async () => {
      const { inputs, evidence } = fixture();
      const client = clientFor(inputs, evidence);
      const readTree = client.gitTree;
      client.gitTree = async (sha) => {
        const result = await readTree(sha);
        if (change === "draft") inputs.pr.draft = true;
        if (change === "thread") inputs.reviewThreads = [{ isResolved: false, isOutdated: false }];
        if (change === "request" && inputs.issueComments.length === 0) {
          const value = request(8, 4);
          inputs.issueComments.push(value);
          inputs.timelineEvents.push({ event: "commented", ...value });
        }
        if (change === "findings") inputs.reviews.push({
          id: 8, user: bot, state: "COMMENTED", commit_id: evidence.headSha,
          submitted_at: time(4), body: "New findings on the merge head.",
        });
        return result;
      };
      const result = await evaluateFromGitHub(client, { prNumber: 123 }, inputs.config);
      assert.notEqual(result.state, "success");
      assert.equal(result.baseSync, undefined);
    });
  }
});

test("raw truthy configuration and missing timeline evidence make no graph reads", async (context) => {
  for (const setting of ["true", "false", 1, {}, null]) {
    await context.test(String(setting), async () => {
      const { inputs, evidence } = fixture();
      inputs.config = { baseSyncEnabled: setting };
      const client = clientFor(inputs, evidence);
      assert.equal((await evaluateFromGitHub(client, { prNumber: 123 }, inputs.config)).state, "failure");
      assert.equal(await collectBaseSyncEvidence(client, inputs), null);
      assert.deepEqual(client.calls, []);
    });
  }
  const { inputs, evidence } = fixture();
  inputs.timelineEvents = [];
  const client = clientFor(inputs, evidence);
  assert.equal(await collectBaseSyncEvidence(client, inputs), null);
  assert.deepEqual(client.calls, []);
});

test("fixed object endpoints reject mutable names and abbreviated IDs before making requests", async (context) => {
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Must not make a request"); });
  const api = new RepoClient("test-token", "connfy", "example", "review-gate/codex-clean");
  const sha = baseSyncFixture().headSha;
  for (const invalid of ["main", sha.slice(0, 10), sha.toUpperCase(), null]) {
    assert.throws(() => api.gitCommit(invalid), /full lowercase 40-character object SHA/);
    assert.throws(() => api.gitTree(invalid), /full lowercase 40-character object SHA/);
    assert.throws(() => api.compareCommits(invalid, sha), /full lowercase 40-character object SHA/);
    assert.throws(() => api.compareCommits(sha, invalid), /full lowercase 40-character object SHA/);
  }
});
