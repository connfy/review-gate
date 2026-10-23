// Deployment-wide Actions duration policy. GitHub owns run state and timing;
// KV only schedules bounded retries and remembers accepted cancel requests.
import { DEFAULT_STATUS_CONTEXT } from "./gate.js";
import {
  getCachedInstallationAccess,
  normalizeStatusContext,
  RepoClient,
} from "./github.js";

export const CI_BUDGET_STATUS_CONTEXT = "review-gate/ci-budget";
const RUN_PREFIX = "ci-budget-run:v1:";
const CANCEL_PREFIX = "ci-budget-cancel:v1:";
const SWEEP_CURSOR_KEY = "ci-budget-sweep-cursor:v1";
const SWEEP_INTERVAL_MS = 3 * 60 * 1000;
const MAX_QUEUE_KEYS = 10_000;
const KV_WRITE_INTERVAL_MS = 1_000;
// Match the existing pending queue's 24-hour recovery horizon. Successful live
// evaluations renew it; failures cannot keep inaccessible records alive forever.
const RETRY_HORIZON_SECONDS = 24 * 60 * 60;

function retryTtl(config) {
  return Math.ceil(config.budgetMs / 1000) + RETRY_HORIZON_SECONDS;
}

function expiresAt(config, now) {
  return Math.floor(now / 1000) + retryTtl(config);
}

export function resolveCiBudgetConfig(env = {}) {
  const minutesText = String(env.CI_BUDGET_MINUTES ?? "").trim();
  const mode = String(env.CI_BUDGET_MODE ?? "report").trim();
  const statusContext = String(
    env.CI_BUDGET_STATUS_CONTEXT ?? CI_BUDGET_STATUS_CONTEXT,
  ).trim();
  const maxRuns = Number(env.SWEEP_MAX_CI_RUNS ?? 2);
  let error = null;
  if (mode !== "report" && mode !== "cancel") {
    error = "CI_BUDGET_MODE must be report or cancel";
  } else if (
    !statusContext ||
    normalizeStatusContext(statusContext) ===
      normalizeStatusContext(env.STATUS_CONTEXT ?? DEFAULT_STATUS_CONTEXT)
  ) {
    error =
      "CI_BUDGET_STATUS_CONTEXT must be nonempty and different from STATUS_CONTEXT (case-insensitive)";
  } else if (!Number.isSafeInteger(maxRuns) || maxRuns <= 0) {
    error = "SWEEP_MAX_CI_RUNS must be a positive safe integer";
  } else if (
    minutesText &&
    (!/^\d+(?:\.\d+)?$/.test(minutesText) ||
      !Number.isSafeInteger(Number(minutesText) * 60_000) ||
      Number(minutesText) <= 0)
  ) {
    error =
      "CI_BUDGET_MINUTES must be positive decimal minutes with whole-millisecond precision";
  }
  return {
    enabled: Boolean(minutesText) && error === null,
    minutes: Number(minutesText),
    budgetMs: Number(minutesText) * 60_000,
    mode,
    statusContext,
    maxRuns,
    error,
  };
}

function queueKey(ref, prefix = RUN_PREFIX) {
  return (
    prefix +
    [
      ref.installationId,
      encodeURIComponent(ref.owner),
      encodeURIComponent(ref.repo),
      ref.runId,
      ref.attempt,
    ].join(":")
  );
}

function validRef(ref) {
  return (
    ref &&
    [ref.installationId, ref.runId, ref.attempt].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) &&
    typeof ref.owner === "string" &&
    /^[\w.-]+$/.test(ref.owner) &&
    typeof ref.repo === "string" &&
    /^[\w.-]+$/.test(ref.repo)
  );
}

export function ciRunRefFromEvent(eventName, payload) {
  if (
    eventName !== "workflow_run" ||
    !["requested", "in_progress", "completed"].includes(payload?.action)
  ) {
    return null;
  }
  const ref = {
    installationId: Number(payload?.installation?.id),
    owner: payload?.repository?.owner?.login,
    repo: payload?.repository?.name,
    runId: Number(payload?.workflow_run?.id),
    attempt: Number(payload?.workflow_run?.run_attempt),
  };
  return validRef(ref) ? ref : null;
}

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

