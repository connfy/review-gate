import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";

import worker, {
  reportStatus,
  sweepOpenPullRequests,
  sweepPendingPullRequests,
} from "../src/index.js";
import { evaluateGate, resolveConfig } from "../src/gate.js";
import { getCachedAppBotId } from "../src/github.js";
import { pendingReviewKey } from "../src/pending.js";

const ownActorId = 7654321;
const config = resolveConfig();
const baseResult = {
  prNumber: 12,
  sha: "head-sha",
  baseSha: "base-sha",
  state: "pending",
  description: "Review bot is reviewing the latest head.",
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function statusFor(result, creator = { id: ownActorId }) {
  return {
    state: result.state,
    description: result.description.slice(0, 140),
    target_url: result.targetUrl ?? null,
    creator,
  };
}

function statusClient(currentStatus, result = baseResult) {
  const calls = { reads: 0, pulls: 0, writes: [] };
  return {
    calls,
    async latestStatusForContext(sha) {
      assert.equal(sha, result.sha);
      calls.reads += 1;
      return currentStatus;
    },
    async pullRequest(number) {
      assert.equal(number, result.prNumber);
      calls.pulls += 1;
      return { head: { sha: result.sha }, base: { sha: result.baseSha } };
    },
    async setStatus(...args) {
      calls.writes.push(args);
    },
  };
}

const reportOptions = { getOwnActorId: async () => ownActorId };

test("unchanged own pending, failure, and success statuses skip one write after necessary safety checks", async () => {
  for (const state of ["pending", "failure", "success"]) {
    const result = { ...baseResult, state };
    const client = statusClient(statusFor(result), result);

    assert.equal(await reportStatus(client, result, reportOptions), false);
    assert.equal(client.calls.reads, 1);
    assert.equal(client.calls.pulls, state === "success" ? 1 : 0);
    assert.deepEqual(client.calls.writes, []);
  }
});

test("state, description, and audit-link addition, replacement, or removal publish", async () => {
  const prior = { ...baseResult, targetUrl: "https://github.com/old-comment" };
  for (const result of [
    { ...prior, state: "failure" },
    { ...prior, description: "Review required for the latest head." },
    { ...prior, targetUrl: "https://github.com/new-comment" },
    { ...prior, targetUrl: undefined },
  ]) {
    const client = statusClient(statusFor(prior), result);
    assert.equal(await reportStatus(client, result, reportOptions), true);
    assert.equal(client.calls.writes.length, 1);
  }
  const addedLink = { ...baseResult, targetUrl: "https://github.com/new-comment" };
  const client = statusClient(statusFor(baseResult), addedLink);
  assert.equal(await reportStatus(client, addedLink, reportOptions), true);
  assert.equal(client.calls.writes.length, 1);
});

test("comparison uses the description that the existing publisher can actually send", async () => {
  const result = { ...baseResult, description: `${"x".repeat(140)} trailing detail` };
  const client = statusClient(statusFor(result), result);
  assert.equal(await reportStatus(client, result, reportOptions), false);
  assert.deepEqual(client.calls.writes, []);
  const changed = { ...result, description: `changed ${result.description}` };
  assert.equal(await reportStatus(client, changed, reportOptions), true);
  assert.equal(client.calls.writes.length, 1);
});

test("matching text from a different or unknown creator never suppresses publication", async () => {
  for (const creator of [
    { id: ownActorId + 1 },
    { login: "private-review-app[bot]" },
    { id: String(ownActorId) },
    null,
    {},
  ]) {
    const client = statusClient(statusFor(baseResult, creator));
    assert.equal(await reportStatus(client, baseResult, reportOptions), true);
    assert.equal(client.calls.writes.length, 1);
  }
  for (const identity of [undefined, null, 0, String(ownActorId)]) {
    const client = statusClient(statusFor(baseResult));
    assert.equal(await reportStatus(client, baseResult, {
      getOwnActorId: async () => identity,
    }), true);
    assert.equal(client.calls.writes.length, 1);
  }
});

test("status or own-identity lookup failure still publishes the real gate result", async (context) => {
  const errors = [];
  context.mock.method(console, "error", (...args) => errors.push(args));
  const result = { ...baseResult, state: "success" };
  for (const failingRead of ["status", "identity"]) {
    const client = statusClient(statusFor(result), result);
    const options = { ...reportOptions };
    if (failingRead === "status") {
      client.latestStatusForContext = async () => { throw new Error("status unavailable"); };
    } else {
      options.getOwnActorId = async () => { throw new Error("App identity unavailable"); };
    }
    assert.equal(await reportStatus(client, result, options), true);
    assert.equal(client.calls.pulls, 1);
    assert.equal(client.calls.writes[0][1].state, "success");
  }
  assert.equal(errors.length, 2);
});

test("unchanged success still writes the mandatory failure after a base change", async () => {
  const result = { ...baseResult, state: "success" };
  for (const current of [statusFor(result), statusFor({
    ...result,
    state: "failure",
    description: "Pull request changed during evaluation; retry required.",
  })]) {
    const client = statusClient(current, result);
    client.pullRequest = async () => ({
      head: { sha: result.sha }, base: { sha: "advanced-base" },
    });
    assert.equal(await reportStatus(client, result, reportOptions), false);
    assert.deepEqual(client.calls.writes, [[result.sha, {
      state: "failure",
      description: "Pull request changed during evaluation; retry required.",
    }]]);
  }
});

test("unchanged success abstains after a head change and never hides a failed live check", async () => {
  const result = { ...baseResult, state: "success" };
  const client = statusClient(statusFor(result), result);
  client.pullRequest = async () => ({
    head: { sha: "new-head" }, base: { sha: result.baseSha },
  });
  assert.equal(await reportStatus(client, result, reportOptions), false);
  client.pullRequest = async () => { throw new Error("live PR unavailable"); };
  await assert.rejects(reportStatus(client, result, reportOptions), /live PR unavailable/);
  assert.deepEqual(client.calls.writes, []);
});

test("App identity uses an authenticated App JWT and a stable bot actor ID, cached by App ID", async (context) => {
  const paths = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/app") {
      const jwt = options.headers.Authorization.slice("Bearer ".length);
      const [header, payload, signature] = jwt.split(".");
      assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`),
        publicKey, Buffer.from(signature, "base64url")), true);
      const claims = JSON.parse(Buffer.from(payload, "base64url"));
      return Response.json({ id: Number(claims.iss), slug: `private-app-${claims.iss}` });
    }
    assert.equal(options.headers.Authorization, "Bearer installation-token");
    const login = decodeURIComponent(path.slice("/users/".length));
    return Response.json({ id: ownActorId, login, type: "Bot" });
  });
  const firstId = "90001";
  assert.deepEqual(await Promise.all([
    getCachedAppBotId(firstId, privateKey, "installation-token"),
    getCachedAppBotId(firstId, privateKey, "installation-token"),
  ]), [ownActorId, ownActorId]);
  assert.equal(await getCachedAppBotId(firstId, privateKey, "installation-token"), ownActorId);
  assert.equal(paths.length, 2);
  assert.equal(await getCachedAppBotId("90002", privateKey, "installation-token"), ownActorId);
  assert.equal(paths.length, 4);
  assert.deepEqual(paths, [
    "/app", "/users/private-app-90001%5Bbot%5D",
    "/app", "/users/private-app-90002%5Bbot%5D",
  ]);
});

test("failed or mismatched App identity is not cached and can recover", async (context) => {
  let mode = "http-error";
  let reads = 0;
  context.mock.method(globalThis, "fetch", async (url) => {
    if (new URL(url).pathname === "/app") {
      reads += 1;
      if (mode === "http-error") return new Response("unavailable", { status: 503 });
      return Response.json({ id: mode === "wrong-app" ? 999 : 90003, slug: "private-app" });
    }
    return Response.json({
      id: mode === "missing-id" ? null : ownActorId,
      login: mode === "wrong-login" ? "another-bot[bot]" : "private-app[bot]",
      type: mode === "human" ? "User" : "Bot",
    });
  });
  for (mode of ["http-error", "wrong-app", "missing-id", "wrong-login", "human"]) {
    await assert.rejects(getCachedAppBotId("90003", privateKey, "installation-token"));
  }
  mode = "valid";
  assert.equal(await getCachedAppBotId("90003", privateKey, "installation-token"), ownActorId);
  assert.equal(reads, 6);
});

function queuedSweepFixture(result) {
  const ref = { installationId: 42, owner: "owner", repo: "repo", prNumber: 12,
    sha: result.sha, generation: result.generation ?? result.sha };
  const key = pendingReviewKey(ref);
  const writes = [];
  const deletes = [];
  const namespace = {
    async list() { return { keys: [{ name: key, metadata: ref }], list_complete: true }; },
    async put(...args) { writes.push(args); },
    async delete(name) { deletes.push(name); },
  };
  return { namespace, key, writes, deletes };
}

test("pending and terminal queue settlement continue after an unchanged own status", async () => {
  for (const state of ["pending", "success"]) {
    const result = { ...baseResult, state, generation: "round", prState: "open" };
    const client = statusClient(statusFor(result), result);
    const queue = queuedSweepFixture({ ...result, generation: "previous-round" });
    const summary = await sweepPendingPullRequests({ PENDING_REVIEWS: queue.namespace }, config, {
      getInstallationToken: async () => "token",
      clientFactory: () => client,
      evaluate: async () => result,
      getOwnActorId: reportOptions.getOwnActorId,
      rotationSeed: 0,
    });
    assert.equal(summary.errors, 0);
    assert.equal(summary.unchanged, 1);
    assert.equal(summary.updated, 0);
    assert.equal(client.calls.reads, 1);
    assert.deepEqual(client.calls.writes, []);
    assert.equal(summary.removed, state === "success" ? 1 : 0);
    assert.equal(summary.requeued, state === "pending" ? 1 : 0);
    assert.equal(state === "pending" ? queue.writes.length : queue.deletes.length, 1);
  }
});

test("scheduled sweep counts the mandatory base-race failure as a write", async () => {
  const result = { ...baseResult, state: "success" };
  const client = statusClient(statusFor(result), result);
  client.openPullRequests = async () => [{ number: result.prNumber }];
  client.pullRequest = async () => ({ head: { sha: result.sha }, base: { sha: "advanced-base" } });
  const summary = await sweepOpenPullRequests({}, config, {
    listInstallations: async () => [{ id: 42 }],
    getInstallationToken: async () => "token",
    listRepositories: async () => [{ owner: { login: "owner" }, name: "repo" }],
    clientFactory: () => client,
    evaluate: async () => result,
    getOwnActorId: reportOptions.getOwnActorId,
    rotationSeed: 0,
  });
  assert.equal(summary.errors, 0);
  assert.equal(summary.updated, 1);
  assert.equal(summary.unchanged, 0);
  assert.equal(client.calls.writes[0][1].state, "failure");
});

test("open sweep skips only an unchanged own result and keeps pending tracking", async () => {
  for (const creator of [{ id: ownActorId }, { id: ownActorId + 1 }, {}]) {
    const result = { ...baseResult, generation: "round", prState: "open" };
    const client = statusClient(statusFor(result, creator), result);
    client.openPullRequests = async () => [{ number: result.prNumber }];
    const puts = [];
    const summary = await sweepOpenPullRequests({ PENDING_REVIEWS: {
      async put(...args) { puts.push(args); },
      async delete() {},
    } }, config, {
      listInstallations: async () => [{ id: 42 }],
      getInstallationToken: async () => "token",
      listRepositories: async () => [{ owner: { login: "owner" }, name: "repo" }],
      clientFactory: () => client,
      evaluate: async () => result,
      getOwnActorId: reportOptions.getOwnActorId,
      rotationSeed: 0,
    });
    const isOwn = creator.id === ownActorId;
    assert.equal(summary.errors, 0);
    assert.equal(summary.unchanged, isOwn ? 1 : 0);
    assert.equal(summary.updated, isOwn ? 0 : 1);
    assert.equal(client.calls.writes.length, isOwn ? 0 : 1);
    assert.equal(client.calls.reads, 1);
    assert.equal(puts.length, 1);
  }
});

function webhookFixture(context, {
  appId, clean = true, progress = false, appReadFails = false,
  pendingRetryAttempts = 0,
} = {}) {
  const pr = {
    number: 12, draft: false, state: "open", head: { sha: "head-sha" },
    base: { sha: "base-sha", ref: "main" }, created_at: "2026-08-02T00:00:00Z",
  };
  const evidence = {
    pr,
    issueComments: [],
    issueReactions: clean ? [{ user: { login: "chatgpt-codex-connector[bot]" },
      content: "+1", created_at: "2026-08-02T00:02:00Z" }] : [],
    issueEyesReactions: progress ? [{ user: { login: "chatgpt-codex-connector[bot]" },
      content: "eyes", created_at: "2026-08-02T00:02:00Z" }] : [],
    timelineEvents: [{ event: "committed", sha: pr.head.sha,
      author: { date: "2026-08-02T00:01:00Z" } }],
    config,
  };
  const result = evaluateGate(evidence);
  const statuses = [];
  const paths = [];
  const puts = [];
  let currentStatus = { ...statusFor(result), context: config.statusContext.toUpperCase() };
  context.mock.method(globalThis, "fetch", async (url, options) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    paths.push(path);
    if (path === "/app") {
      return appReadFails ? new Response("unavailable", { status: 503 })
        : Response.json({ id: Number(appId), slug: "private-review-app" });
    }
    if (path === "/users/private-review-app%5Bbot%5D") {
      return Response.json({ id: ownActorId, login: "private-review-app[bot]", type: "Bot" });
    }
    if (path.endsWith("/access_tokens")) {
      return Response.json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
    }
    if (path.endsWith("/statuses/head-sha") || path.endsWith("/statuses/merged-head")) {
      const body = JSON.parse(options.body);
      statuses.push(body);
      const written = { ...body, creator: { id: ownActorId } };
      if (path.endsWith("/statuses/head-sha")) currentStatus = written;
      return Response.json(written, { status: 201 });
    }
    if (path.endsWith("/commits/head-sha/statuses")) return Response.json([currentStatus]);
    if (path.endsWith("/commits/merged-head/statuses")) return Response.json([]);
    if (path.endsWith("/pulls/12")) return Response.json(pr);
    if (path.endsWith("/pulls/9")) {
      return Response.json({ ...pr, number: 9, state: "closed", head: { sha: "merged-head" } });
    }
    if (path.endsWith("/pulls")) return Response.json([{ ...pr }]);
    if (path.endsWith("/timeline")) return Response.json(evidence.timelineEvents);
    if (path.endsWith("/reactions")) {
      return Response.json(parsed.searchParams.get("content") === "+1"
        ? evidence.issueReactions : evidence.issueEyesReactions);
    }
    if (path.endsWith("/comments") || path.endsWith("/reviews")) return Response.json([]);
    if (path === "/graphql") return Response.json({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    } } } });
    throw new Error(`unexpected GitHub request: ${path}`);
  });
  const env = {
    GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_WEBHOOK_SECRET: "ephemeral-webhook-test-secret",
    REVIEW_START_RETRY_DELAY_MS: "0", REVIEW_PENDING_RETRY_INTERVAL_MS: "1",
    REVIEW_PENDING_RETRY_ATTEMPTS: String(pendingRetryAttempts),
    PENDING_REVIEWS: {
      async put(...args) { puts.push(args); },
      async delete() {},
    },
  };
  async function deliver(action, overrides = {}) {
    const payload = {
      action, installation: { id: 42 },
      repository: { owner: { login: "owner" }, name: "repo" },
      pull_request: { ...pr, ...overrides },
    };
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex");
    const tasks = [];
    const response = await worker.fetch(new Request("https://worker.example/", {
      method: "POST", body,
      headers: { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${signature}` },
    }), env, { waitUntil(task) { tasks.push(task); } });
    assert.equal(response.status, 202);
    await Promise.all(tasks);
  }
  return { result, statuses, paths, puts, deliver };
}

