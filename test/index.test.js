import assert from "node:assert/strict";
import { test } from "node:test";

import { maybeRetryReviewStart, shouldReportStatus } from "../src/index.js";

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