const NOT_STARTED = Object.freeze({
  startedAt: null,
  deadline: null,
  elapsedMs: 0,
  exceeded: false,
});

// GitHub concludes a run `skipped` only when none of its jobs started (each was
// skipped, typically by its `if:`). It consumed no CI time, so the run object
// alone settles it without reading jobs.
function concludedWithoutJobs(run) {
  return run?.status === "completed" && run?.conclusion === "skipped";
}

// A workflow is a pipeline, not a sum of parallel runner minutes. Use its
// executed jobs to exclude the initial runner queue and avoid updated_at (a
// mutable run timestamp) as a completion clock. Dependency gaps after the first
// job starts are part of the pipeline's wall time.
export function ciBudgetTiming(run, jobs, budgetMs, now = Date.now()) {
  if (
    run.status === "completed" &&
    jobs.some((job) => job.status !== "completed")
  ) {
    throw new Error(
      "CI budget: job state has not caught up to completion; retry required",
    );
  }
  const executed = jobs.filter(
    (job) =>
      job.status !== "queued" &&
      job.status !== "waiting" &&
      job.conclusion !== "skipped" &&
      !(
        job.status === "completed" &&
        job.conclusion === "cancelled" &&
        job.started_at == null
      ),
  );
  if (executed.length === 0) {
    return { ...NOT_STARTED };
  }
  const starts = executed.map((job) => timestamp(job.started_at));
  if (starts.includes(null) || starts.some((start) => start > now)) {
    throw new Error(
      "CI budget: missing or future job start time; no cancellation attempted",
    );
  }
  const startedAt = Math.min(...starts);
  let end = now;
  if (run.status === "completed") {
    const ends = executed.map((job) => timestamp(job.completed_at));
    if (
      ends.some(
        (value, index) =>
          value === null || value < starts[index] || value > now,
      )
    ) {
      throw new Error(
        "CI budget: incomplete job completion times; retry required",
      );
    }
    end = Math.max(...ends);
  }
  const elapsedMs = end - startedAt;
  return {
    startedAt,
    deadline: startedAt + budgetMs,
    elapsedMs,
    exceeded: elapsedMs > budgetMs,
  };
}

// A status means its state and description; the link is provenance. Every
// write emits a `status` event, which starts any workflow triggered on status
// (attributed to the default-branch HEAD) and so another evaluation. Republishing
// an unchanged meaning only to point at a newer attempt would let each such run
// trigger the next one, so only a change of meaning is published.
function sameMeaning(current, result) {
  return (
    current?.state === result.state &&
    current?.description === result.description
  );
}

// A budget breach is a finding on this SHA. Another workflow or a quick rerun
// must not erase it. Inspect history, not just the latest status, and reconcile
// again after a success write to repair an overlapping breach publication.
export async function reportCiBudgetStatus(client, sha, result) {
  let statuses = await client.statusesForContext(sha, {
    requireComplete: true,
  });
  const breach = statuses.find((status) => status.state === "failure");
  let effective = breach
    ? {
        state: "failure",
        description: breach.description,
        targetUrl: breach.target_url,
      }
    : result;
  if (sameMeaning(statuses[0], effective)) {
    return false;
  }
  await client.setStatus(sha, effective);
  if (effective.state === "success") {
    statuses = await client.statusesForContext(sha, { requireComplete: true });
    const concurrentBreach = statuses.find(
      (status) => status.state === "failure",
    );
    if (concurrentBreach) {
      effective = {
        state: "failure",
        description: concurrentBreach.description,
        targetUrl: concurrentBreach.target_url,
      };
      if (!sameMeaning(statuses[0], effective)) {
        await client.setStatus(sha, effective);
      }
    }
  }
  return true;
}

