import assert from "node:assert/strict";
import { test } from "node:test";

import {
  latestReviewRequestComments,
  maybeRetryIssueComment,
  maybeRetryReviewStart,
  reviewEvidenceChangedResult,
  runScheduledSweep,
  shouldReportStatus,
  sweepOpenPullRequests,
  sweepPendingPullRequests,
} from "../src/index.js";
import { pendingReviewKey } from "../src/pending.js";

test("review-start retry observes a later PR body clean reaction after bounded pending rechecks", async () => {
  const sleeps = [];
  const reports = [];
  const evaluations = [
    {
      sha: "abc123",
      state: "pending",
      description: "Review bot is reviewing the latest head.",
    },
    {
      sha: "abc123",
      state: "success",
      description: "Review gate passed.",
    },
  ];

  const result = await maybeRetryReviewStart({
    result: {
      sha: "abc123",
      state: "failure",
      description: "No clean review pass after the latest head update.",
    },
    retryOnReviewStart: true,
    evaluate: async () => evaluations.shift(),
    report: async (retryResult) => {
      reports.push(retryResult.state);
    },
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
    },
    reviewStartRetryDelayMs: 15_000,
    reviewPendingRetryIntervalMs: 7_000,
    reviewPendingRetryAttempts: 2,
  });

  assert.deepEqual(sleeps, [15_000, 7_000]);
  assert.deepEqual(reports, ["pending", "success"]);
  assert.equal(result.state, "success");
});

test("latest request reaction selection uses edited request time", () => {
  const comments = [
    {
      id: 10,
      user: { login: "reviewer" },
      body: "@codex review",
      created_at: "2026-08-02T00:03:00Z",
      updated_at: "2026-08-02T00:03:00Z",
    },
    {
      id: 9,
      user: { login: "reviewer" },
      body: "@codex review",
      created_at: "2026-08-02T00:01:00Z",
      updated_at: "2026-08-02T00:04:00Z",
    },
  ];

  assert.deepEqual(
    latestReviewRequestComments(comments, {
      botLogins: new Set(["chatgpt-codex-connector[bot]"]),
      reviewRequestText: "@codex review",
    }).map((comment) => comment.id),
    [9],
  );
});

test("disposition creation retries after GitHub API lag", async () => {
  const sleeps = [];
  const result = await maybeRetryIssueComment({
    result: {
      sha: "abc123",
      state: "failure",
      description: "No clean review pass after the latest head update.",
    },
    retryOnDispositionMutation: true,
    evaluate: async () => ({
      sha: "abc123",
      state: "success",
      description: "Settled by @connfy for abc123.",
    }),
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
    },
  });

  assert.deepEqual(sleeps, [3_000]);
  assert.equal(result.state, "success");
});

test("disposition edit retries even when stale APIs still report success", async () => {
  const sleeps = [];
  const result = await maybeRetryIssueComment({
    result: {
      sha: "abc123",
      state: "success",
      description: "Settled by @connfy for abc123.",
    },
    retryOnDispositionMutation: true,
    evaluate: async () => ({
      sha: "abc123",
      state: "failure",
      description: "No clean review pass after the latest head update.",
    }),
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
    },
  });

  assert.deepEqual(sleeps, [3_000]);
  assert.equal(result.state, "failure");
});

test("clean-comment retry preserves its existing success fast path", async () => {
  const result = await maybeRetryIssueComment({
    result: {
      sha: "abc123",
      state: "success",
      description: "Review gate passed.",
    },
    retryOnCleanComment: true,
    retryOnDispositionMutation: false,
    evaluate: async () => {
      throw new Error("unexpected retry");
    },
  });

  assert.equal(result.state, "success");
});

