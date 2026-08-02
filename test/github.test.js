import assert from "node:assert/strict";
import { test } from "node:test";

import { RepoClient } from "../src/github.js";

function pullPage(start, count = 100) {
  return Array.from({ length: count }, (_, index) => ({
    number: start + index,
  }));
}

async function fetchPullPages(pages, options = {}) {
  const originalFetch = globalThis.fetch;
  const requestedPages = [];
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    requestedPages.push(page);
    return new Response(JSON.stringify(pages.get(page) ?? []), {
      status: 200,
    });
  };

  try {
    const client = new RepoClient(
      "installation-token",
      "connfy",
      "review-gate",
      "review-gate/codex-clean",
    );
    return {
      pulls: await client.openPullRequests(options),
      requestedPages,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("page-one traversal returns exact page multiples once", async (context) => {
  for (const count of [100, 200]) {
    await context.test(`${count} pull requests`, async () => {
      const pages = new Map([[1, pullPage(1)]]);
      if (count === 200) {
        pages.set(2, pullPage(101));
      }

      const { pulls, requestedPages } = await fetchPullPages(pages);

      assert.deepEqual(
        pulls.map((pull) => pull.number),
        Array.from({ length: count }, (_, index) => index + 1),
      );
      assert.deepEqual(requestedPages, count === 100 ? [1, 2] : [1, 2, 3]);
    });
  }
});

test("rotation traversal wraps and visits each data page once", async () => {
  const pages = new Map([
    [1, pullPage(1)],
    [2, pullPage(101)],
    [3, pullPage(201)],
  ]);

  const { pulls, requestedPages } = await fetchPullPages(pages, {
    pageOffset: 1,
    pageCursor: 1,
  });

  assert.deepEqual(requestedPages, [2, 3, 4, 1]);
  assert.deepEqual(
    pulls.map((pull) => pull.number),
    [...pullPage(101), ...pullPage(201), ...pullPage(1)].map(
      (pull) => pull.number,
    ),
  );
  assert.equal(new Set(pulls.map((pull) => pull.number)).size, 300);
});

test("empty page-one traversal stays empty", async () => {
  const { pulls, requestedPages } = await fetchPullPages(new Map());

  assert.deepEqual(pulls, []);
  assert.deepEqual(requestedPages, [1]);
});
