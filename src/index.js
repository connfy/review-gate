// Cloudflare Worker entrypoint for the review gate.
//
// A single GitHub App delivers webhooks for every installed repository to this
// Worker. For each pull-request event we recompute the gate and report the
// configured commit status on the head SHA. A light scheduled sweep catches
// reaction-only updates that GitHub does not deliver as standalone webhooks.

import { evaluateGate, resolveConfig } from "./gate.js";
import {
  getCachedInstallationToken,
  listAppInstallations,
  listInstallationRepositories,
  RepoClient,
} from "./github.js";
import {
  pullRequestRefFromEvent,
  shouldIgnoreEvent,
  verifySignature,
} from "./webhook.js";

const CLEAN_COMMENT_RETRY_DELAY_MS = 3_000;
const REVIEW_START_RETRY_DELAY_MS = 15_000;
const REVIEW_PENDING_RETRY_INTERVAL_MS = 7_000;
const REVIEW_PENDING_RETRY_ATTEMPTS = 0;
const SWEEP_MAX_INSTALLATIONS = 10;
const SWEEP_MAX_REPOSITORIES = 4;
const SWEEP_MAX_PULL_REQUESTS = 2;
const SWEEP_PAGE_SPAN = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loginFor(user) {
  if (!user || typeof user !== "object") {
    return "";
  }
  return String(user.login ?? "");
}

function includesText(body, text) {
  const needle = String(text ?? "");
  if (needle.length === 0) {
    return false;
  }
  return String(body ?? "").toLowerCase().includes(needle.toLowerCase());
}

function configFromEnv(env) {
  const botLogins = env.REVIEW_BOT_LOGINS
    ? env.REVIEW_BOT_LOGINS.split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : undefined;
  return resolveConfig({
    cleanText: env.CLEAN_REVIEW_TEXT,
    cleanReactionContent: env.CLEAN_REACTION_CONTENT,
    inProgressReactionContent: env.REVIEW_IN_PROGRESS_REACTION_CONTENT,
    reviewRequestText: env.REVIEW_REQUEST_TEXT,
    statusContext: env.STATUS_CONTEXT,
    botLogins,
  });
}

