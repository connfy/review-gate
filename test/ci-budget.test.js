import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { runScheduledSweep } from "../src/index.js";
import {
  ciBudgetTiming,
  ciRunRefFromEvent,
  evaluateCiRun,
  handleCiBudgetEvent,
  reportCiBudgetStatus,
  resolveCiBudgetConfig,
  sweepCiBudgetRuns,
} from "../src/ci-budget.js";

const start = Date.parse("2026-10-23T12:00:00Z");
const sha = "a".repeat(40);
const ref = {
  installationId: 42,
  owner: "example-org",
  repo: "example-repo",
  runId: 10,
  attempt: 1,
};
const iso = (offset) => new Date(start + offset).toISOString();

class FakeQueue {
  records = new Map();

  async get(key) {
    return this.records.get(key)?.value ?? null;
  }

  async put(key, value, options = {}) {
    this.records.set(key, { value, ...options });
  }

  async delete(key) {
    this.records.delete(key);
  }

  async list({ prefix, limit, cursor = "0" }) {
    const keys = [...this.records]
      .filter(([name]) => name.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, record]) => ({ name, metadata: record.metadata }));
    const offset = Number(cursor);
    return {
      keys: keys.slice(offset, offset + limit),
      list_complete: offset + limit >= keys.length,
      cursor: String(offset + limit),
    };
  }
}

function fixture({
  mode = "report",
  permissions = { actions: "write", statuses: "write" },
  run = {},
  jobs,
} = {}) {
  const env = {
    CI_BUDGET_MINUTES: "10",
    CI_BUDGET_MODE: mode,
    PENDING_REVIEWS: new FakeQueue(),
  };
  const statuses = new Map();
  const calls = { cancel: [], writes: [], reads: [] };
  const live = {
    id: ref.runId,
    run_attempt: ref.attempt,
    head_sha: sha,
    status: "in_progress",
    ...run,
  };
  const client = {
    async workflowRun(runId, attempt) {
      calls.reads.push([runId, attempt]);
      return { ...live };
    },
    async workflowJobs() {
      return (
        jobs ?? [
          { status: "in_progress", started_at: iso(0), completed_at: null },
        ]
      );
    },
    async statusesForContext(head) {
      return [...(statuses.get(head) ?? [])];
    },
    async setStatus(head, result) {
      calls.writes.push({ head, ...result });
      const history = statuses.get(head) ?? [];
      history.unshift({ ...result, target_url: result.targetUrl });
      statuses.set(head, history);
    },
    async cancelWorkflowRun(runId) {
      calls.cancel.push(runId);
    },
  };
  const options = {
    now: start + 600_001,
    getInstallationAccess: async () => ({
      token: "test-installation-token",
      permissions,
    }),
    clientFactory: (_token, owner, repo, statusContext) => {
      assert.equal(owner, ref.owner);
      assert.equal(repo, ref.repo);
      assert.equal(statusContext, "review-gate/ci-budget");
      return client;
    },
  };
  const evaluate = (overrides = {}) =>
    evaluateCiRun(env, ref, resolveCiBudgetConfig(env), {
      ...options,
      ...overrides,
    });
  return { env, client, calls, live, options, evaluate, statuses };
}

function payload(action = "in_progress") {
  return {
    action,
    repository: { owner: { login: ref.owner }, name: ref.repo },
    installation: { id: ref.installationId },
    workflow_run: { id: ref.runId, run_attempt: ref.attempt },
  };
}

test("CI budgeting is disabled without minutes; report is the safe enabled default", () => {
  assert.equal(resolveCiBudgetConfig().enabled, false);
  assert.equal(
    resolveCiBudgetConfig({ CI_BUDGET_MODE: "cancel" }).enabled,
    false,
  );
  const config = resolveCiBudgetConfig({ CI_BUDGET_MINUTES: "10" });
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "report");
  assert.equal(config.budgetMs, 600_000);
  assert.equal(
    resolveCiBudgetConfig({ CI_BUDGET_MINUTES: " 0.5 " }).budgetMs,
    30_000,
  );
});

