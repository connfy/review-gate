import assert from "node:assert/strict";
import { test } from "node:test";

import { reportCiBudgetStatus } from "../src/ci-budget.js";
import {
  getCachedInstallationAccess,
  getCachedInstallationToken,
  RepoClient,
} from "../src/github.js";

const client = () =>
  new RepoClient(
    "test-installation-token",
    "example-org",
    "example-repo",
    "review-gate/ci-budget",
  );

test("Actions HTTP reads address an exact attempt and cancellation only uses the ordinary run endpoint", async (context) => {
  const requests = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: options.method });
    assert.equal(options.headers["X-GitHub-Api-Version"], "2022-11-28");
    if (path.endsWith("/cancel")) {
      return new Response(null, { status: 202 });
    }
    if (path.endsWith("/jobs")) {
      return Response.json({
        total_count: 1,
        jobs: [{ id: 1, started_at: "2026-10-23T12:00:00Z" }],
      });
    }
    return Response.json({ id: 10, run_attempt: 2 });
  });
  const api = client();
  await api.workflowRun(10, 2);
  await api.workflowJobs(10, 2);
  await api.workflowRun(10);
  await api.cancelWorkflowRun(10);
  assert.deepEqual(requests, [
    {
      path: "/repos/example-org/example-repo/actions/runs/10/attempts/2",
      method: "GET",
    },
    {
      path: "/repos/example-org/example-repo/actions/runs/10/attempts/2/jobs",
      method: "GET",
    },
    { path: "/repos/example-org/example-repo/actions/runs/10", method: "GET" },
    {
      path: "/repos/example-org/example-repo/actions/runs/10/cancel",
      method: "POST",
    },
  ]);
});

test("workflow job reads follow pagination rather than omit a slow matrix job", async (context) => {
  const pages = [];
  context.mock.method(globalThis, "fetch", async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    return Response.json({
      total_count: 101,
      jobs: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
        id: page * 100 + index,
      })),
    });
  });
  assert.equal((await client().workflowJobs(10, 1)).length, 101);
  assert.deepEqual(pages, [1, 2]);
});

test("oversized and incomplete job lists stay unknown, never silently passing the budget", async (context) => {
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return Response.json({
      total_count: 1001,
      jobs: Array.from({ length: 100 }, (_, id) => ({ id })),
    });
  });
  await assert.rejects(
    client().workflowJobs(10, 1),
    /1,000-job inspection cap/,
  );
  assert.equal(requests, 10);
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ total_count: 2, jobs: [{ id: 1 }] }),
  );
  await assert.rejects(
    client().workflowJobs(10, 1),
    /incomplete workflow jobs list/,
  );
});

test("API permission failures preserve the HTTP status for safe cancellation handling", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { message: "Resource not accessible by integration" },
      { status: 403 },
    ),
  );
  await assert.rejects(
    client().cancelWorkflowRun(10),
    (error) => error.status === 403 && error.message.includes("403"),
  );
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 409 }),
  );
  await assert.rejects(
    client().cancelWorkflowRun(10),
    (error) => error.status === 409,
  );
});

test("CI status history is context-specific and fails visibly when its completeness cap is reached", async (context) => {
  const history = [
    { context: "another-check", state: "failure" },
    { context: "review-gate/ci-budget", state: "success" },
    { context: "REVIEW-GATE/CI-BUDGET", state: "failure" },
  ];
  context.mock.method(globalThis, "fetch", async () => Response.json(history));
  assert.deepEqual(
    (
      await client().statusesForContext("a".repeat(40), {
        requireComplete: true,
      })
    ).map((status) => status.state),
    ["success", "failure"],
  );
  context.mock.method(globalThis, "fetch", async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json(
      Array.from({ length: page <= 10 ? 100 : 1 }, () => ({
        context: "another-check",
      })),
    );
  });
  await assert.rejects(
    client().statusesForContext("a".repeat(40), { requireComplete: true }),
    /1,000-status inspection cap/,
  );
});

test("status history uses case-insensitive identity for review reads and sticky budget failures", async (context) => {
  const history = [
    { context: "review-gate/codex-clean", state: "failure" },
    {
      context: "REVIEW-GATE/CI-BUDGET",
      state: "failure",
      description: "Budget exceeded",
      target_url: "https://example.com/run",
    },
  ];
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(
      options.method,
      "GET",
      "existing failure must not be overwritten",
    );
    return Response.json(history);
  });
  const reviewClient = new RepoClient(
    "test-installation-token",
    "example-org",
    "example-repo",
    "REVIEW-GATE/CODEX-CLEAN",
  );
  assert.deepEqual(
    await reviewClient.latestStatusForContext("a".repeat(40)),
    history[0],
  );
  assert.equal(
    await reportCiBudgetStatus(client(), "a".repeat(40), {
      state: "success",
      description: "Within budget",
      targetUrl: "https://example.com/run",
    }),
    false,
  );
});

test("installation token caching preserves granted Actions permissions without changing existing token callers", async (context) => {
  // Generate a disposable test key in memory; no credential or key file is used.
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const pem =
    "-----BEGIN PRIVATE KEY-----\n" +
    btoa(String.fromCharCode(...bytes)) +
    "\n-----END PRIVATE KEY-----";
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(
      new URL(url).pathname,
      "/app/installations/12345/access_tokens",
    );
    assert.equal(options.method, "POST");
    requests += 1;
    return Response.json({
      token: "test-installation-token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { actions: "read", statuses: "write" },
    });
  });
  const access = await getCachedInstallationAccess("test-ci-app", pem, 12345);
  assert.equal(access.permissions.actions, "read");
  assert.equal(
    await getCachedInstallationToken("test-ci-app", pem, 12345),
    access.token,
  );
  assert.equal(requests, 1);
});