function parseDelayMs(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function pageOffsetFor(seed, pageSpan, ...parts) {
  if (pageSpan <= 1) {
    return 0;
  }
  return pageCursorFor(seed, ...parts) % pageSpan;
}

function pageCursorFor(seed, ...parts) {
  const normalizedSeed = Number.isFinite(Number(seed))
    ? Math.max(0, Math.trunc(Number(seed)))
    : 0;
  return hashString(parts.join(":")) + normalizedSeed;
}

function rotateList(items, seed, ...parts) {
  if (!Array.isArray(items) || items.length <= 1) {
    return items;
  }
  const offset = pageOffsetFor(seed, items.length, ...parts);
  return items.slice(offset).concat(items.slice(0, offset));
}

function isReviewRequestComment(comment, config) {
  const author = loginFor(comment?.user);
  return (
    !config.botLogins.has(author) &&
    includesText(comment?.body, config.reviewRequestText)
  );
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestReviewRequestComments(issueComments, config) {
  let latestTime = null;
  let latestComments = [];

  for (const comment of issueComments) {
    if (comment?.id == null || !isReviewRequestComment(comment, config)) {
      continue;
    }
    const timestamp = parseTimestamp(comment?.created_at);
    if (timestamp === null) {
      continue;
    }
    if (latestTime === null || timestamp > latestTime) {
      latestTime = timestamp;
      latestComments = [comment];
    } else if (timestamp === latestTime) {
      latestComments.push(comment);
    }
  }

  return latestComments;
}

function eventMayStartReview(eventName, payload, config) {
  if (eventName === "issue_comment") {
    return (
      String(payload?.action ?? "") === "created" &&
      isReviewRequestComment(payload?.comment, config)
    );
  }

  if (eventName !== "pull_request") {
    return false;
  }

  return new Set([
    "opened",
    "reopened",
    "ready_for_review",
    "synchronize",
  ]).has(String(payload?.action ?? ""));
}

async function reportStatus(client, result) {
  await client.setStatus(result.sha, {
    state: result.state,
    description: result.description,
    targetUrl: undefined,
  });
}

export function shouldReportStatus(currentStatus, result) {
  if (!currentStatus) {
    return true;
  }
  return (
    String(currentStatus.state ?? "") !== result.state ||
    String(currentStatus.description ?? "") !== result.description
  );
}

async function evaluateAndReport(env, ref, config, options = {}) {
  const token = await getCachedInstallationToken(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    ref.installationId,
  );
  const client = new RepoClient(token, ref.owner, ref.repo, config.statusContext);

  let result = await evaluateFromGitHub(client, ref, config);

  if (options.retryOnCleanComment && result.state !== "success") {
    await sleep(CLEAN_COMMENT_RETRY_DELAY_MS);
    result = await evaluateFromGitHub(client, ref, config);
  }

  await reportStatus(client, result);

  result = await maybeRetryReviewStart({
    result,
    retryOnReviewStart: options.retryOnReviewStart,
    evaluate: () => evaluateFromGitHub(client, ref, config),
    report: (retryResult) => reportStatus(client, retryResult),
    sleepFn: options.sleepFn ?? sleep,
    reviewStartRetryDelayMs:
      options.reviewStartRetryDelayMs ?? REVIEW_START_RETRY_DELAY_MS,
    reviewPendingRetryIntervalMs:
      options.reviewPendingRetryIntervalMs ??
      REVIEW_PENDING_RETRY_INTERVAL_MS,
    reviewPendingRetryAttempts:
      options.reviewPendingRetryAttempts ?? REVIEW_PENDING_RETRY_ATTEMPTS,
  });

  return result;
}

export async function sweepOpenPullRequests(env, config, options = {}) {
  const maxInstallations =
    options.maxInstallations ??
    parsePositiveInteger(env.SWEEP_MAX_INSTALLATIONS, SWEEP_MAX_INSTALLATIONS);
  const maxRepositories =
    options.maxRepositories ??
    parsePositiveInteger(env.SWEEP_MAX_REPOSITORIES, SWEEP_MAX_REPOSITORIES);
  const maxPullRequests =
    options.maxPullRequests ??
    parsePositiveInteger(env.SWEEP_MAX_PULL_REQUESTS, SWEEP_MAX_PULL_REQUESTS);
  const pageSpan =
    options.pageSpan ??
    parsePositiveInteger(env.SWEEP_PAGE_SPAN, SWEEP_PAGE_SPAN);
  const rotationSeed =
    options.rotationSeed ?? Math.floor(Date.now() / (3 * 60 * 1000));
  const orderSeed = Math.floor(rotationSeed / pageSpan);

  const installations = rotateList(
    await listAppInstallations(
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
      {
        limit: maxInstallations,
        pageOffset: pageOffsetFor(rotationSeed, pageSpan, "installations"),
        pageCursor: pageCursorFor(rotationSeed, "installations"),
      },
    ),
    orderSeed,
    "installation-order",
  );

  const summary = {
    installations: 0,
    repositories: 0,
    pullRequests: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    limited: installations.length >= maxInstallations,
  };
  const repositoriesToSweep = [];

  for (let index = 0; index < installations.length; index += 1) {
    if (repositoriesToSweep.length >= maxRepositories) {
      summary.limited = true;
      break;
    }

    const installation = installations[index];
    summary.installations += 1;
    const installationId = Number(installation?.id);
    if (!Number.isFinite(installationId)) {
      continue;
    }

    const remainingInstallations = installations.length - index;
    const remainingRepositoryBudget =
      maxRepositories - repositoriesToSweep.length;
    const repositoryLimit = Math.max(
      1,
      Math.ceil(remainingRepositoryBudget / remainingInstallations),
    );

    let token;
    let repositories;
    try {
      token = await getCachedInstallationToken(
        env.GITHUB_APP_ID,
        env.GITHUB_APP_PRIVATE_KEY,
        installationId,
      );
      repositories = rotateList(
        await listInstallationRepositories(token, {
          limit: repositoryLimit,
          pageOffset: pageOffsetFor(
            rotationSeed,
            pageSpan,
            "repositories",
            String(installationId),
          ),
          pageCursor: pageCursorFor(
            rotationSeed,
            "repositories",
            String(installationId),
          ),
        }),
        orderSeed,
        "repository-order",
        String(installationId),
      );
      if (repositories.length >= repositoryLimit) {
        summary.limited = true;
      }
    } catch (error) {
      summary.errors += 1;
      console.error(
        `scheduled sweep failed to enumerate installation ${installationId}:`,
        error,
      );
      continue;
    }

    for (const repository of repositories) {
      if (repositoriesToSweep.length >= maxRepositories) {
        summary.limited = true;
        break;
      }

      const owner = String(repository?.owner?.login ?? "");
      const repo = String(repository?.name ?? "");
      if (!owner || !repo) {
        continue;
      }

      repositoriesToSweep.push({ token, owner, repo });
      summary.repositories += 1;
    }
  }

  const repositories = rotateList(
    repositoriesToSweep,
    orderSeed,
    "selected-repository-order",
  );

  for (let index = 0; index < repositories.length; index += 1) {
    if (summary.pullRequests >= maxPullRequests) {
      summary.limited = true;
      break;
    }

    const { token, owner, repo } = repositories[index];
    const client = new RepoClient(token, owner, repo, config.statusContext);
    const remainingRepositories = repositories.length - index;
    const remainingPullRequestBudget = maxPullRequests - summary.pullRequests;
    const pullRequestLimit = Math.max(
      1,
      Math.ceil(remainingPullRequestBudget / remainingRepositories),
    );
    let pulls = [];
    try {
      pulls = await client.openPullRequests({
        limit: pullRequestLimit,
        pageOffset: pageOffsetFor(rotationSeed, pageSpan, "pulls", owner, repo),
        pageCursor: pageCursorFor(rotationSeed, "pulls", owner, repo),
      });
      if (pulls.length >= pullRequestLimit) {
        summary.limited = true;
      }
    } catch (error) {
      summary.errors += 1;
      console.error(`scheduled sweep failed to list ${owner}/${repo}:`, error);
      continue;
    }

    for (const pull of pulls) {
      if (summary.pullRequests >= maxPullRequests) {
        summary.limited = true;
        break;
      }
      summary.pullRequests += 1;

      try {
        const result = await evaluateFromGitHub(
          client,
          { prNumber: Number(pull.number) },
          config,
        );
        const currentStatus = await client.latestStatusForContext(result.sha);
        if (shouldReportStatus(currentStatus, result)) {
          await reportStatus(client, result);
          summary.updated += 1;
        } else {
          summary.unchanged += 1;
        }
      } catch (error) {
        summary.errors += 1;
        console.error(
          `scheduled sweep failed for ${owner}/${repo}#${pull.number}:`,
          error,
        );
      }
    }
  }

  return summary;
}

export async function maybeRetryReviewStart({
  result,
  retryOnReviewStart,
  evaluate,
  report,
  sleepFn = sleep,
  reviewStartRetryDelayMs = REVIEW_START_RETRY_DELAY_MS,
  reviewPendingRetryIntervalMs = REVIEW_PENDING_RETRY_INTERVAL_MS,
  reviewPendingRetryAttempts = REVIEW_PENDING_RETRY_ATTEMPTS,
}) {
  if (!retryOnReviewStart) {
    return result;
  }

  let current = result;
  if (current.state === "failure") {
    await sleepFn(reviewStartRetryDelayMs);
    const retryResult = await evaluate();
    if (retryResult.sha === current.sha) {
      await report(retryResult);
      current = retryResult;
    }
  }

  // GitHub does not send a standalone webhook when the bot adds a PR body
  // reaction. Scheduled sweeps are the durable path for late reactions; this
  // optional loop is only for installations that explicitly enable short
  // webhook-bound re-checks.
  for (
    let attempt = 0;
    current.state === "pending" &&
    reviewPendingRetryIntervalMs > 0 &&
    attempt < reviewPendingRetryAttempts;
    attempt += 1
  ) {
    await sleepFn(reviewPendingRetryIntervalMs);
    const retryResult = await evaluate();
    if (retryResult.sha === current.sha) {
      if (
        retryResult.state !== current.state ||
        retryResult.description !== current.description
      ) {
        await report(retryResult);
      }
      current = retryResult;
    }
  }

  return current;
}

async function evaluateFromGitHub(client, ref, config) {
  const [
    pr,
    issueComments,
    issueReactions,
    issueEyesReactions,
    reviews,
    reviewThreads,
    timelineEvents,
  ] = await Promise.all([
    client.pullRequest(ref.prNumber),
    client.issueComments(ref.prNumber),
    client.issueReactions(ref.prNumber, config.cleanReactionContent),
    client.issueReactions(ref.prNumber, config.inProgressReactionContent),
    client.reviews(ref.prNumber),
    client.reviewThreads(ref.prNumber),
    client.timelineEvents(ref.prNumber),
  ]);
  const reviewRequestReactions = await Promise.all(
    latestReviewRequestComments(issueComments, config).map(async (comment) => ({
      comment,
      reactions: await client.issueCommentReactions(
        comment.id,
        config.inProgressReactionContent,
      ),
    })),
  );

  return evaluateGate({
    pr,
    issueComments,
    issueReactions,
    issueEyesReactions,
    reviews,
    reviewThreads,
    reviewRequestReactions,
    timelineEvents,
    config,
  });
}

export default {
  async scheduled(controller, env, _ctx) {
    const summary = await sweepOpenPullRequests(env, configFromEnv(env), {
      rotationSeed: Math.floor(
        Number(controller?.scheduledTime ?? Date.now()) / (3 * 60 * 1000),
      ),
    });
    console.log("scheduled sweep completed", JSON.stringify(summary));
  },

  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    const verified = await verifySignature(
      env.GITHUB_WEBHOOK_SECRET,
      rawBody,
      signature,
    );
    if (!verified) {
      return new Response("Invalid signature", { status: 401 });
    }

    const eventName = request.headers.get("x-github-event") ?? "";
    if (eventName === "ping") {
      return new Response("pong", { status: 200 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const ref = pullRequestRefFromEvent(eventName, payload);
    if (!ref) {
      return new Response("Ignored", { status: 202 });
    }

    const config = configFromEnv(env);
    const ignoreEvent = shouldIgnoreEvent(eventName, payload, config);
    if (ignoreEvent) {
      return new Response("Ignored", { status: 202 });
    }

    const retryOnCleanComment =
      eventName === "issue_comment" &&
      String(payload?.action ?? "") === "created" &&
      String(payload?.comment?.body ?? "").includes(config.cleanText);
    const retryOnReviewStart = eventMayStartReview(eventName, payload, config);

    // Do the GitHub round-trips after responding so the webhook delivery is
    // acknowledged promptly even if the API calls take a moment.
    ctx.waitUntil(
      evaluateAndReport(env, ref, config, {
        retryOnCleanComment,
        retryOnReviewStart,
        reviewStartRetryDelayMs: parseDelayMs(
          env.REVIEW_START_RETRY_DELAY_MS,
          REVIEW_START_RETRY_DELAY_MS,
        ),
        reviewPendingRetryIntervalMs: parseDelayMs(
          env.REVIEW_PENDING_RETRY_INTERVAL_MS,
          REVIEW_PENDING_RETRY_INTERVAL_MS,
        ),
        reviewPendingRetryAttempts: parseNonNegativeInteger(
          env.REVIEW_PENDING_RETRY_ATTEMPTS,
          REVIEW_PENDING_RETRY_ATTEMPTS,
        ),
      }).catch((error) => {
        console.error(
          `gate evaluation failed for ${ref.owner}/${ref.repo}#${ref.prNumber}:`,
          error,
        );
      }),
    );

    return new Response("Accepted", { status: 202 });
  },
};