test("unknown or invalid configuration disables enforcement instead of guessing", () => {
  for (const value of [
    "0",
    "-1",
    "NaN",
    "Infinity",
    "10minutes",
    "1e2",
    "0x10",
    "0.0000001",
    "99999999999999999999",
  ]) {
    const config = resolveCiBudgetConfig({
      CI_BUDGET_MINUTES: value,
      CI_BUDGET_MODE: "cancel",
    });
    assert.equal(config.enabled, false, value);
    assert.match(config.error, /CI_BUDGET_MINUTES/);
  }
  for (const overrides of [
    { CI_BUDGET_MODE: "CANCEL" },
    { CI_BUDGET_MODE: "" },
    { SWEEP_MAX_CI_RUNS: "0" },
    { SWEEP_MAX_CI_RUNS: "2.5" },
    { CI_BUDGET_STATUS_CONTEXT: "" },
    { CI_BUDGET_STATUS_CONTEXT: "review-gate/codex-clean" },
    { STATUS_CONTEXT: "custom", CI_BUDGET_STATUS_CONTEXT: "custom" },
  ]) {
    assert.equal(
      resolveCiBudgetConfig({ CI_BUDGET_MINUTES: "10", ...overrides }).enabled,
      false,
    );
  }
});

test("only supported workflow-run actions with complete coordinates enter the queue", () => {
  for (const action of ["requested", "in_progress", "completed"]) {
    assert.deepEqual(ciRunRefFromEvent("workflow_run", payload(action)), ref);
  }
  assert.equal(ciRunRefFromEvent("workflow_run", payload("unknown")), null);
  assert.equal(ciRunRefFromEvent("workflow_job", payload()), null);
  assert.equal(
    ciRunRefFromEvent("workflow_run", { ...payload(), installation: null }),
    null,
  );
  assert.equal(
    ciRunRefFromEvent("workflow_run", {
      ...payload(),
      workflow_run: { id: 10 },
    }),
    null,
  );
});

test("the deadline excludes initial queue time and includes the whole serial pipeline", () => {
  const run = {
    status: "completed",
    created_at: iso(-3_600_000),
    run_started_at: iso(-3_600_000),
    updated_at: iso(86_400_000),
  };
  const jobs = [
    { status: "completed", started_at: iso(0), completed_at: iso(300_000) },
    {
      status: "completed",
      started_at: iso(300_000),
      completed_at: iso(600_001),
    },
    { status: "completed", conclusion: "skipped", started_at: iso(-3_600_000) },
  ];
  const timing = ciBudgetTiming(run, jobs, 600_000, start + 86_400_000);
  assert.equal(timing.deadline, start + 600_000);
  assert.equal(timing.elapsedMs, 600_001);
  assert.equal(timing.exceeded, true);
});

test("parallel jobs count wall time once; exactly the budget is allowed", () => {
  const jobs = [1, 2, 3].map(() => ({
    status: "completed",
    started_at: iso(0),
    completed_at: iso(600_000),
  }));
  assert.equal(
    ciBudgetTiming({ status: "completed" }, jobs, 600_000, start + 3_600_000)
      .exceeded,
    false,
  );
  assert.equal(
    ciBudgetTiming({ status: "in_progress" }, jobs, 600_000, start + 600_001)
      .exceeded,
    true,
  );
  assert.equal(
    ciBudgetTiming(
      { status: "in_progress" },
      [{ status: "queued", started_at: iso(-3_600_000) }],
      600_000,
      start + 3_600_000,
    ).deadline,
    null,
  );
});

test("missing or inconsistent timing stays visible instead of triggering cancellation", () => {
  for (const jobs of [
    [{ status: "queued", started_at: null }],
    [{ status: "in_progress", started_at: null }],
    [{ status: "in_progress", started_at: iso(700_000) }],
    [{ status: "completed", started_at: iso(0), completed_at: null }],
    [{ status: "completed", started_at: iso(0), completed_at: iso(-1) }],
  ]) {
    assert.throws(
      () =>
        ciBudgetTiming({ status: "completed" }, jobs, 600_000, start + 600_001),
      /CI budget/,
    );
  }
});

test("report mode posts a linked breach and never calls cancellation", async () => {
  const { evaluate, calls } = fixture();
  const result = await evaluate();
  assert.equal(result.exceeded, true);
  assert.equal(calls.writes[0].head, sha);
  assert.equal(calls.writes[0].state, "failure");
  assert.match(
    calls.writes[0].description,
    /review for excess and optimize, not a longer timeout/,
  );
  assert.equal(
    calls.writes[0].targetUrl,
    "https://github.com/example-org/example-repo/actions/runs/10/attempts/1",
  );
  assert.deepEqual(calls.cancel, []);
});

