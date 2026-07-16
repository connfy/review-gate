import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listPendingReviews,
  pendingReviewEntry,
  pendingReviewIdentity,
  pendingReviewKey,
  settlePendingReview,
  trackPendingReview,
} from "../src/pending.js";

class FakePendingReviews {
  constructor() {
    this.records = new Map();
  }

  async put(key, value, options) {
    this.records.set(key, { value, ...options });
  }

  async delete(key) {
    this.records.delete(key);
  }

  async list({ prefix, limit }) {
    const keys = [...this.records.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit)
      .map(([name, record]) => ({ name, metadata: record.metadata }));
    return { keys, list_complete: keys.length === this.records.size };
  }
}

const ref = {
  installationId: 42,
  owner: "connfy",
  repo: "aimstrings-web",
  prNumber: 245,
};

test("pending review keys round-trip a PR ref and head SHA", () => {
  const key = pendingReviewKey(ref, "abc123");

  assert.deepEqual(pendingReviewEntry({ name: key }), {
    key,
    ref: { ...ref, sha: "abc123", generation: "abc123" },
  });
  assert.equal(pendingReviewIdentity(ref), "connfy/aimstrings-web#245");
});

test("pending results are queued with a TTL and terminal results are removed", async () => {
  const namespace = new FakePendingReviews();
  const pending = await trackPendingReview(
    namespace,
    ref,
    { sha: "abc123", state: "pending" },
    { expirationTtl: 600, now: Date.parse("2026-07-16T12:00:00Z") },
  );

  assert.equal(pending.action, "put");
  assert.equal(namespace.records.get(pending.key).expirationTtl, 600);
  assert.equal(
    namespace.records.get(pending.key).metadata.queuedAt,
    "2026-07-16T12:00:00.000Z",
  );

  const listing = await listPendingReviews(namespace);
  assert.deepEqual(listing.entries, [
    {
      key: pending.key,
      ref: { ...ref, sha: "abc123", generation: "abc123" },
    },
  ]);

  const terminal = await trackPendingReview(namespace, ref, {
    sha: "abc123",
    state: "success",
  });
  assert.equal(terminal.action, "delete");
  assert.equal(namespace.records.size, 0);
});

test("pending review TTLs are clamped to the Workers KV minimum", async () => {
  const namespace = new FakePendingReviews();
  const pending = await trackPendingReview(
    namespace,
    ref,
    { sha: "abc123", state: "pending" },
    { expirationTtl: 1 },
  );

  assert.equal(namespace.records.get(pending.key).expirationTtl, 60);
});

test("settlement moves a pending record to a newer head without deleting it", async () => {
  const namespace = new FakePendingReviews();
  const queued = await trackPendingReview(namespace, ref, {
    sha: "old-head",
    state: "pending",
  });
  const entry = pendingReviewEntry({ name: queued.key });

  const settlement = await settlePendingReview(namespace, entry, {
    sha: "new-head",
    state: "pending",
  });

  assert.equal(settlement.action, "requeued");
  assert.equal(namespace.records.has(queued.key), false);
  assert.equal(
    namespace.records.has(pendingReviewKey(ref, "new-head")),
    true,
  );
});

test("an older terminal settlement cannot delete a newer review generation", async () => {
  const namespace = new FakePendingReviews();
  const oldPending = await trackPendingReview(namespace, ref, {
    sha: "same-head",
    generation: "request:10",
    state: "pending",
  });
  const newPending = await trackPendingReview(namespace, ref, {
    sha: "same-head",
    generation: "request:11",
    state: "pending",
  });

  await settlePendingReview(
    namespace,
    pendingReviewEntry({ name: oldPending.key }),
    {
      sha: "same-head",
      generation: "request:10",
      state: "success",
    },
  );

  assert.equal(namespace.records.has(oldPending.key), false);
  assert.equal(namespace.records.has(newPending.key), true);
});

test("pending review listing follows KV cursors", async () => {
  const firstKey = pendingReviewKey(ref, "first-head");
  const secondKey = pendingReviewKey(
    { ...ref, prNumber: 246 },
    "second-head",
  );
  const cursors = [];
  const namespace = {
    async list(options) {
      cursors.push(options.cursor ?? null);
      if (!options.cursor) {
        return {
          keys: [{ name: firstKey }],
          list_complete: false,
          cursor: "next-page",
        };
      }
      return {
        keys: [{ name: secondKey }],
        list_complete: true,
      };
    },
  };

  const listing = await listPendingReviews(namespace);

  assert.deepEqual(cursors, [null, "next-page"]);
  assert.equal(listing.entries.length, 2);
  assert.equal(listing.listComplete, true);
});

test("malformed pending keys are ignored", async () => {
  const namespace = new FakePendingReviews();
  namespace.records.set("pending-review:v1:broken", { metadata: {} });

  const listing = await listPendingReviews(namespace);

  assert.deepEqual(listing.entries, []);
});
