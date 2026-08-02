import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateGate,
  REVIEW_IN_PROGRESS_DESCRIPTION,
} from "../src/gate.js";

function pr({ draft = false, state = "open" } = {}) {
  return { number: 123, draft, state, head: { sha: "abc123" } };
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

function timelineHeadAt(timestamp) {
  return [
    {
      event: "committed",
      sha: "abc123",
      author: { date: timestamp },
    },
  ];
}

const fullHeadSha = "abc123abc123abc123abc123abc123abc123abcd";

function settledDispositionFixture(overrides = {}) {
  const request = {
    id: 10,
    user: { login: "reviewer", type: "User" },
    body: "@codex review",
    created_at: "2026-08-02T00:01:00Z",
  };
  const disposition = {
    id: 20,
    user: { login: "connfy", type: "User" },
    body: `@review-gate settle ${fullHeadSha}`,
    created_at: "2026-08-02T00:03:00Z",
    html_url: "https://github.com/connfy/example/pull/123#issuecomment-20",
  };
  return {
    pr: {
      number: 123,
      draft: false,
      state: "open",
      head: { sha: fullHeadSha },
    },
    issueComments: [request, disposition],
    reviews: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "Codex Review\n\nHere are two findings.",
        submitted_at: "2026-08-02T00:02:00Z",
        commit_id: fullHeadSha,
        state: "COMMENTED",
      },
    ],
    timelineEvents: [
      {
        event: "committed",
        sha: fullHeadSha,
        author: { date: "2026-08-02T00:00:00Z" },
      },
      { event: "commented", ...request },
      { event: "commented", ...disposition },
    ],
    config: {
      settledDispositionLogins: ["connfy"],
    },
    ...overrides,
  };
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

test("PR body thumbs-up reaction from review bot after latest head passes", () => {
  const result = evaluateGate({
    pr: pr(),
    issueReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "+1",
        created_at: "2026-05-28T00:02:00Z",
      },
    ],
    timelineEvents: timelineHeadAt("2026-05-28T00:01:00Z"),
  });
  assert.equal(result.state, "success");
  assert.match(result.details[0], /clean PR body reaction/);
});

test("PR body eyes reaction from review bot after latest head is pending", () => {
  const result = evaluateGate({
    pr: pr(),
    issueEyesReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "eyes",
        created_at: "2026-05-28T00:02:00Z",
      },
    ],
    timelineEvents: timelineHeadAt("2026-05-28T00:01:00Z"),
  });
  assert.equal(result.state, "pending");
  assert.equal(result.description, REVIEW_IN_PROGRESS_DESCRIPTION);
  assert.match(result.details[0], /PR body eyes reaction/);
});

test("gate results preserve the pull request state", () => {
  const result = evaluateGate({ pr: pr({ state: "closed" }) });

  assert.equal(result.prState, "closed");
});

test("PR body eyes reaction before latest head does not go pending", () => {
  const result = evaluateGate({
    pr: pr(),
    issueEyesReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "eyes",
        created_at: "2026-05-28T00:00:00Z",
      },
    ],
    timelineEvents: timelineHeadAt("2026-05-28T00:01:00Z"),
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("PR body thumbs-up reaction from a user does not pass", () => {
  const result = evaluateGate({
    pr: pr(),
    issueReactions: [
      {
        user: { login: "connfy" },
        content: "+1",
        created_at: "2026-05-28T00:02:00Z",
      },
    ],
    timelineEvents: timelineHeadAt("2026-05-28T00:01:00Z"),
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("PR body thumbs-up reaction before latest head does not pass", () => {
  const result = evaluateGate({
    pr: pr(),
    issueReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "+1",
        created_at: "2026-05-28T00:00:00Z",
      },
    ],
    timelineEvents: timelineHeadAt("2026-05-28T00:01:00Z"),
  });
  assert.equal(result.state, "failure");
  assert.match(result.description, /PR body \+1 reaction.*stale/);
});

test("PR body thumbs-up reaction before latest review request does not pass", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 10,
        user: { login: "connfy" },
        body: "@codex review",
        created_at: "2026-05-28T00:03:00Z",
      },
    ],
    issueReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "+1",
        created_at: "2026-05-28T00:02:00Z",
      },
    ],
    timelineEvents: [
      ...timelineHeadAt("2026-05-28T00:01:00Z"),
      {
        event: "commented",
        id: 10,
        user: { login: "connfy" },
        body: "@codex review",
        created_at: "2026-05-28T00:03:00Z",
      },
    ],
  });
  assert.equal(result.state, "failure");
  assert.match(result.description, /latest review request/);
});

