// Cloudflare Worker entrypoint for the review gate.
//
// A single GitHub App delivers webhooks for every installed repository to this
// Worker. For each pull-request event we recompute the gate and report the
// configured commit status on the head SHA. No polling, no cron.

import { evaluateGate, resolveConfig } from "./gate.js";
import { getCachedInstallationToken, RepoClient } from "./github.js";
import {
  pullRequestRefFromEvent,
  shouldIgnoreEvent,
  verifySignature,
} from "./webhook.js";

const CLEAN_COMMENT_RETRY_DELAY_MS = 3_000;
const REVIEW_START_RETRY_DELAY_MS = 15_000;

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

  if (options.retryOnReviewStart && result.state === "failure") {
    await sleep(REVIEW_START_RETRY_DELAY_MS);
    const retryResult = await evaluateFromGitHub(client, ref, config);
    if (retryResult.sha === result.sha) {
      await reportStatus(client, retryResult);
      result = retryResult;
    }
  }

  return result;
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
