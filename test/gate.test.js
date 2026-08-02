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
    user: { login: "connfy", type: "User" },
    body: "@codex review",
    created_at: "2026-08-02T00:01:00Z",
  };
  const botReview = {
    id: 15,
    user: { login: "chatgpt-codex-connector[bot]" },
    body: "Codex Review\n\nHere are two findings.",
    submitted_at: "2026-08-02T00:02:00Z",
    commit_id: fullHeadSha,
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
    reviews: [botReview],
    timelineEvents: [
      {
        event: "committed",
        sha: fullHeadSha,
        author: { date: "2026-08-02T00:00:00Z" },
      },
      { event: "commented", ...request },
      {
        event: "reviewed",
        id: botReview.id,
        user: botReview.user,
        submitted_at: botReview.submitted_at,
        commit_id: botReview.commit_id,
      },
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

test("allowlisted human exact-head disposition passes after a current-head finding review", () => {
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
  assert.match(result.details[0], /settled disposition by @connfy/);
});

test("settled disposition does not override unresolved current threads", () => {
  const result = evaluateGate(
    settledDispositionFixture({
      reviewThreads: [{ isResolved: false, isOutdated: false }],
    }),
  );

  assert.equal(result.state, "failure");
  assert.match(result.details[0], /unresolved current review thread/);
});

test("settled disposition is disabled without an allowlist", () => {
  const fixture = settledDispositionFixture();
  const result = evaluateGate({ ...fixture, config: {} });

  assert.equal(result.state, "failure");
  assert.match(result.details[0], /No clean review pass/);
});

test("settled disposition requires an allowlisted human account", () => {
  for (const user of [
    { login: "other-owner", type: "User" },
    { login: "connfy", type: "Bot" },
  ]) {
    const fixture = settledDispositionFixture();
    fixture.issueComments[1] = { ...fixture.issueComments[1], user };
    const result = evaluateGate(fixture);
    assert.equal(result.state, "failure");
  }
});

test("settled disposition requires the exact full current head SHA", () => {
  for (const body of [
    "@review-gate settle abc123",
    "@review-gate settle abc123abc123abc123abc123abc123abc123abce",
    `please @review-gate settle ${fullHeadSha}`,
    `@review-gate settle ${fullHeadSha} approved`,
  ]) {
    const fixture = settledDispositionFixture();
    fixture.issueComments[1] = { ...fixture.issueComments[1], body };
    const result = evaluateGate(fixture);
    assert.equal(result.state, "failure", body);
  }
});

test("PR body text alone is not a settled disposition", () => {
  const fixture = settledDispositionFixture();
  fixture.pr = {
    ...fixture.pr,
    body: `@review-gate settle ${fullHeadSha}`,
  };
  fixture.issueComments = [fixture.issueComments[0]];
  fixture.timelineEvents = fixture.timelineEvents.slice(0, 3);
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("settled disposition must be present on the issue timeline", () => {
  const fixture = settledDispositionFixture();
  fixture.timelineEvents.pop();
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("edited settled-disposition commands fail closed", () => {
  const fixture = settledDispositionFixture();
  fixture.issueComments[1] = {
    ...fixture.issueComments[1],
    updated_at: "2026-08-02T00:04:00Z",
  };
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("deleted review request cannot survive through timeline history", () => {
  const fixture = settledDispositionFixture();
  fixture.issueComments = [fixture.issueComments[1]];
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("review request must follow the latest head in timeline order", () => {
  const fixture = settledDispositionFixture();
  fixture.timelineEvents = [
    { event: "commented", ...fixture.issueComments[0] },
    fixture.timelineEvents[0],
    fixture.timelineEvents[2],
    fixture.timelineEvents[3],
  ];
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("settled disposition requires a current-head bot response after the latest request", () => {
  for (const review of [
    {
      user: { login: "chatgpt-codex-connector[bot]" },
      body: "Codex Review\n\nHere are two findings.",
      submitted_at: "2026-08-02T00:00:30Z",
      commit_id: fullHeadSha,
    },
    {
      user: { login: "chatgpt-codex-connector[bot]" },
      body: "Codex Review\n\nHere are two findings.",
      submitted_at: "2026-08-02T00:02:00Z",
      commit_id: "def456def456def456def456def456def456def4",
    },
  ]) {
    const fixture = settledDispositionFixture({ reviews: [review] });
    const result = evaluateGate(fixture);
    assert.equal(result.state, "failure");
  }
});

test("dismissed current-head reviews do not support a disposition", () => {
  const fixture = settledDispositionFixture();
  fixture.reviews[0] = {
    ...fixture.reviews[0],
    state: "DISMISSED",
  };
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("current-head bot finding comment can precede the disposition", () => {
  const fixture = settledDispositionFixture({
    reviews: [],
  });
  const botComment = {
    id: 15,
    user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    body:
      "Codex Review: two findings.\n\n" +
      `**Reviewed commit:** \`${fullHeadSha.slice(0, 10)}\``,
    created_at: "2026-08-02T00:02:00Z",
  };
  fixture.issueComments.splice(1, 0, botComment);
  fixture.timelineEvents.splice(2, 0, { event: "commented", ...botComment });
  const result = evaluateGate(fixture);

  assert.equal(result.state, "success");
});

test("settled disposition must follow the current-head bot response", () => {
  const fixture = settledDispositionFixture();
  fixture.issueComments[1] = {
    ...fixture.issueComments[1],
    created_at: "2026-08-02T00:01:30Z",
  };
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("a later review request invalidates an earlier settled disposition", () => {
  const fixture = settledDispositionFixture();
  const laterRequest = {
    id: 30,
    user: { login: "connfy", type: "User" },
    body: "@codex review",
    created_at: "2026-08-02T00:04:00Z",
  };
  fixture.issueComments.push(laterRequest);
  fixture.timelineEvents.push({ event: "commented", ...laterRequest });
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("editing an older comment into a review request invalidates a prior disposition", () => {
  const fixture = settledDispositionFixture();
  const editedRequest = {
    id: 5,
    user: { login: "reviewer", type: "User" },
    body: "@codex review",
    created_at: "2026-08-01T23:59:00Z",
    updated_at: "2026-08-02T00:04:00Z",
  };
  fixture.issueComments.push(editedRequest);
  fixture.timelineEvents.splice(1, 0, {
    event: "commented",
    ...editedRequest,
    updated_at: undefined,
  });
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("same-second edited review request needs a strictly later bot response", () => {
  const fixture = settledDispositionFixture();
  fixture.issueComments[0] = {
    ...fixture.issueComments[0],
    created_at: "2026-08-02T00:01:00Z",
    updated_at: "2026-08-02T00:02:00Z",
  };
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("a same-timestamp later review request invalidates an earlier disposition", () => {
  const fixture = settledDispositionFixture();
  const laterRequest = {
    id: 30,
    user: { login: "connfy", type: "User" },
    body: "@codex review",
    created_at: "2026-08-02T00:03:00Z",
  };
  fixture.issueComments.push(laterRequest);
  fixture.timelineEvents.push({ event: "commented", ...laterRequest });
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("same-timestamp request bot response and disposition respect timeline order", () => {
  const fixture = settledDispositionFixture();
  fixture.issueComments[0] = {
    ...fixture.issueComments[0],
    created_at: "2026-08-02T00:02:00Z",
  };
  fixture.issueComments[1] = {
    ...fixture.issueComments[1],
    created_at: "2026-08-02T00:02:00Z",
  };
  fixture.timelineEvents[1] = {
    event: "commented",
    ...fixture.issueComments[0],
  };
  fixture.timelineEvents[3] = {
    event: "commented",
    ...fixture.issueComments[1],
  };
  const result = evaluateGate(fixture);

  assert.equal(result.state, "success");
});

test("latest same-timestamp bot response invalidates an earlier disposition", () => {
  const fixture = settledDispositionFixture();
  const laterReview = {
    id: 25,
    user: { login: "chatgpt-codex-connector[bot]" },
    body: "Codex Review\n\nA later finding.",
    submitted_at: "2026-08-02T00:03:00Z",
    commit_id: fullHeadSha,
  };
  fixture.reviews.push(laterReview);
  fixture.timelineEvents.push({
    event: "reviewed",
    id: laterReview.id,
    user: laterReview.user,
    submitted_at: laterReview.submitted_at,
    commit_id: laterReview.commit_id,
  });
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("ambiguous same-timestamp bot response order fails closed", () => {
  const fixture = settledDispositionFixture();
  fixture.reviews.push({
    user: { login: "chatgpt-codex-connector[bot]" },
    body: "Codex Review\n\nA response missing from the timeline.",
    submitted_at: "2026-08-02T00:02:00Z",
    commit_id: fullHeadSha,
  });
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("latest review request missing from the timeline fails closed", () => {
  const fixture = settledDispositionFixture();
  const missingRequest = {
    id: 30,
    user: { login: "connfy", type: "User" },
    body: "@codex review",
    created_at: "2026-08-02T00:03:00Z",
  };
  fixture.issueComments.push(missingRequest);
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("a later in-progress eyes signal blocks an earlier settled disposition", () => {
  const fixture = settledDispositionFixture({
    issueEyesReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "eyes",
        created_at: "2026-08-02T00:04:00Z",
      },
    ],
  });
  const result = evaluateGate(fixture);

  assert.equal(result.state, "pending");
  assert.equal(result.description, REVIEW_IN_PROGRESS_DESCRIPTION);
});

test("same-timestamp in-progress eyes signal fails closed", () => {
  const fixture = settledDispositionFixture({
    issueEyesReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "eyes",
        created_at: "2026-08-02T00:02:00Z",
      },
    ],
  });
  const result = evaluateGate(fixture);

  assert.notEqual(result.state, "success");
});

test("an earlier eyes signal does not block a later bot response and disposition", () => {
  const fixture = settledDispositionFixture({
    issueEyesReactions: [
      {
        user: { login: "chatgpt-codex-connector[bot]" },
        content: "eyes",
        created_at: "2026-08-02T00:01:30Z",
      },
    ],
  });
  const result = evaluateGate(fixture);

  assert.equal(result.state, "success");
});

test("a new head invalidates an earlier settled disposition", () => {
  const fixture = settledDispositionFixture();
  fixture.pr = {
    ...fixture.pr,
    head: { sha: "def456def456def456def456def456def456def4" },
  };
  fixture.timelineEvents.push({
    event: "committed",
    sha: fixture.pr.head.sha,
    author: { date: "2026-08-02T00:04:00Z" },
  });
  const result = evaluateGate(fixture);

  assert.equal(result.state, "failure");
});

test("custom settled-disposition command is honored", () => {
  const fixture = settledDispositionFixture();
  fixture.issueComments[1] = {
    ...fixture.issueComments[1],
    body: `/owner-settled ${fullHeadSha}`,
  };
  fixture.config = {
    ...fixture.config,
    settledDispositionCommand: "/owner-settled",
  };
  const result = evaluateGate(fixture);

  assert.equal(result.state, "success");
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
