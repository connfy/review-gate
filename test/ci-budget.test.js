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

function payload(action = "in_progress", run = {}) {
  return {
    action,
    repository: { owner: { login: ref.owner }, name: ref.repo },
    installation: { id: ref.installationId },
    workflow_run: {
      id: ref.runId,
      run_attempt: ref.attempt,
      head_sha: sha,
      status:
        { requested: "queued", completed: "completed" }[action] ??
        "in_progress",
      conclusion: action === "completed" ? "success" : null,
      ...run,
    },
  };
}

const kvTrap = () =>
  new Proxy(
    {},
    {
      get() {
        throw new Error("unexpected KV call");
      },
    },
  );

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
    { CI_BUDGET_STATUS_CONTEXT: "REVIEW-GATE/CODEX-CLEAN" },
    { STATUS_CONTEXT: "custom", CI_BUDGET_STATUS_CONTEXT: "custom" },
    {
      STATUS_CONTEXT: "Custom/Review",
      CI_BUDGET_STATUS_CONTEXT: "CUSTOM/review",
    },
    { STATUS_CONTEXT: "REVIEW-GATE/CI-BUDGET" },
  ]) {
    assert.equal(
      resolveCiBudgetConfig({ CI_BUDGET_MINUTES: "10", ...overrides }).enabled,
      false,
    );
  }
});

test("a case-variant review context cannot publish budget success over a failed review gate", async (context) => {
  const f = fixture({ mode: "cancel" });
  f.env.CI_BUDGET_STATUS_CONTEXT = "REVIEW-GATE/CODEX-CLEAN";
  const reviewFailure = {
    context: "review-gate/codex-clean",
    state: "failure",
    description: "Review required",
  };
  const history = [reviewFailure];
  const requests = [];
  const logs = [];
  context.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  // Exercise the webhook handler and real RepoClient against a GitHub-shaped
  // history. Before the configuration guard this writes a proactive success.
  context.mock.method(globalThis, "fetch", async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: options.method });
    if (options.method === "POST") {
      const status = JSON.parse(options.body);
      history.unshift(status);
      return Response.json(status, { status: 201 });
    }
    if (path.endsWith("/statuses")) return Response.json(history);
    if (path.endsWith("/jobs")) {
      return Response.json({
        total_count: 1,
        jobs: [{ status: "in_progress", started_at: iso(0) }],
      });
    }
    return Response.json(f.live);
  });
  const options = {
    now: start + 1,
    getInstallationAccess: f.options.getInstallationAccess,
  };
  await handleCiBudgetEvent(f.env, "workflow_run", payload(), options);
  const summary = await sweepCiBudgetRuns(f.env, options);
  assert.deepEqual(history, [reviewFailure]);
  assert.deepEqual(requests, []);
  assert.equal(f.env.PENDING_REVIEWS.records.size, 0);
  assert.equal(summary.enabled, false);
  assert.match(logs.join(" "), /CI budget disabled:.*case-insensitive/);
});