test("normal runs proactively reach success and terminal completion clears the queue", async () => {
  const f = fixture({
    jobs: [
      { status: "completed", started_at: iso(0), completed_at: iso(599_000) },
    ],
  });
  await f.evaluate({ now: start + 600_000 });
  assert.equal(f.calls.writes[0].state, "success");
  f.live.status = "completed";
  await f.evaluate({ now: start + 3_600_000 });
  await sweepCiBudgetRuns(f.env, { ...f.options, now: start + 3_600_000 });
  assert.equal(f.calls.writes.length, 1);
  assert.equal(f.env.PENDING_REVIEWS.records.size, 0);
});

test("cancel mode cancels only a live over-budget attempt and deduplicates repeated events and sweeps", async () => {
  const f = fixture({ mode: "cancel" });
  await handleCiBudgetEvent(f.env, "workflow_run", payload(), f.options);
  await handleCiBudgetEvent(f.env, "workflow_run", payload(), f.options);
  const summary = await sweepCiBudgetRuns(f.env, {
    ...f.options,
    now: start + 900_002,
  });
  assert.equal(summary.runs, 1);
  assert.equal(f.calls.writes.length, 1);
  assert.deepEqual(f.calls.cancel, [10]);
  f.live.status = "completed";
  f.client.workflowJobs = async () => [
    { status: "completed", started_at: iso(0), completed_at: iso(601_000) },
  ];
  await handleCiBudgetEvent(f.env, "workflow_run", payload("completed"), {
    ...f.options,
    now: start + 900_002,
  });
  await sweepCiBudgetRuns(f.env, { ...f.options, now: start + 1_080_003 });
  assert.equal(f.env.PENDING_REVIEWS.records.size, 0);
});

test("completion discovered by a sweep still reports a breach without cancelling", async () => {
  const f = fixture({ mode: "cancel" });
  await f.evaluate({ now: start + 1 });
  await sweepCiBudgetRuns(f.env, { ...f.options, now: start + 2 });
  f.live.status = "completed";
  f.client.workflowJobs = async () => [
    { status: "completed", started_at: iso(0), completed_at: iso(700_000) },
  ];
  const summary = await sweepCiBudgetRuns(f.env, {
    ...f.options,
    now: start + 900_000,
  });
  assert.equal(summary.runs, 1);
  assert.equal(summary.updated, 1);
  assert.equal(f.calls.writes.at(-1).state, "failure");
  assert.deepEqual(f.calls.cancel, []);
  assert.equal(f.env.PENDING_REVIEWS.records.size, 0);
});

test("short sibling workflows and reruns cannot erase a SHA's budget breach", async () => {
  const f = fixture();
  await f.evaluate();
  f.client.workflowJobs = async () => [
    { status: "completed", started_at: iso(0), completed_at: iso(10_000) },
  ];
  f.live.status = "completed";
  await f.evaluate();
  f.live.id = 20;
  await evaluateCiRun(
    f.env,
    { ...ref, runId: 20 },
    resolveCiBudgetConfig(f.env),
    f.options,
  );
  assert.equal(f.calls.writes.length, 1);
  assert.equal(f.calls.writes[0].state, "failure");
});

test("a success publication repairs an overlapping breach from status history", async () => {
  const f = fixture();
  let reads = 0;
  const breach = {
    state: "failure",
    description: "CI exceeded 10m budget; optimize.",
    target_url: "https://github.com/example-org/example-repo/actions/runs/20",
  };
  f.client.statusesForContext = async () =>
    ++reads === 1 ? [] : [{ state: "success" }, breach];
  await reportCiBudgetStatus(f.client, sha, {
    state: "success",
    description: "Within budget",
    targetUrl: "https://github.com/example-org/example-repo/actions/runs/10",
  });
  assert.deepEqual(
    f.calls.writes.map((status) => status.state),
    ["success", "failure"],
  );
  assert.equal(f.calls.writes.at(-1).targetUrl, breach.target_url);
});