test("review evidence mutation forces an auditable failure result", () => {
  assert.deepEqual(
    reviewEvidenceChangedResult(
      {
        sha: "abc123",
        state: "success",
        description: "Settled by @connfy for abc123.",
        details: ["old disposition"],
        targetUrl: "https://github.com/old",
      },
      "https://github.com/mutation",
    ),
    {
      sha: "abc123",
      state: "failure",
      description:
        "Review evidence changed; a new exact-head disposition is required.",
      details: [
        "Review evidence changed; a new exact-head disposition is required.",
      ],
      targetUrl: "https://github.com/mutation",
    },
  );
});

test("review-start retry keeps pending after bounded pending rechecks", async () => {
  const sleeps = [];
  const reports = [];
  const result = await maybeRetryReviewStart({
    result: {
      sha: "abc123",
      state: "pending",
      description: "Review bot is reviewing the latest head.",
    },
    retryOnReviewStart: true,
    evaluate: async () => ({
      sha: "abc123",
      state: "pending",
      description: "Review bot is reviewing the latest head.",
    }),
    report: async (retryResult) => {
      reports.push(retryResult.state);
    },
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
    },
    reviewPendingRetryIntervalMs: 7_000,
    reviewPendingRetryAttempts: 2,
  });

  assert.deepEqual(sleeps, [7_000, 7_000]);
  assert.deepEqual(reports, []);
  assert.equal(result.state, "pending");
});

test("review-start retry does not poll pending reviews by default", async () => {
  const sleeps = [];
  const reports = [];
  const result = await maybeRetryReviewStart({
    result: {
      sha: "abc123",
      state: "pending",
      description: "Review bot is reviewing the latest head.",
    },
    retryOnReviewStart: true,
    evaluate: async () => {
      throw new Error("unexpected retry");
    },
    report: async (retryResult) => {
      reports.push(retryResult.state);
    },
    sleepFn: async (delayMs) => {
      sleeps.push(delayMs);
    },
  });

  assert.deepEqual(sleeps, []);
  assert.deepEqual(reports, []);
  assert.equal(result.state, "pending");
});

test("review-start retry ignores stale retry results for an old head", async () => {
  const reports = [];
  const result = await maybeRetryReviewStart({
    result: {
      sha: "new-head",
      state: "pending",
      description: "Review bot is reviewing the latest head.",
    },
    retryOnReviewStart: true,
    evaluate: async () => ({
      sha: "old-head",
      state: "success",
      description: "Review gate passed.",
    }),
    report: async (retryResult) => {
      reports.push(retryResult.state);
    },
    sleepFn: async () => {},
    reviewPendingRetryIntervalMs: 7_000,
    reviewPendingRetryAttempts: 2,
  });

  assert.deepEqual(reports, []);
  assert.equal(result.state, "pending");
});

test("scheduled sweep status reporting only writes meaningful changes", () => {
  assert.equal(
    shouldReportStatus(null, {
      state: "success",
      description: "Review gate passed.",
    }),
    true,
  );
  assert.equal(
    shouldReportStatus(
      { state: "pending", description: "Review bot is reviewing the latest head." },
      { state: "success", description: "Review gate passed." },
    ),
    true,
  );
  assert.equal(
    shouldReportStatus(
      { state: "success", description: "Review gate passed." },
      { state: "success", description: "Review gate passed." },
    ),
    false,
  );
});

test("scheduled sweep rewrites a success status when the disposition audit description changes", () => {
  assert.equal(
    shouldReportStatus(
      { state: "success", description: "Review gate passed." },
      {
        state: "success",
        description: "Settled by @connfy for abc123abc123.",
      },
    ),
    true,
  );
});

test("scheduled sweep rewrites a settled status when its audit link changes", () => {
  assert.equal(
    shouldReportStatus(
      {
        state: "success",
        description: "Settled by @connfy for abc123abc123.",
        target_url: "https://github.com/connfy/example/pull/1#issuecomment-old",
      },
      {
        state: "success",
        description: "Settled by @connfy for abc123abc123.",
        targetUrl: "https://github.com/connfy/example/pull/1#issuecomment-new",
      },
    ),
    true,
  );
  assert.equal(
    shouldReportStatus(
      {
        state: "success",
        description: "Settled by @connfy for abc123abc123.",
        target_url: "https://github.com/connfy/example/pull/1#issuecomment-new",
      },
      {
        state: "success",
        description: "Settled by @connfy for abc123abc123.",
        targetUrl: "https://github.com/connfy/example/pull/1#issuecomment-new",
      },
    ),
    false,
  );
});

