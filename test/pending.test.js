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
    ref: {
      ...ref,
      sha: "abc123",
      generation: "abc123",
      revision: "abc123",
    },
  });
  assert.equal(pendingReviewIdentity(ref), "connfy/aimstrings-web#245");
});

test("pending results are queued with a TTL and scheduled terminal settlement removes them", async () => {
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
      ref: {
        ...ref,
        sha: "abc123",
        generation: "abc123",
        revision: namespace.records.get(pending.key).metadata.revision,
      },
    },
  ]);

  const terminal = await settlePendingReview(
    namespace,
    listing.entries[0],
    { sha: "abc123", state: "success" },
    { observedEntries: listing.entries },
  );
  assert.equal(terminal.action, "removed");
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
    namespace.records.has(settlement.key),
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
    {
      observedEntries: (await listPendingReviews(namespace)).entries,
    },
  );

  assert.equal(namespace.records.has(oldPending.key), false);
  assert.equal(namespace.records.has(newPending.key), true);
});

test("terminal settlement removes the terminal generation it observed", async () => {
  const namespace = new FakePendingReviews();
  const oldPending = await trackPendingReview(namespace, ref, {
    sha: "same-head",
    generation: "request:10",
    state: "pending",
  });
  const currentPending = await trackPendingReview(namespace, ref, {
    sha: "same-head",
    generation: "request:11",
    state: "pending",
  });

  await settlePendingReview(
    namespace,
    pendingReviewEntry({ name: oldPending.key }),
    {
      sha: "same-head",
      generation: "request:11",
      state: "success",
    },
    {
      observedEntries: (await listPendingReviews(namespace)).entries,
    },
  );

  assert.equal(namespace.records.has(oldPending.key), false);
  assert.equal(namespace.records.has(currentPending.key), false);
});

test("closed webhook results defer queue cleanup to the scheduled snapshot", async () => {
  const namespace = new FakePendingReviews();
  await trackPendingReview(namespace, ref, {
    sha: "same-head",
    generation: "request:10",
    state: "pending",
  });
  await trackPendingReview(namespace, ref, {
    sha: "same-head",
    generation: "request:11",
    state: "pending",
  });

  const result = await trackPendingReview(namespace, ref, {
    sha: "same-head",
    generation: "request:11",
    state: "pending",
    prState: "closed",
  });

  assert.equal(result.action, "deferred");
  assert.equal(namespace.records.size, 2);
});

test("scheduled settlement clears every generation after a PR closes", async () => {
  const namespace = new FakePendingReviews();
  const oldPending = await trackPendingReview(namespace, ref, {
    sha: "same-head",
    generation: "request:10",
    state: "pending",
  });
  await trackPendingReview(namespace, ref, {
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
      state: "pending",
      prState: "closed",
    },
    {
      observedEntries: (await listPendingReviews(namespace)).entries,
    },
  );

  assert.equal(namespace.records.size, 0);
});

test("terminal settlement preserves pending revisions created after its snapshot", async () => {
  const namespace = new FakePendingReviews();
  const first = await trackPendingReview(
    namespace,
    ref,
    {
      sha: "same-head",
      generation: "request:11",
      state: "pending",
    },
    { revision: "before-evaluation" },
  );
  const observedEntries = (await listPendingReviews(namespace)).entries;
  const concurrent = await trackPendingReview(
    namespace,
    ref,
    {
      sha: "same-head",
      generation: "request:11",
      state: "pending",
    },
    { revision: "after-evaluation" },
  );

  await settlePendingReview(
    namespace,
    pendingReviewEntry({ name: first.key }),
    {
      sha: "same-head",
      generation: "request:11",
      state: "failure",
    },
    { observedEntries },
  );

  assert.equal(namespace.records.has(first.key), false);
  assert.equal(namespace.records.has(concurrent.key), true);
});

test("pending settlement compacts only revisions captured in its snapshot", async () => {
  const namespace = new FakePendingReviews();
  const kept = await trackPendingReview(
    namespace,
    ref,
    {
      sha: "same-head",
      generation: "request:11",
      state: "pending",
    },
    { revision: "first-before-evaluation" },
  );
  const duplicate = await trackPendingReview(
    namespace,
    ref,
    {
      sha: "same-head",
      generation: "request:11",
      state: "pending",
    },
    { revision: "second-before-evaluation" },
  );
  const observedEntries = (await listPendingReviews(namespace)).entries;
  const concurrent = await trackPendingReview(
    namespace,
    ref,
    {
      sha: "same-head",
      generation: "request:11",
      state: "pending",
    },
    { revision: "after-evaluation" },
  );

  await settlePendingReview(
    namespace,
    pendingReviewEntry({ name: kept.key }),
    {
      sha: "same-head",
      generation: "request:11",
      state: "pending",
    },
    { observedEntries },
  );

  assert.equal(namespace.records.has(kept.key), true);
  assert.equal(namespace.records.has(duplicate.key), false);
  assert.equal(namespace.records.has(concurrent.key), true);
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
