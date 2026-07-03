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
const REVIEW_PENDING_RETRY_ATTEMPTS = 2;
const SWEEP_MAX_INSTALLATIONS = 25;
const SWEEP_MAX_REPOSITORIES = 100;
const SWEEP_MAX_PULL_REQUESTS = 50;

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

  const installations = await listAppInstallations(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
  );

  const summary = {
    installations: 0,
    repositories: 0,
    pullRequests: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    limited: false,
  };

  for (const installation of installations) {
    if (summary.installations >= maxInstallations) {
      summary.limited = true;
      break;
    }
    summary.installations += 1;
    const installationId = Number(installation?.id);
    if (!Number.isFinite(installationId)) {
      continue;
    }

    const token = await getCachedInstallationToken(
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
      installationId,
    );
    const repositories = await listInstallationRepositories(token);

    for (const repository of repositories) {
      if (summary.repositories >= maxRepositories) {
        summary.limited = true;
        return summary;
      }
      summary.repositories += 1;

      const owner = String(repository?.owner?.login ?? "");
      const repo = String(repository?.name ?? "");
      if (!owner || !repo) {
        continue;
      }

      const client = new RepoClient(token, owner, repo, config.statusContext);
      let pulls = [];
      try {
        pulls = await client.openPullRequests();
      } catch (error) {
        summary.errors += 1;
        console.error(`scheduled sweep failed to list ${owner}/${repo}:`, error);
        continue;
      }

      for (const pull of pulls) {
        if (summary.pullRequests >= maxPullRequests) {
          summary.limited = true;
          return summary;
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
  // reaction. If the review has only reached the in-progress state, use a small
  // bounded set of re-checks within the webhook's background-task window.
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
  async scheduled(_controller, env, _ctx) {
    const summary = await sweepOpenPullRequests(env, configFromEnv(env));
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