test("review request eyes reaction from review bot is pending", () => {
  const reviewRequest = {
    id: 10,
    user: { login: "connfy" },
    body: "@codex review",
    created_at: "2026-05-28T00:02:00Z",
  };
  const result = evaluateGate({
    pr: pr(),
    issueComments: [reviewRequest],
    reviewRequestReactions: [
      {
        comment: reviewRequest,
        reactions: [
          {
            user: { login: "chatgpt-codex-connector[bot]" },
            content: "eyes",
            created_at: "2026-05-28T00:02:15Z",
          },
        ],
      },
    ],
    timelineEvents: [
      ...timelineHeadAt("2026-05-28T00:01:00Z"),
      {
        event: "commented",
        id: 10,
        user: { login: "connfy" },
        body: "@codex review",
        created_at: "2026-05-28T00:02:00Z",
      },
    ],
  });
  assert.equal(result.state, "pending");
  assert.equal(result.generation, "request:10");
  assert.equal(result.description, REVIEW_IN_PROGRESS_DESCRIPTION);
  assert.match(result.details[0], /review request eyes reaction/);
});

test("review bot response after eyes stops pending state", () => {
  const result = evaluateGate({
    pr: pr(),
    issueEyesReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "eyes",
        created_at: "2026-05-28T00:02:00Z",
      },
    ],
    reviews: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "Codex Review\n\nHere are some automated review suggestions.",
        submitted_at: "2026-05-28T00:03:00Z",
        commit_id: "abc123",
      },
    ],
    timelineEvents: timelineHeadAt("2026-05-28T00:01:00Z"),
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("review request eyes before latest head does not go pending", () => {
  const reviewRequest = {
    id: 10,
    user: { login: "connfy" },
    body: "@codex review",
    created_at: "2026-05-28T00:01:00Z",
  };
  const result = evaluateGate({
    pr: pr(),
    issueComments: [reviewRequest],
    reviewRequestReactions: [
      {
        comment: reviewRequest,
        reactions: [
          {
            user: { login: "chatgpt-codex-connector[bot]" },
            content: "eyes",
            created_at: "2026-05-28T00:03:00Z",
          },
        ],
      },
    ],
    timelineEvents: [
      {
        event: "commented",
        id: 10,
        user: { login: "connfy" },
        body: "@codex review",
        created_at: "2026-05-28T00:01:00Z",
      },
      ...timelineHeadAt("2026-05-28T00:02:00Z"),
    ],
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

test("allowlisted human exact-head disposition passes after a formal bot review", () => {
  const result = evaluateGate(settledDispositionFixture());

  assert.equal(result.state, "success");
  assert.equal(
    result.description,
    "Settled by @connfy for abc123abc123.",
  );
  assert.equal(
    result.targetUrl,
    "https://github.com/connfy/example/pull/123#issuecomment-20",
  );
});

test("settled disposition is default-off and requires an allowlisted human", () => {
  const fixture = settledDispositionFixture();
  assert.equal(evaluateGate({ ...fixture, config: {} }).state, "failure");

  fixture.issueComments[1] = {
    ...fixture.issueComments[1],
    user: { login: "connfy", type: "Bot" },
  };
  assert.equal(evaluateGate(fixture).state, "failure");
});

test("settled disposition accepts only the exact full-head issue-comment command", () => {
  for (const body of [
    "@review-gate settle abc123",
    "@review-gate settle abc123abc123abc123abc123abc123abc123abce",
    `please @review-gate settle ${fullHeadSha}`,
    `@review-gate settle ${fullHeadSha} approved`,
    ` @review-gate settle ${fullHeadSha}`,
    `@review-gate settle  ${fullHeadSha}`,
    `@review-gate settle ${fullHeadSha}\n`,
    `@REVIEW-GATE settle ${fullHeadSha}`,
    `@review-gate settle ${fullHeadSha.toUpperCase()}`,
  ]) {
    const fixture = settledDispositionFixture();
    fixture.issueComments[1] = { ...fixture.issueComments[1], body };
    assert.equal(evaluateGate(fixture).state, "failure", body);
  }

  const fixture = settledDispositionFixture();
  fixture.pr = {
    ...fixture.pr,
    body: `@review-gate settle ${fullHeadSha}`,
  };
  fixture.issueComments = [fixture.issueComments[0]];
  fixture.timelineEvents = fixture.timelineEvents.slice(0, 2);
  assert.equal(evaluateGate(fixture).state, "failure");
});

test("settled disposition requires request, review, and command in strict time order", () => {
  for (const mutate of [
    (fixture) => {
      fixture.issueComments[0] = {
        ...fixture.issueComments[0],
        created_at: "2026-08-02T00:00:00Z",
      };
      fixture.timelineEvents = [
        { event: "commented", ...fixture.issueComments[0] },
        fixture.timelineEvents[0],
        fixture.timelineEvents[2],
      ];
    },
    (fixture) => {
      fixture.reviews[0] = {
        ...fixture.reviews[0],
        submitted_at: "2026-08-02T00:01:00Z",
      };
    },
    (fixture) => {
      fixture.issueComments[1] = {
        ...fixture.issueComments[1],
        created_at: "2026-08-02T00:02:00Z",
      };
      fixture.timelineEvents[2] = {
        event: "commented",
        ...fixture.issueComments[1],
      };
    },
    (fixture) => {
      fixture.reviews[0] = {
        ...fixture.reviews[0],
        submitted_at: null,
      };
    },
    (fixture) => {
      fixture.issueComments[0] = {
        ...fixture.issueComments[0],
        created_at: null,
      };
    },
    (fixture) => {
      fixture.issueComments[1] = {
        ...fixture.issueComments[1],
        created_at: null,
      };
    },
    (fixture) => {
      const laterRequest = {
        id: 30,
        user: { login: "reviewer", type: "User" },
        body: "@codex review",
        created_at: null,
      };
      fixture.issueComments.push(laterRequest);
      fixture.timelineEvents.push({
        event: "commented",
        ...laterRequest,
      });
    },
  ]) {
    const fixture = settledDispositionFixture();
    mutate(fixture);
    assert.equal(evaluateGate(fixture).state, "failure");
  }
});

test("settled disposition fails closed when the current head is missing from the timeline", () => {
  const fixture = settledDispositionFixture();
  fixture.timelineEvents.shift();

  assert.equal(evaluateGate(fixture).state, "failure");
});

test("settled disposition requires a non-dismissed formal bot review on exact head", () => {
  for (const review of [
    {
      user: { login: "chatgpt-codex-connector[bot]" },
      submitted_at: "2026-08-02T00:02:00Z",
      commit_id: "def456def456def456def456def456def456def4",
      state: "COMMENTED",
    },
    {
      user: { login: "chatgpt-codex-connector[bot]" },
      submitted_at: "2026-08-02T00:02:00Z",
      commit_id: fullHeadSha,
      state: "DISMISSED",
    },
    {
      user: { login: "other-bot" },
      submitted_at: "2026-08-02T00:02:00Z",
      commit_id: fullHeadSha,
      state: "COMMENTED",
    },
  ]) {
    const result = evaluateGate(
      settledDispositionFixture({ reviews: [review] }),
    );
    assert.equal(result.state, "failure");
  }
});

test("later request, new head, and unresolved thread block disposition", () => {
  const laterRequest = {
    id: 30,
    user: { login: "reviewer", type: "User" },
    body: "@codex review",
    created_at: "2026-08-02T00:04:00Z",
  };
  const withLaterRequest = settledDispositionFixture();
  withLaterRequest.issueComments.push(laterRequest);
  withLaterRequest.timelineEvents.push({
    event: "commented",
    ...laterRequest,
  });
  assert.equal(evaluateGate(withLaterRequest).state, "failure");
  const redisposition = {
    ...withLaterRequest.issueComments[1],
    id: 40,
    created_at: "2026-08-02T00:06:00Z",
    html_url: "https://github.com/connfy/example/pull/123#issuecomment-40",
  };
  withLaterRequest.reviews.push({
    user: { login: "chatgpt-codex-connector[bot]" },
    submitted_at: "2026-08-02T00:05:00Z",
    commit_id: fullHeadSha,
    state: "COMMENTED",
  });
  withLaterRequest.issueComments.push(redisposition);
  withLaterRequest.timelineEvents.push({
    event: "commented",
    ...redisposition,
  });
  assert.equal(evaluateGate(withLaterRequest).state, "success");

  const newHead = settledDispositionFixture();
  newHead.pr = {
    ...newHead.pr,
    head: { sha: "def456def456def456def456def456def456def4" },
  };
  newHead.timelineEvents.push({
    event: "committed",
    sha: newHead.pr.head.sha,
    author: { date: "2026-08-02T00:04:00Z" },
  });
  assert.equal(evaluateGate(newHead).state, "failure");

  const unresolved = evaluateGate(
    settledDispositionFixture({
      reviewThreads: [{ isResolved: false, isOutdated: false }],
    }),
  );
  assert.equal(unresolved.state, "failure");
});

test("review in progress blocks a settled disposition", () => {
  const fixture = settledDispositionFixture({
    issueEyesReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "eyes",
        created_at: "2026-08-02T00:04:30Z",
      },
    ],
  });
  const pending = evaluateGate(fixture);
  assert.equal(pending.state, "pending");
  assert.equal(pending.description, REVIEW_IN_PROGRESS_DESCRIPTION);
});

test("settled disposition fails closed without a command comment URL", () => {
  const fixture = settledDispositionFixture();
  fixture.issueComments[1] = {
    ...fixture.issueComments[1],
    html_url: "",
  };

  assert.equal(evaluateGate(fixture).state, "failure");
});

test("a newer timeline-only review request invalidates a prior disposition", () => {
  const fixture = settledDispositionFixture();
  assert.equal(evaluateGate(fixture).state, "success");

  // The new request surfaces in the already-fetched timeline before the
  // issue-comments endpoint catches up, so it exists only in the timeline.
  fixture.timelineEvents.push({
    event: "commented",
    id: 30,
    user: { login: "reviewer", type: "User" },
    body: "@codex review",
    created_at: "2026-08-02T00:04:00Z",
  });

  assert.equal(evaluateGate(fixture).state, "failure");
});

test("an issue-comments-only review request keeps the disposition fail-closed", () => {
  const fixture = settledDispositionFixture();
  // The request is visible in issue comments but cannot be matched to the
  // timeline yet, so the disposition must fail closed rather than pass.
  fixture.issueComments.push({
    id: 30,
    user: { login: "reviewer", type: "User" },
    body: "@codex review",
    created_at: "2026-08-02T00:04:00Z",
  });

  assert.equal(evaluateGate(fixture).state, "failure");
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
  assert.match(result.details[0], /stale|No clean review pass/);
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
  assert.match(result.details[0], /stale|No clean review pass/);
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

test("clean comment passes when Reviewed commit matches head but timeline lags", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 999,
        user: { login: "chatgpt-codex-connector[bot]" },
        body:
          "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc123`",
        created_at: "2026-05-28T00:02:00Z",
      },
    ],
    timelineEvents: [
      {
        event: "committed",
        sha: "abc123",
        author: { date: "2026-05-28T00:00:00Z" },
      },
    ],
  });
  assert.equal(result.state, "success");
});