test("scheduled pending sweep evaluates a queued PR and removes a terminal result", async () => {
  const ref = {
    installationId: 42,
    owner: "connfy",
    repo: "aimstrings-web",
    prNumber: 245,
    sha: "abc123",
  };
  const key = pendingReviewKey(ref);
  const deleted = [];
  const reports = [];
  const namespace = {
    async list() {
      return {
        keys: [{ name: key, metadata: ref }],
        list_complete: true,
      };
    },
    async put() {
      throw new Error("unexpected put");
    },
    async delete(deletedKey) {
      deleted.push(deletedKey);
    },
  };

  const summary = await sweepPendingPullRequests(
    {
      PENDING_REVIEWS: namespace,
      GITHUB_APP_ID: "app-id",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    },
    { statusContext: "review-gate/codex-clean" },
    {
      maxPullRequests: 2,
      rotationSeed: 0,
      getInstallationToken: async (_appId, _privateKey, installationId) => {
        assert.equal(installationId, 42);
        return "installation-token";
      },
      clientFactory: (token, owner, repo) => {
        assert.equal(token, "installation-token");
        assert.equal(`${owner}/${repo}`, "connfy/aimstrings-web");
        return {
          async latestStatusForContext() {
            return {
              state: "pending",
              description: "Review bot is reviewing the latest head.",
            };
          },
        };
      },
      evaluate: async (_client, evaluationRef) => {
        assert.deepEqual(evaluationRef, { prNumber: 245 });
        return {
          sha: "abc123",
          state: "success",
          description: "Review gate passed.",
        };
      },
      reportStatus: async (_client, result) => {
        reports.push(result.state);
      },
    },
  );

  assert.deepEqual(reports, ["success"]);
  assert.deepEqual(deleted, [key]);
  assert.equal(summary.pullRequests, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.removed, 1);
  assert.deepEqual(summary.processedRefs, ["connfy/aimstrings-web#245"]);
});

test("scheduled pending sweep leaves failed queued PRs eligible for fallback", async () => {
  const ref = {
    installationId: 42,
    owner: "connfy",
    repo: "aimstrings-web",
    prNumber: 245,
    sha: "abc123",
  };
  const namespace = {
    async list() {
      return {
        keys: [{ name: pendingReviewKey(ref), metadata: ref }],
        list_complete: true,
      };
    },
  };

  const summary = await sweepPendingPullRequests(
    {
      PENDING_REVIEWS: namespace,
      GITHUB_APP_ID: "app-id",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    },
    { statusContext: "review-gate/codex-clean" },
    {
      maxPullRequests: 2,
      rotationSeed: 0,
      getInstallationToken: async () => {
        throw new Error("stale installation");
      },
    },
  );

  assert.equal(summary.pullRequests, 1);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.processedRefs, []);
});