test("no cancellation occurs before the deadline, after completion, or for a newer attempt", async () => {
  for (const change of ["within", "completed", "rerun", "waiting"]) {
    const f = fixture({ mode: "cancel" });
    if (change !== "within") {
      f.client.workflowRun = async (_id, attempt) =>
        attempt
          ? { ...f.live }
          : {
              ...f.live,
              status: change === "rerun" ? "in_progress" : change,
              run_attempt: change === "rerun" ? 2 : 1,
            };
    }
    await f.evaluate({
      now: start + (change === "within" ? 600_000 : 600_001),
    });
    assert.deepEqual(f.calls.cancel, [], change);
  }
});

test("missing Actions permission fails safe even when public API reads would succeed", async () => {
  const f = fixture({ mode: "cancel", permissions: {} });
  await assert.rejects(
    f.evaluate(),
    /Actions: read permission is missing or unapproved/,
  );
  assert.deepEqual(f.calls.reads, []);
  assert.deepEqual(f.calls.cancel, []);
  assert.equal(f.env.PENDING_REVIEWS.records.size, 1);
});

test("cancel mode with only Actions read reports the breach and logs the missing approval", async (context) => {
  const logs = [];
  context.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  const f = fixture({ mode: "cancel", permissions: { actions: "read" } });
  await f.evaluate();
  assert.equal(f.calls.writes[0].state, "failure");
  assert.deepEqual(f.calls.cancel, []);
  assert.match(
    logs.join(" "),
    /Actions: write permission is missing or unapproved/,
  );
});

test("failed status writes cannot trigger cancellation and remain retryable", async () => {
  const f = fixture({ mode: "cancel" });
  f.client.setStatus = async () => {
    throw new Error("Commit statuses: write missing");
  };
  await assert.rejects(f.evaluate(), /Commit statuses/);
  assert.deepEqual(f.calls.cancel, []);
  assert.equal(f.env.PENDING_REVIEWS.records.size, 1);
});

test("a previous failure cannot authorize cancellation without approved status-write permission", async (context) => {
  const logs = [];
  context.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  const f = fixture({ mode: "cancel", permissions: { actions: "write" } });
  f.statuses.set(sha, [
    {
      state: "failure",
      description: "Budget exceeded",
      target_url: "https://example.com/run",
    },
  ]);
  await f.evaluate();
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.cancel, []);
  assert.match(
    logs.join(" "),
    /Commit statuses: write permission is missing or unapproved/,
  );
});

test("webhook redelivery does not rewrite an existing queue key", async () => {
  const f = fixture();
  let writes = 0;
  const originalPut = f.env.PENDING_REVIEWS.put.bind(f.env.PENDING_REVIEWS);
  f.env.PENDING_REVIEWS.put = async (...args) => {
    writes += 1;
    return originalPut(...args);
  };
  await f.evaluate();
  await f.evaluate();
  assert.equal(writes, 1);
});

test("changing the deployment budget recomputes previously scheduled deadlines", async () => {
  const f = fixture({ mode: "cancel" });
  await f.evaluate({ now: start + 1 });
  await sweepCiBudgetRuns(f.env, { ...f.options, now: start + 2 });
  f.env.CI_BUDGET_MINUTES = "5";
  const summary = await sweepCiBudgetRuns(f.env, {
    ...f.options,
    now: start + 300_001,
  });
  assert.equal(summary.runs, 1);
  assert.equal(summary.cancelled, 1);
});

test("CI queue pagination reaches due runs on later pages and caps even empty cursor pages", async (context) => {
  context.mock.method(console, "warn", () => {});
  const f = fixture();
  const key = "ci-budget-run:v1:42:example-org:example-repo:10:1";
  const cursors = [];
  f.env.PENDING_REVIEWS.list = async ({ cursor }) => {
    cursors.push(cursor);
    return cursor
      ? {
          keys: [
            {
              name: key,
              metadata: { ...ref, nextCheckAt: 0, budgetMs: 600_000 },
            },
          ],
          list_complete: true,
        }
      : { keys: [], list_complete: false, cursor: "next" };
  };
  assert.equal((await sweepCiBudgetRuns(f.env, f.options)).runs, 1);
  assert.deepEqual(cursors, [undefined, "next"]);
  let pages = 0;
  f.env.PENDING_REVIEWS.list = async () => {
    pages += 1;
    return { keys: [], list_complete: false, cursor: "more" };
  };
  const summary = await sweepCiBudgetRuns(f.env, f.options);
  assert.equal(pages, 10);
  assert.equal(summary.limited, true);
});