test("signed webhook redeliveries skip an unchanged own success across context casing", async (context) => {
  const errors = [];
  context.mock.method(console, "error", (...args) => errors.push(args));
  const fixture = webhookFixture(context, { appId: "91001" });
  assert.equal(fixture.result.state, "success");
  await fixture.deliver("edited");
  await fixture.deliver("edited");
  assert.deepEqual(errors, []);
  assert.deepEqual(fixture.statuses, []);
  assert.equal(fixture.paths.filter((path) => path.endsWith("/commits/head-sha/statuses")).length, 2);
  assert.equal(fixture.paths.filter((path) => path === "/app").length, 1);
});

test("webhook failure retry still evaluates when the initial duplicate write is skipped", async (context) => {
  const errors = [];
  context.mock.method(console, "error", (...args) => errors.push(args));
  const fixture = webhookFixture(context, { appId: "91002", clean: false });
  assert.equal(fixture.result.state, "failure");
  await fixture.deliver("opened");
  assert.deepEqual(errors, []);
  assert.deepEqual(fixture.statuses, []);
  assert.equal(fixture.paths.filter((path) => path.endsWith("/commits/head-sha/statuses")).length, 2);
  assert.equal(fixture.paths.filter((path) => path.endsWith("/pulls/12")).length, 2);
});