test("scheduled orchestration keeps separate pending and fallback budgets", async () => {
  const calls = [];
  const summary = await runScheduledSweep(
    { SWEEP_MAX_PULL_REQUESTS: "3" },
    { statusContext: "review-gate/codex-clean" },
    {
      rotationSeed: 17,
      pendingSweep: async (_env, _config, options) => {
        calls.push(["pending", options.maxPullRequests, options.rotationSeed]);
        return {
          enabled: true,
          queued: 2,
          pullRequests: 2,
          updated: 1,
          unchanged: 1,
          removed: 1,
          requeued: 0,
          errors: 0,
          limited: false,
          processedRefs: ["connfy/aimstrings-web#245", "connfy/review-gate#4"],
        };
      },
      openSweep: async (_env, _config, options) => {
        calls.push([
          "open",
          options.maxPullRequests,
          options.rotationSeed,
          [...options.excludedPullRequests],
        ]);
        return {
          installations: 1,
          repositories: 1,
          pullRequests: 1,
          updated: 0,
          unchanged: 1,
          errors: 0,
          limited: false,
        };
      },
    },
  );

  assert.deepEqual(calls, [
    ["pending", 2, 17],
    [
      "open",
      3,
      17,
      ["connfy/aimstrings-web#245", "connfy/review-gate#4"],
    ],
  ]);
  assert.equal(summary.pullRequests, 3);
  assert.equal(summary.updated, 1);
  assert.equal(summary.unchanged, 2);
  assert.equal("processedRefs" in summary.pending, false);
});

test("open fallback backfills candidates excluded by the pending sweep", async () => {
  const requestedLimits = [];
  const evaluatedPullRequests = [];
  const summary = await sweepOpenPullRequests(
    {
      GITHUB_APP_ID: "app-id",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    },
    { statusContext: "review-gate/codex-clean" },
    {
      maxInstallations: 1,
      maxRepositories: 1,
      maxPullRequests: 2,
      pageSpan: 10,
      rotationSeed: 0,
      excludedPullRequests: new Set([
        "connfy/review-gate#1",
        "connfy/review-gate#2",
      ]),
      listInstallations: async () => [{ id: 42 }],
      getInstallationToken: async () => "installation-token",
      listRepositories: async () => [
        { owner: { login: "connfy" }, name: "review-gate" },
      ],
      clientFactory: () => ({
        async openPullRequests({ limit }) {
          requestedLimits.push(limit);
          return [1, 2, 3, 4].map((number) => ({ number }));
        },
        async latestStatusForContext() {
          return null;
        },
      }),
      evaluate: async (_client, { prNumber }) => {
        evaluatedPullRequests.push(prNumber);
        return {
          sha: `head-${prNumber}`,
          generation: `head-${prNumber}`,
          prState: "open",
          state: "success",
          description: "Review gate passed.",
        };
      },
      reportStatus: async () => {},
    },
  );

  assert.deepEqual(requestedLimits, [4]);
  assert.deepEqual(evaluatedPullRequests, [3, 4]);
  assert.equal(summary.pullRequests, 2);
  assert.equal(summary.updated, 2);
});

test("scheduled pending sweep does not spend two slots on stale heads of one PR", async () => {
  const oldKey = pendingReviewKey({
    installationId: 42,
    owner: "connfy",
    repo: "aimstrings-web",
    prNumber: 245,
    sha: "old-head",
  });
  const newKey = pendingReviewKey({
    installationId: 42,
    owner: "connfy",
    repo: "aimstrings-web",
    prNumber: 245,
    sha: "new-head",
  });
  let evaluations = 0;
  const namespace = {
    async list() {
      return {
        keys: [{ name: oldKey }, { name: newKey }],
        list_complete: true,
      };
    },
    async put() {},
    async delete() {},
  };

  const summary = await sweepPendingPullRequests(
    {
      PENDING_REVIEWS: namespace,
      GITHUB_APP_ID: "app-id",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    },
    { statusContext: "review-gate/codex-clean" },
    {
      maxPullRequests: 2,
      rotationSeed: 0,
      getInstallationToken: async () => "installation-token",
      clientFactory: () => ({
        async latestStatusForContext() {
          return {
            state: "pending",
            description: "Review bot is reviewing the latest head.",
          };
        },
      }),
      evaluate: async () => {
        evaluations += 1;
        return {
          sha: "new-head",
          state: "pending",
          description: "Review bot is reviewing the latest head.",
        };
      },
    },
  );

  assert.equal(evaluations, 1);
  assert.equal(summary.queued, 2);
  assert.equal(summary.pullRequests, 1);
});
