import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateGate } from "../src/gate.js";

function pr({ draft = false } = {}) {
  return { number: 123, draft, head: { sha: "abc123" } };
}

function timelineAfterHead(commentIds = []) {
  return [
    { event: "committed", sha: "abc123" },
    ...commentIds.map((id) => ({ event: "commented", id })),
  ];
}

function timelineBeforeHead(commentIds = []) {
  return [
    ...commentIds.map((id) => ({ event: "commented", id })),
    { event: "committed", sha: "abc123" },
  ];
}

test("clean review comment after latest head passes", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 1,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "Codex Review: Didn't find any major issues. Breezy!",
        created_at: "2026-05-28T00:01:00Z",
      },
    ],
    timelineEvents: timelineAfterHead([1]),
  });
  assert.equal(result.state, "success");
});

test("thumbs-up reaction path no longer passes (reaction shortcut dropped)", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 10,
        user: { login: "connfy" },
        body: "@codex review",
        created_at: "2026-05-28T00:00:05Z",
      },
    ],
    timelineEvents: timelineAfterHead([10]),
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("unresolved current thread blocks even with clean comment", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 1,
        user: { login: "chatgpt-codex-connector" },
        body: "Codex Review: Didn't find any major issues.",
        created_at: "2026-05-28T00:01:00Z",
      },
    ],
    reviewThreads: [{ isResolved: false, isOutdated: false }],
    timelineEvents: timelineAfterHead([1]),
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /unresolved current review thread/);
});

test("clean comment before latest head does not pass", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 1,
        user: { login: "chatgpt-codex-connector" },
        body: "Codex Review: Didn't find any major issues.",
        created_at: "2026-05-27T23:59:59Z",
      },
    ],
    timelineEvents: timelineBeforeHead([1]),
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("clean comment before force-push boundary does not pass", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 1,
        user: { login: "chatgpt-codex-connector" },
        body: "Codex Review: Didn't find any major issues.",
        created_at: "2026-05-28T00:01:00Z",
      },
    ],
    timelineEvents: [
      { event: "committed", sha: "abc123" },
      { event: "commented", id: 1 },
      { event: "head_ref_force_pushed" },
    ],
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("pending review without submitted timestamp is ignored", () => {
  const result = evaluateGate({
    pr: pr(),
    reviews: [
      {
        user: { login: "chatgpt-codex-connector" },
        body: "Codex Review: Didn't find any major issues.",
        submitted_at: null,
      },
    ],
    timelineEvents: timelineAfterHead([]),
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("draft PR blocks the review gate", () => {
  const result = evaluateGate({
    pr: pr({ draft: true }),
    issueComments: [
      {
        id: 1,
        user: { login: "chatgpt-codex-connector" },
        body: "Codex Review: Didn't find any major issues.",
        created_at: "2026-05-28T00:01:00Z",
      },
    ],
    timelineEvents: timelineAfterHead([1]),
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /draft/);
});

test("clean review body must match current head SHA", () => {
  const result = evaluateGate({
    pr: pr(),
    reviews: [
      {
        user: { login: "chatgpt-codex-connector" },
        body: "Codex Review: Didn't find any major issues.",
        submitted_at: "2026-05-28T00:01:00Z",
        commit_id: "abc123",
      },
    ],
    timelineEvents: timelineAfterHead([]),
  });
  assert.equal(result.state, "success");
});

test("clean review body for an old SHA does not pass", () => {
  const result = evaluateGate({
    pr: pr(),
    reviews: [
      {
        user: { login: "chatgpt-codex-connector" },
        body: "Codex Review: Didn't find any major issues.",
        submitted_at: "2026-05-28T00:01:00Z",
        commit_id: "old-sha",
      },
    ],
    timelineEvents: timelineAfterHead([]),
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("custom bot login and clean text are honoured", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 1,
        user: { login: "my-reviewer[bot]" },
        body: "LGTM: no blocking issues found.",
        created_at: "2026-05-28T00:01:00Z",
      },
    ],
    timelineEvents: timelineAfterHead([1]),
    config: {
      botLogins: ["my-reviewer[bot]"],
      cleanText: "LGTM: no blocking issues found.",
    },
  });
  assert.equal(result.state, "success");
});