test("cancellation completion ignores never-started cancelled jobs and settles the queue", async () => {
  const f = fixture({ mode: "cancel" });
  await f.evaluate();
  f.live.status = "completed";
  f.client.workflowJobs = async () => [
    {
      status: "completed",
      conclusion: "cancelled",
      started_at: iso(0),
      completed_at: iso(601_000),
    },
    {
      status: "completed",
      conclusion: "cancelled",
      started_at: null,
      completed_at: iso(601_000),
    },
  ];
  const summary = await sweepCiBudgetRuns(f.env, {
    ...f.options,
    now: start + 900_000,
  });
  assert.equal(summary.errors, 0);
  assert.equal(f.env.PENDING_REVIEWS.records.size, 0);
  assert.deepEqual(f.calls.cancel, [10]);
});

test("verified active records renew retention but API failures preserve the previous expiry", async (context) => {
  context.mock.method(console, "error", () => {});
  const f = fixture({ mode: "cancel" });
  await f.evaluate();
  const runRecord = () =>
    [...f.env.PENDING_REVIEWS.records].find(([key]) =>
      key.startsWith("ci-budget-run:"),
    )[1];
  const firstExpiration = runRecord().expiration;
  assert.equal(
    firstExpiration,
    Math.floor(f.options.now / 1000) + 86_400 + 600,
  );
  const receipt = [...f.env.PENDING_REVIEWS.records].find(([key]) =>
    key.startsWith("ci-budget-cancel:"),
  )[1];
  assert.equal(receipt.expirationTtl, 86_400 + 600);
  await sweepCiBudgetRuns(f.env, { ...f.options, now: start + 900_002 });
  const renewedExpiration = runRecord().expiration;
  assert.ok(renewedExpiration > firstExpiration);
  const denied = {
    ...f.options,
    getInstallationAccess: async () => {
      throw new Error("Installation unavailable");
    },
  };
  await sweepCiBudgetRuns(f.env, { ...denied, now: start + 1_200_003 });
  await sweepCiBudgetRuns(f.env, { ...denied, now: start + 1_500_004 });
  assert.equal(runRecord().expiration, renewedExpiration);
  assert.equal(runRecord().metadata.expiresAt, renewedExpiration);
});

test("denied cancellation is not remembered as accepted; a later retry can succeed", async () => {
  const f = fixture({ mode: "cancel" });
  f.client.cancelWorkflowRun = async () => {
    throw Object.assign(new Error("Actions write denied (403)"), {
      status: 403,
    });
  };
  await assert.rejects(f.evaluate(), /Actions write denied/);
  f.client.cancelWorkflowRun = async (id) => f.calls.cancel.push(id);
  await f.evaluate();
  assert.deepEqual(f.calls.cancel, [10]);
});

test("a completion/cancel conflict is harmless and never force-cancelled", async () => {
  const f = fixture({ mode: "cancel" });
  f.client.cancelWorkflowRun = async () => {
    throw Object.assign(new Error("Conflict"), { status: 409 });
  };
  const result = await f.evaluate();
  assert.equal(result.cancelled, false);
  assert.equal(f.calls.writes[0].state, "failure");
});

test("disabled and invalid deployments make no KV or GitHub calls and log invalid settings", async (context) => {
  const logs = [];
  context.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  const f = fixture({ mode: "cancel" });
  delete f.env.CI_BUDGET_MINUTES;
  const trap = new Proxy(
    {},
    {
      get() {
        throw new Error("unexpected KV call");
      },
    },
  );
  f.env.PENDING_REVIEWS = trap;
  assert.equal(
    await handleCiBudgetEvent(f.env, "workflow_run", payload(), f.options),
    null,
  );
  assert.equal((await sweepCiBudgetRuns(f.env, f.options)).enabled, false);
  f.env.CI_BUDGET_MINUTES = "10";
  f.env.CI_BUDGET_MODE = "unknown";
  assert.equal(
    await handleCiBudgetEvent(f.env, "workflow_run", payload(), f.options),
    null,
  );
  assert.equal((await sweepCiBudgetRuns(f.env, f.options)).enabled, false);
  assert.match(logs.join(" "), /CI budget disabled: CI_BUDGET_MODE/);
  assert.deepEqual(f.calls.reads, []);
});

