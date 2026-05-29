import assert from "node:assert/strict";
import { test } from "node:test";

import { pullRequestRefFromEvent, verifySignature } from "../src/webhook.js";

const repository = { owner: { login: "connfy" }, name: "ai-trading-bot" };
const installation = { id: 42 };

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