test("only supported workflow-run actions with complete coordinates are routed to CI budgeting", () => {
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

test("another run on the same SHA with the same verdict publishes nothing", async () => {
  const f = fixture();
  await f.evaluate({ now: start + 60_000 });
  f.live.id = 20;
  await evaluateCiRun(
    f.env,
    { ...ref, runId: 20 },
    resolveCiBudgetConfig(f.env),
    { ...f.options, now: start + 60_000 },
  );
  // Only the link would differ; republishing it emits another status event.
  assert.deepEqual(
    f.calls.writes.map((status) => [status.state, status.targetUrl]),
    [
      [
        "success",
        "https://github.com/example-org/example-repo/actions/runs/10/attempts/1",
      ],
    ],
  );
});

test("budget status writes cannot sustain a status-triggered workflow loop", async () => {
  // GitHub starts one run of an `on: status` workflow per status event in the
  // repository and attributes it to the default-branch HEAD. A job `if:` skips
  // every status except the one the workflow serves.
  const env = {
    CI_BUDGET_MINUTES: "10",
    CI_BUDGET_MODE: "cancel",
    PENDING_REVIEWS: new FakeQueue(),
  };
  const runs = new Map();
  const statuses = [];
  const deliveries = [];
  const next = { requested: "in_progress", in_progress: "completed" };
  const trigger = (executes) => {
    const id = 100 + runs.size;
    runs.set(id, { executes, action: null });
    deliveries.push({ id, action: "requested" });
  };
  const stateOf = (id) => {
    const { executes, action } = runs.get(id);
    const done = action === "completed";
    const job = executes
      ? {
          status: done ? "completed" : action === "requested" ? "queued" : action,
          conclusion: done ? "success" : null,
          started_at: action === "requested" ? null : iso(0),
          completed_at: done ? iso(120_000) : null,
        }
      : {
          status: done ? "completed" : "queued",
          conclusion: done ? "skipped" : null,
          started_at: null,
          completed_at: null,
        };
    return {
      run: {
        id,
        run_attempt: 1,
        head_sha: sha,
        event: "status",
        status: action === "requested" ? "queued" : action,
        conclusion: done ? (executes ? "success" : "skipped") : null,
      },
      jobs: [job],
    };
  };
  const client = {
    async workflowRun(id) {
      return stateOf(id).run;
    },
    async workflowJobs(id) {
      return stateOf(id).jobs;
    },
    async statusesForContext() {
      return [...statuses];
    },
    async setStatus(_head, status) {
      statuses.unshift({ ...status, target_url: status.targetUrl });
      trigger(false);
    },
    async cancelWorkflowRun() {},
  };
  const options = {
    now: start + 180_000,
    getInstallationAccess: async () => ({
      token: "test-installation-token",
      permissions: { actions: "write", statuses: "write" },
    }),
    clientFactory: () => client,
  };
  // An external status event starts the one run whose job really executes.
  trigger(true);
  for (let delivered = 0; deliveries.length > 0 && delivered < 60; delivered += 1) {
    const { id, action } = deliveries.shift();
    runs.get(id).action = action;
    await handleCiBudgetEvent(
      env,
      "workflow_run",
      payload(action, stateOf(id).run),
      options,
    );
    if (next[action]) {
      deliveries.push({ id, action: next[action] });
    }
  }
  assert.equal(deliveries.length, 0, "the status/run chain must terminate");
  assert.deepEqual(
    statuses.map((status) => status.state),
    ["success"],
  );
  assert.equal(runs.size, 2);
  assert.deepEqual([...env.PENDING_REVIEWS.records.keys()], []);
});

test("requested deliveries cost no KV or GitHub API call", async () => {
  const f = fixture();
  f.env.PENDING_REVIEWS = kvTrap();
  let accessRequests = 0;
  await handleCiBudgetEvent(f.env, "workflow_run", payload("requested"), {
    ...f.options,
    getInstallationAccess: async () => {
      accessRequests += 1;
      return f.options.getInstallationAccess();
    },
  });
  assert.equal(accessRequests, 0);
  assert.deepEqual(f.calls.reads, []);
  assert.deepEqual(f.calls.writes, []);
});

test("a skipped run publishes nothing and is settled without reading jobs", async () => {
  const f = fixture({ run: { status: "completed", conclusion: "skipped" } });
  let accessRequests = 0;
  let jobReads = 0;
  f.client.workflowJobs = async () => {
    jobReads += 1;
    return [];
  };
  const options = {
    ...f.options,
    getInstallationAccess: async () => {
      accessRequests += 1;
      return f.options.getInstallationAccess();
    },
  };
  // The signed terminal payload alone proves that no job executed.
  await handleCiBudgetEvent(
    f.env,
    "workflow_run",
    payload("completed", { conclusion: "skipped" }),
    options,
  );
  assert.equal(accessRequests, 0);
  assert.deepEqual(f.calls.reads, []);
  assert.deepEqual(f.calls.writes, []);
  assert.equal(f.env.PENDING_REVIEWS.records.size, 0);
  // An attempt queued while it was in progress settles from the run object.
  await f.env.PENDING_REVIEWS.put(
    "ci-budget-run:v1:42:example-org:example-repo:10:1",
    "queued",
    { metadata: { ...ref, budgetMs: 600_000, nextCheckAt: 0 } },
  );
  const summary = await sweepCiBudgetRuns(f.env, options);
  assert.equal(summary.errors, 0);
  assert.equal(f.calls.reads.length, 1);
  assert.equal(jobReads, 0);
  assert.deepEqual(f.calls.writes, []);
  assert.equal(f.env.PENDING_REVIEWS.records.size, 0);
});

test("attempts that have not started a job publish no budget claim", async () => {
  const cancelled = fixture({
    run: { status: "completed", conclusion: "cancelled" },
    jobs: [
      {
        status: "completed",
        conclusion: "cancelled",
        started_at: null,
        completed_at: iso(1_000),
      },
    ],
  });
  await handleCiBudgetEvent(
    cancelled.env,
    "workflow_run",
    payload("completed", { conclusion: "cancelled" }),
    cancelled.options,
  );
  assert.deepEqual(cancelled.calls.writes, []);
  assert.equal(cancelled.env.PENDING_REVIEWS.records.size, 0);
  // Waiting for a runner: still tracked for its deadline, but nothing to claim.
  const queued = fixture({ jobs: [{ status: "queued", started_at: null }] });
  await handleCiBudgetEvent(queued.env, "workflow_run", payload(), queued.options);
  assert.deepEqual(queued.calls.writes, []);
  assert.equal(queued.env.PENDING_REVIEWS.records.size, 1);
});

test("completed deliveries settle the attempt and queue only failed evaluations", async () => {
  const f = fixture({
    jobs: [{ status: "in_progress", started_at: iso(0) }],
  });
  await handleCiBudgetEvent(f.env, "workflow_run", payload(), {
    ...f.options,
    now: start + 60_000,
  });
  assert.equal(f.env.PENDING_REVIEWS.records.size, 1);
  f.live.status = "completed";
  f.client.workflowJobs = async () => [
    { status: "completed", started_at: iso(0), completed_at: iso(120_000) },
  ];
  const attemptReads = f.calls.reads.length;
  await handleCiBudgetEvent(f.env, "workflow_run", payload("completed"), {
    ...f.options,
    now: start + 180_000,
  });
  // The signed terminal payload replaces the attempt read.
  assert.equal(f.calls.reads.length, attemptReads);
  assert.equal(f.env.PENDING_REVIEWS.records.size, 0);
  assert.deepEqual(
    f.calls.writes.map((status) => status.state),
    ["success"],
  );
  // A job list that has not caught up to completion is retried by the sweep.
  const lagging = fixture({
    run: { status: "completed" },
    jobs: [{ status: "in_progress", started_at: iso(0) }],
  });
  await assert.rejects(
    handleCiBudgetEvent(
      lagging.env,
      "workflow_run",
      payload("completed"),
      lagging.options,
    ),
    /retry required/,
  );
  assert.equal(lagging.env.PENDING_REVIEWS.records.size, 1);
  lagging.client.workflowJobs = async () => [
    { status: "completed", started_at: iso(0), completed_at: iso(700_000) },
  ];
  const summary = await sweepCiBudgetRuns(lagging.env, {
    ...lagging.options,
    now: start + 900_000,
  });
  assert.equal(summary.updated, 1);
  assert.equal(lagging.calls.writes[0].state, "failure");
  assert.equal(lagging.env.PENDING_REVIEWS.records.size, 0);
});

test("a finished attempt leaves no queue entry when its deliveries arrive out of order or race KV's write limit", async () => {
  const f = fixture({ run: { status: "completed", conclusion: "skipped" } });
  const queue = f.env.PENDING_REVIEWS;
  await handleCiBudgetEvent(
    f.env,
    "workflow_run",
    payload("completed", { conclusion: "skipped" }),
    f.options,
  );
  // in_progress processed after completion still enqueues first, then settles.
  await handleCiBudgetEvent(f.env, "workflow_run", payload(), f.options);
  assert.equal(queue.records.size, 0);
  // The delete right after that enqueue can be rejected by KV's per-key limit.
  const pauses = [];
  let rejections = 1;
  const remove = queue.delete.bind(queue);
  queue.delete = async (key) => {
    if (rejections-- > 0) {
      throw new Error("KV write limit");
    }
    return remove(key);
  };
  await handleCiBudgetEvent(f.env, "workflow_run", payload(), {
    ...f.options,
    sleepFn: async (ms) => pauses.push(ms),
  });
  assert.deepEqual(pauses, [1_000]);
  assert.equal(queue.records.size, 0);
  assert.deepEqual(f.calls.writes, []);
});

test("status-triggered runs stay enforced at the budget", async () => {
  // Pins that runs GitHub attributes to the default-branch HEAD get no
  // exception from queueing, reporting, or cancellation.
  const f = fixture({ mode: "cancel", run: { event: "status" } });
  await handleCiBudgetEvent(
    f.env,
    "workflow_run",
    payload("in_progress", { event: "status" }),
    { ...f.options, now: start + 1 },
  );
  await sweepCiBudgetRuns(f.env, { ...f.options, now: start + 2 });
  const summary = await sweepCiBudgetRuns(f.env, {
    ...f.options,
    now: start + 600_001,
  });
  assert.equal(summary.cancelled, 1);
  assert.deepEqual(f.calls.cancel, [10]);
  assert.deepEqual(
    f.calls.writes.map((status) => status.state),
    ["success", "failure"],
  );
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

test("bounded CI queue enumeration resumes past 10,000 not-yet-due runs and wraps", async (context) => {
  context.mock.method(console, "warn", () => {});
  const f = fixture();
  f.env.SWEEP_MAX_CI_RUNS = "1";
  const queue = f.env.PENDING_REVIEWS;
  const runKey = (installationId) =>
    `ci-budget-run:v1:${installationId}:example-org:example-repo:10:1`;
  // Earlier installations need no evaluation yet, but must not hide an overdue
  // run beyond the per-sweep enumeration bound.
  for (
    let installationId = 10_000;
    installationId < 20_000;
    installationId += 1
  ) {
    await queue.put(runKey(installationId), "queued", {
      metadata: {
        ...ref,
        installationId,
        budgetMs: 600_000,
        nextCheckAt: start + 3_600_000,
      },
    });
  }
  await queue.put(runKey(ref.installationId), "queued", {
    metadata: { ...ref, budgetMs: 600_000, nextCheckAt: 0 },
  });
  const cursors = [];
  const list = queue.list.bind(queue);
  queue.list = async (options) => {
    cursors.push(options.cursor);
    return list(options);
  };
  const first = await sweepCiBudgetRuns(f.env, f.options);
  assert.equal(first.queued, 10_000);
  assert.equal(first.runs, 0);
  assert.equal(first.limited, true);
  assert.equal(cursors.length, 10);
  const second = await sweepCiBudgetRuns(f.env, f.options);
  assert.equal(second.queued, 1);
  assert.equal(second.runs, 1);
  assert.equal(second.errors, 0);
  assert.equal(cursors[10], "10000");
  assert.equal(f.calls.writes[0].state, "failure");
  // Completion of enumeration wraps; an earlier entry becoming due is served.
  queue.records.get(runKey(10_000)).metadata.nextCheckAt = 0;
  const third = await sweepCiBudgetRuns(f.env, f.options);
  assert.equal(cursors[11], undefined);
  assert.equal(third.runs, 1);
  assert.equal(third.errors, 0);
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
  f.env.PENDING_REVIEWS = kvTrap();
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