test("enabled budgeting without a durable queue logs an error and never cancels", async (context) => {
  context.mock.method(console, "error", () => {});
  const f = fixture({ mode: "cancel" });
  delete f.env.PENDING_REVIEWS;
  await assert.rejects(f.evaluate(), /KV binding is required/);
  assert.equal((await sweepCiBudgetRuns(f.env, f.options)).errors, 1);
  assert.deepEqual(f.calls.cancel, []);
});

test("deadline sweeps skip not-yet-due runs and bound work independently of review queues", async (context) => {
  context.mock.method(console, "warn", () => {});
  const f = fixture();
  await f.evaluate({ now: start + 1 });
  await sweepCiBudgetRuns(f.env, { ...f.options, now: start + 2 });
  const before = await sweepCiBudgetRuns(f.env, {
    ...f.options,
    now: start + 600_000,
  });
  assert.equal(before.runs, 0);
  for (let id = 11; id <= 14; id += 1) {
    await handleCiBudgetEvent(
      f.env,
      "workflow_run",
      {
        ...payload(),
        workflow_run: { id, run_attempt: 1 },
      },
      {
        ...f.options,
        now: start + 1,
        clientFactory: () => ({
          ...f.client,
          workflowRun: async () => ({ ...f.live, id }),
        }),
      },
    );
  }
  const summary = await sweepCiBudgetRuns(f.env, {
    ...f.options,
    clientFactory: () => ({
      ...f.client,
      workflowRun: async (id) => ({ ...f.live, id }),
    }),
  });
  assert.equal(summary.queued, 5);
  assert.equal(summary.runs, 2);
  assert.equal(summary.limited, true);
});

test("a failed installation backs off so another due run gets a sweep slot", async (context) => {
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
  const f = fixture();
  f.env.SWEEP_MAX_CI_RUNS = "1";
  const key = "ci-budget-run:v1:42:example-org:example-repo:";
  for (const runId of [10, 11]) {
    await f.env.PENDING_REVIEWS.put(`${key}${runId}:1`, "queued", {
      metadata: { ...ref, runId, nextCheckAt: 0 },
    });
  }
  const options = {
    ...f.options,
    getInstallationAccess: async () => {
      throw new Error("Installation unavailable");
    },
  };
  assert.equal((await sweepCiBudgetRuns(f.env, options)).errors, 1);
  assert.equal(
    f.env.PENDING_REVIEWS.records.get(`${key}10:1`).metadata.nextCheckAt,
    start + 780_001,
  );
  await sweepCiBudgetRuns(f.env, options);
  assert.equal(
    f.env.PENDING_REVIEWS.records.get(`${key}11:1`).metadata.nextCheckAt,
    start + 780_001,
  );
});

test("CI and both review sweeps retain separate budgets", async () => {
  const order = [];
  const summary = await runScheduledSweep(
    {},
    {},
    {
      ciBudgetSweep: async () => {
        order.push("ci");
        return { runs: 2, errors: 1, limited: true };
      },
      pendingSweep: async () => {
        order.push("pending");
        return {
          pullRequests: 2,
          updated: 0,
          unchanged: 2,
          errors: 0,
          limited: false,
          processedRefs: [],
        };
      },
      openSweep: async () => {
        order.push("open");
        return {
          pullRequests: 2,
          updated: 0,
          unchanged: 2,
          errors: 0,
          limited: false,
        };
      },
    },
  );
  assert.deepEqual(order, ["ci", "pending", "open"]);
  assert.equal(summary.pullRequests, 4);
  assert.equal(summary.ciBudget.runs, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.limited, true);
});

test("the Worker verifies signatures before routing Actions events", async () => {
  const env = { GITHUB_WEBHOOK_SECRET: "test-webhook-secret" };
  const body = JSON.stringify(payload());
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const signature =
    "sha256=" +
    [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  const tasks = [];
  const request = (sig) =>
    new Request("https://example.com/webhook", {
      method: "POST",
      body,
      headers: { "x-github-event": "workflow_run", "x-hub-signature-256": sig },
    });
  assert.equal(
    (
      await worker.fetch(request("invalid"), env, {
        waitUntil: (task) => tasks.push(task),
      })
    ).status,
    401,
  );
  assert.equal(tasks.length, 0);
  assert.equal(
    (
      await worker.fetch(request(signature), env, {
        waitUntil: (task) => tasks.push(task),
      })
    ).status,
    202,
  );
  await Promise.all(tasks);
});