function activeConfig(env) {
  const config = resolveCiBudgetConfig(env);
  if (config.error) {
    console.error(
      `CI budget disabled: ${config.error}; no cancellation attempted`,
    );
  }
  return config;
}

function requireQueue(env) {
  const namespace = env.PENDING_REVIEWS;
  if (
    !["get", "put", "list", "delete"].every(
      (method) => typeof namespace?.[method] === "function",
    )
  ) {
    throw new Error(
      "CI budget: PENDING_REVIEWS KV binding is required; no cancellation attempted",
    );
  }
  return namespace;
}

async function enqueue(namespace, ref, config, now) {
  const key = queueKey(ref);
  if (!(await namespace.get(key))) {
    const expiration = expiresAt(config, now);
    await namespace.put(key, "queued", {
      expiration,
      metadata: {
        ...ref,
        budgetMs: config.budgetMs,
        nextCheckAt: now,
        expiresAt: expiration,
      },
    });
  }
  return key;
}

async function settle(namespace, ref, { receipt = true } = {}) {
  await namespace.delete(queueKey(ref));
  if (receipt) {
    await namespace.delete(queueKey(ref, CANCEL_PREFIX));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A finished attempt needs no future check, so the delivery that sees it
// finished removes its entry and leaves the capped sweep to live runs. Cancel
// receipts exist only after a breach; any other leftover receipt simply expires.
// KV accepts one write per second per key, and this delete can follow an
// in_progress enqueue of the same attempt within that second, so retry once
// after it. An entry that still remains is settled by the sweep.
async function settleFinished(namespace, ref, exceeded, pause = sleep) {
  const settleOptions = { receipt: exceeded };
  try {
    await settle(namespace, ref, settleOptions);
  } catch {
    await pause(KV_WRITE_INTERVAL_MS);
    try {
      await settle(namespace, ref, settleOptions);
    } catch (error) {
      console.warn("CI budget: finished attempt left for the sweep:", error);
    }
  }
}

export async function evaluateCiRun(env, ref, config, options = {}) {
  if (!config.enabled) {
    return { updated: false, cancelled: false, completed: false };
  }
  if (!validRef(ref)) {
    throw new Error("CI budget: invalid workflow run reference");
  }
  const namespace = requireQueue(env);
  const now = options.now ?? Date.now();
  const key = queueKey(ref);
  // Queue an active attempt before API evaluation so failures stay retryable.
  // A signed completed attempt needs no future check; its caller queues it
  // only if this evaluation fails.
  if (!options.fromSweep && !options.completedRun) {
    await enqueue(namespace, ref, config, now);
  }
  const access = await (
    options.getInstallationAccess ?? getCachedInstallationAccess
  )(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, ref.installationId);
  if (!["read", "write"].includes(access.permissions?.actions)) {
    throw new Error(
      "CI budget: Actions: read permission is missing or unapproved on this installation; no cancellation attempted",
    );
  }
  const canCancel =
    config.mode === "cancel" &&
    access.permissions.actions === "write" &&
    access.permissions.statuses === "write";
  if (config.mode === "cancel" && access.permissions.actions !== "write") {
    console.error(
      "CI budget: Actions: write permission is missing or unapproved; reporting only, no cancellation attempted",
    );
  } else if (
    config.mode === "cancel" &&
    access.permissions.statuses !== "write"
  ) {
    console.error(
      "CI budget: Commit statuses: write permission is missing or unapproved; no cancellation attempted",
    );
  }
  const client = options.clientFactory
    ? options.clientFactory(
        access.token,
        ref.owner,
        ref.repo,
        config.statusContext,
      )
    : new RepoClient(access.token, ref.owner, ref.repo, config.statusContext);
  const run =
    options.completedRun ?? (await client.workflowRun(ref.runId, ref.attempt));
  if (
    Number(run.id) !== ref.runId ||
    Number(run.run_attempt) !== ref.attempt ||
    !/^[0-9a-f]{40}$/.test(run.head_sha ?? "")
  ) {
    throw new Error(
      "CI budget: workflow identity mismatch; no cancellation attempted",
    );
  }
  const timing = concludedWithoutJobs(run)
    ? { ...NOT_STARTED }
    : ciBudgetTiming(
        run,
        await client.workflowJobs(ref.runId, ref.attempt),
        config.budgetMs,
        now,
      );
  let updated = false;
  // The budget measures executed jobs. Until one has started (still queued,
  // skipped, or cancelled before starting) there is no duration to judge, so
  // claim nothing: such a run consumed no CI time, and a status would only
  // emit another status event.
  if (timing.startedAt !== null) {
    updated = await reportCiBudgetStatus(client, run.head_sha, {
      state: timing.exceeded ? "failure" : "success",
      description: timing.exceeded
        ? `CI exceeded ${config.minutes}m budget; review for excess and optimize, not a longer timeout.`
        : `No CI budget breach observed (${config.minutes}m limit); workflows may still be running.`,
      targetUrl: `https://github.com/${ref.owner}/${ref.repo}/actions/runs/${ref.runId}/attempts/${ref.attempt}`,
    });
  }
  let cancelled = false;
  const cancelKey = queueKey(ref, CANCEL_PREFIX);
  if (
    timing.exceeded &&
    canCancel &&
    run.status !== "completed" &&
    !(await namespace.get(cancelKey))
  ) {
    // The cancel endpoint addresses a run, not an attempt. Never let an old
    // webhook/sweep cancel a newer rerun, or a run that has already finished.
    const live = await client.workflowRun(ref.runId);
    if (
      Number(live.id) === ref.runId &&
      Number(live.run_attempt) === ref.attempt &&
      live.head_sha === run.head_sha &&
      live.status === "in_progress"
    ) {
      try {
        await client.cancelWorkflowRun(ref.runId);
        await namespace.put(cancelKey, "accepted", {
          expirationTtl: retryTtl(config),
        });
        cancelled = true;
      } catch (error) {
        // Completion can win the race with cancellation. Other errors must
        // remain visible and retryable, not be mistaken for accepted cancels.
        if (error.status !== 409) {
          throw error;
        }
      }
    }
  }
  const completed = run.status === "completed";
  // Only the sweep reschedules existing keys. A webhook only enqueues once:
  // writing a deadline immediately after enqueue would exceed KV's
  // one-write-per-second limit on the same key. A delivery that sees its
  // attempt finished settles it in handleCiBudgetEvent; the sweep settles the
  // rest.
  if (completed && options.fromSweep) {
    await settle(namespace, ref);
  } else if (options.fromSweep) {
    const expiration = expiresAt(config, now);
    await namespace.put(key, "queued", {
      expiration,
      metadata: {
        ...ref,
        budgetMs: config.budgetMs,
        expiresAt: expiration,
        nextCheckAt:
          timing.deadline !== null && !timing.exceeded
            ? timing.deadline + 1
            : now + SWEEP_INTERVAL_MS,
      },
    });
  }
  return { updated, cancelled, completed, ...timing };
}

export async function handleCiBudgetEvent(
  env,
  eventName,
  payload,
  options = {},
) {
  const config = activeConfig(env);
  const ref = ciRunRefFromEvent(eventName, payload);
  if (!config.enabled || !ref) {
    return null;
  }
  // A requested attempt has not started a job: there is no duration to judge
  // and no deadline to schedule. Its in_progress delivery queues it.
  if (payload.action === "requested") {
    return { updated: false, cancelled: false, completed: false };
  }
  const namespace = requireQueue(env);
  // A completed attempt is immutable and its signed payload is GitHub's final
  // record of it, so evaluate from it instead of reading the attempt; a
  // `skipped` conclusion needs no API call at all. Only a failed evaluation is
  // queued, for a scheduled retry.
  const run = payload.workflow_run;
  const completedRun =
    payload.action === "completed" && run.status === "completed"
      ? run
      : undefined;
  let result = {
    updated: false,
    cancelled: false,
    completed: true,
    ...NOT_STARTED,
  };
  if (!concludedWithoutJobs(completedRun)) {
    try {
      result = await evaluateCiRun(env, ref, config, {
        ...options,
        completedRun,
      });
    } catch (error) {
      if (completedRun) {
        await enqueue(namespace, ref, config, options.now ?? Date.now());
      }
      throw error;
    }
  }
  if (result.completed) {
    await settleFinished(namespace, ref, result.exceeded, options.sleepFn);
  }
  return result;
}

export async function sweepCiBudgetRuns(env, options = {}) {
  const config = activeConfig(env);
  const summary = {
    enabled: config.enabled,
    queued: 0,
    runs: 0,
    updated: 0,
    cancelled: 0,
    errors: 0,
    limited: false,
  };
  if (!config.enabled) {
    return summary;
  }
  try {
    const namespace = requireQueue(env);
    const keys = [];
    const previousCursor = await namespace.get(SWEEP_CURSOR_KEY);
    let cursor = previousCursor;
    let pages = 0;
    do {
      const page = await namespace.list({
        prefix: RUN_PREFIX,
        limit: Math.min(1000, MAX_QUEUE_KEYS - keys.length),
        ...(cursor ? { cursor } : {}),
      });
      keys.push(...(page.keys ?? []));
      pages += 1;
      cursor = page.list_complete === false ? page.cursor : null;
      summary.limited = page.list_complete === false;
    } while (cursor && pages < 10 && keys.length < MAX_QUEUE_KEYS);
    const now = options.now ?? Date.now();
    const due = keys
      .filter(
        (key) =>
          validRef(key.metadata) &&
          queueKey(key.metadata) === key.name &&
          Number.isFinite(key.metadata.nextCheckAt) &&
          (key.metadata.budgetMs !== config.budgetMs ||
            key.metadata.nextCheckAt <= now),
      )
      .sort(
        (left, right) =>
          left.metadata.nextCheckAt - right.metadata.nextCheckAt ||
          left.name.localeCompare(right.name),
      );
    summary.queued = keys.length;
    summary.limited ||= due.length > config.maxRuns;
    for (const entry of due.slice(0, config.maxRuns)) {
      summary.runs += 1;
      try {
        const result = await evaluateCiRun(env, entry.metadata, config, {
          ...options,
          now,
          fromSweep: true,
        });
        summary.updated += Number(result.updated);
        summary.cancelled += Number(result.cancelled);
      } catch (error) {
        summary.errors += 1;
        console.error("CI budget sweep evaluation failed:", error);
        // Back off failed entries too, so one unavailable installation cannot
        // consume every sweep slot ahead of another run's deadline.
        const expiration = entry.metadata.expiresAt ?? expiresAt(config, now);
        // Preserve the previous expiry on failures. Refreshing a TTL here would
        // make removed installations retry forever. KV requires >=60s remaining.
        if (expiration > Math.floor(now / 1000) + 60) {
          await namespace.put(entry.name, "queued", {
            expiration,
            metadata: {
              ...entry.metadata,
              budgetMs: config.budgetMs,
              expiresAt: expiration,
              nextCheckAt: now + SWEEP_INTERVAL_MS,
            },
          });
        }
      }
    }
    // Keep enumeration bounded without permanently hiding later installations.
    // Resume the next segment even when this segment had no due records; wrap
    // after completion so earlier records and newly inserted keys are revisited.
    if (cursor) {
      await namespace.put(SWEEP_CURSOR_KEY, cursor);
    } else if (previousCursor) {
      await namespace.delete(SWEEP_CURSOR_KEY);
    }
  } catch (error) {
    summary.errors += 1;
    console.error("CI budget sweep failed:", error);
  }
  if (summary.limited) {
    console.warn(
      "CI budget sweep limited; queued runs may be checked late",
      JSON.stringify(summary),
    );
  }
  return summary;
}