test("webhook pending tracking continues after an unchanged own status", async (context) => {
  const errors = [];
  context.mock.method(console, "error", (...args) => errors.push(args));
  const fixture = webhookFixture(context, {
    appId: "91005", clean: false, progress: true, pendingRetryAttempts: 2,
  });
  assert.equal(fixture.result.state, "pending");
  await fixture.deliver("opened");
  assert.deepEqual(errors, []);
  assert.deepEqual(fixture.statuses, []);
  assert.equal(fixture.paths.filter((path) => path.endsWith("/commits/head-sha/statuses")).length, 3);
  assert.equal(fixture.puts.length, 1);
});

test("merged-close sibling reevaluation uses the same provenance-aware publisher", async (context) => {
  const errors = [];
  context.mock.method(console, "error", (...args) => errors.push(args));
  const fixture = webhookFixture(context, { appId: "91003" });
  await fixture.deliver("closed", { number: 9, merged: true });
  assert.deepEqual(errors, []);
  assert.equal(fixture.paths.some((path) => path.endsWith("/pulls/12")), true);
  assert.equal(fixture.statuses.some((status) => status.state === "success"), false);
});

test("webhook App identity failure logs the optimization error and publishes success", async (context) => {
  const errors = [];
  context.mock.method(console, "error", (...args) => errors.push(args));
  const fixture = webhookFixture(context, { appId: "91004", appReadFails: true });
  await fixture.deliver("edited");
  assert.equal(fixture.statuses.length, 1);
  assert.equal(fixture.statuses[0].state, "success");
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /deduplication read failed/);
});