test("comment after head boundary but reviewed commit mismatch does not pass", () => {
  const result = evaluateGate({
    pr: { number: 123, draft: false, head: { sha: "newhead1234567890abcd" } },
    issueComments: [
      {
        id: 2,
        user: { login: "chatgpt-codex-connector[bot]" },
        body:
          "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `46002bce95`",
        created_at: "2026-05-28T00:06:00Z",
      },
    ],
    timelineEvents: [
      {
        event: "committed",
        sha: "newhead1234567890abcd",
        author: { date: "2026-05-28T00:05:00Z" },
      },
      {
        event: "commented",
        id: 2,
        user: { login: "chatgpt-codex-connector[bot]" },
        body:
          "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `46002bce95`",
        created_at: "2026-05-28T00:06:00Z",
      },
    ],
  });
  assert.equal(result.state, "failure");
  assert.match(result.description, /Review bot reviewed 46002bce95/);
});

test("clean comment without timeline event or reviewed commit does not pass", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 999,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "Codex Review: Didn't find any major issues.",
        created_at: "2026-05-28T00:02:00Z",
      },
    ],
    timelineEvents: [
      {
        event: "committed",
        sha: "abc123",
        author: { date: "2026-05-28T00:00:00Z" },
      },
    ],
  });
  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("stale clean review explains newer head commit", () => {
  const result = evaluateGate({
    pr: { number: 123, draft: false, head: { sha: "abc123def4567890abcd" } },
    issueComments: [
      {
        id: 1,
        user: { login: "chatgpt-codex-connector[bot]" },
        body:
          "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `46002bce95`",
        created_at: "2026-05-28T00:06:00Z",
      },
    ],
    timelineEvents: [
      {
        event: "committed",
        sha: "abc123def4567890abcd",
        author: { date: "2026-05-28T00:05:00Z" },
      },
    ],
  });
  assert.equal(result.state, "failure");
  assert.match(result.description, /Review bot reviewed 46002bce95/);
});

test("stale clean review before latest commit gets an explicit message", () => {
  const result = evaluateGate({
    pr: pr(),
    issueComments: [
      {
        id: 1,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "Codex Review: Didn't find any major issues.",
        created_at: "2026-05-28T00:01:00Z",
      },
    ],
    timelineEvents: [
      { event: "commented", id: 1 },
      {
        event: "committed",
        sha: "abc123",
        author: { date: "2026-05-28T00:05:00Z" },
      },
    ],
  });
  assert.equal(result.state, "failure");
  assert.match(result.description, /stale/i);
});
