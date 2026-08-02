import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pullRequestRefFromEvent,
  shouldIgnoreEvent,
  verifySignature,
} from "../src/webhook.js";

const repository = { owner: { login: "connfy" }, name: "ai-trading-bot" };
const installation = { id: 42 };
const config = {
  botLogins: new Set(["chatgpt-codex-connector[bot]"]),
  cleanText: "Codex Review: Didn't find any major issues.",
  settledDispositionLogins: new Set(["connfy"]),
};

function issueCommentPayload({
  user,
  body,
  action = "created",
  type = "User",
} = {}) {
  return {
    action,
    issue: { number: 11, pull_request: { url: "x" } },
    comment: {
      user: { login: user, type },
      body,
    },
  };
}

test("pull_request event resolves to PR coordinates", () => {
  const ref = pullRequestRefFromEvent("pull_request", {
    repository,
    installation,
    pull_request: { number: 7 },
  });
  assert.deepEqual(ref, {
    owner: "connfy",
    repo: "ai-trading-bot",
    prNumber: 7,
    installationId: 42,
  });
});

test("pull_request_review_thread event resolves to PR coordinates", () => {
  const ref = pullRequestRefFromEvent("pull_request_review_thread", {
    repository,
    installation,
    pull_request: { number: 9 },
  });
  assert.equal(ref.prNumber, 9);
});

test("issue_comment on a pull request resolves", () => {
  const ref = pullRequestRefFromEvent("issue_comment", {
    repository,
    installation,
    issue: { number: 11, pull_request: { url: "x" } },
  });
  assert.equal(ref.prNumber, 11);
});

test("issue_comment on a plain issue is ignored", () => {
  const ref = pullRequestRefFromEvent("issue_comment", {
    repository,
    installation,
    issue: { number: 11 },
  });
  assert.equal(ref, null);
});

test("irrelevant events are ignored", () => {
  assert.equal(pullRequestRefFromEvent("push", { repository, installation }), null);
});

test("events without an installation id are ignored", () => {
  const ref = pullRequestRefFromEvent("pull_request", {
    repository,
    pull_request: { number: 7 },
  });
  assert.equal(ref, null);
});

test("user issue comments are ignored as gate signals", () => {
  const ignored = shouldIgnoreEvent(
    "issue_comment",
    issueCommentPayload({ user: "connfy", body: "looks good to me" }),
    config,
  );
  assert.equal(ignored, true);
});

test("review request issue comments trigger evaluation", () => {
  const ignored = shouldIgnoreEvent(
    "issue_comment",
    issueCommentPayload({ user: "connfy", body: "@codex review" }),
    config,
  );
  assert.equal(ignored, false);
});

test("allowlisted exact-head settled-disposition comments trigger evaluation", () => {
  const ignored = shouldIgnoreEvent(
    "issue_comment",
    issueCommentPayload({
      user: "connfy",
      body:
        "@review-gate settle " +
        "abc123abc123abc123abc123abc123abc123abcd",
    }),
    config,
  );
  assert.equal(ignored, false);
});

test("malformed, non-allowlisted, and bot settled-disposition comments are ignored", () => {
  for (const payload of [
    issueCommentPayload({
      user: "connfy",
      body: "@review-gate settle abc123",
    }),
    issueCommentPayload({
      user: "other-owner",
      body:
        "@review-gate settle " +
        "abc123abc123abc123abc123abc123abc123abcd",
    }),
    issueCommentPayload({
      user: "connfy",
      type: "Bot",
      body:
        "@review-gate settle " +
        "abc123abc123abc123abc123abc123abc123abcd",
    }),
  ]) {
    assert.equal(shouldIgnoreEvent("issue_comment", payload, config), true);
  }
});

test("configured bot clean issue comments trigger evaluation", () => {
  const ignored = shouldIgnoreEvent(
    "issue_comment",
    issueCommentPayload({
      user: "chatgpt-codex-connector[bot]",
      body: "Codex Review: Didn't find any major issues. :tada:",
    }),
    config,
  );
  assert.equal(ignored, false);
});

test("configured bot edited or deleted issue comments trigger evaluation", () => {
  for (const action of ["edited", "deleted"]) {
    const ignored = shouldIgnoreEvent(
      "issue_comment",
      issueCommentPayload({
        user: "chatgpt-codex-connector[bot]",
        body: "",
        action,
      }),
      config,
    );
    assert.equal(ignored, false);
  }
});

test("verifySignature accepts a correct signature and rejects tampering", async () => {
  const secret = "s3cr3t";
  const body = JSON.stringify({ hello: "world" });

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  assert.equal(await verifySignature(secret, body, `sha256=${hex}`), true);
  assert.equal(await verifySignature(secret, body, `sha256=${hex}`.slice(0, -1) + "0"), false);
  assert.equal(await verifySignature(secret, body + "x", `sha256=${hex}`), false);
  assert.equal(await verifySignature(secret, body, null), false);
});
