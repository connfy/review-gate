// Cloudflare Worker entrypoint for the review gate.
//
// A single GitHub App delivers webhooks for every installed repository to this
// Worker. For each pull-request event we recompute the gate and report the
// configured commit status on the head SHA. A light scheduled sweep catches
// changes without a subscribed event, including reactions and direct base pushes.

import {
  evaluateGate,
  extractSettledDispositionShas,
  isSettledDispositionAuthor,
  resolveConfig,
} from "./gate.js";
import {
  getCachedInstallationToken,
  listAppInstallations,
  listInstallationRepositories,
  RepoClient,
} from "./github.js";
import {
  mergedPullRequestBaseRefFromEvent,
  pullRequestRefFromEvent,
  shouldIgnoreEvent,
  verifySignature,
} from "./webhook.js";
import {
  DEFAULT_PENDING_REVIEW_TTL_SECONDS,
  listPendingReviews,
  pendingReviewIdentity,
  settlePendingReview,
  trackPendingReview,
} from "./pending.js";

const CLEAN_COMMENT_RETRY_DELAY_MS = 3_000;
const REVIEW_START_RETRY_DELAY_MS = 15_000;
const REVIEW_PENDING_RETRY_INTERVAL_MS = 7_000;
const REVIEW_PENDING_RETRY_ATTEMPTS = 0;
const SWEEP_MAX_INSTALLATIONS = 10;
const SWEEP_MAX_REPOSITORIES = 4;
const SWEEP_MAX_PENDING_PULL_REQUESTS = 2;
const SWEEP_MAX_PULL_REQUESTS = 2;
const SWEEP_PAGE_SPAN = 10;
const PENDING_REVIEW_TTL_SECONDS = DEFAULT_PENDING_REVIEW_TTL_SECONDS;

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
    statusBoardMarker: env.REVIEW_STATUS_BOARD_MARKER,
    reviewStartWindowMs:
      env.REVIEW_START_WINDOW_MS == null || env.REVIEW_START_WINDOW_MS === ""
        ? undefined
        : Number(env.REVIEW_START_WINDOW_MS),
    botLogins,
    settledDispositionLogins: env.SETTLED_DISPOSITION_LOGINS
      ? env.SETTLED_DISPOSITION_LOGINS.split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined,
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

// A newly created exact settled-disposition command can flip the gate to
// success, but the issue-comments and timeline APIs may not expose it yet when
// the webhook arrives. Reuse the same bounded created-clean-comment retry.
export function eventMayCreateSettledDisposition(eventName, payload, config) {
  return (
    eventName === "issue_comment" &&
    String(payload?.action ?? "") === "created" &&
    isSettledDispositionAuthor(payload?.comment, config) &&
    extractSettledDispositionShas(payload?.comment?.body) !== null
  );
}

export async function reportStatus(client, result) {
  if (result.state === "success") {
    const livePr = await client.pullRequest(result.prNumber);
    const liveSha = String(livePr?.head?.sha ?? "");
    const liveBaseSha = String(livePr?.base?.sha ?? "");
    if (liveSha !== result.sha) {
      return false;
    }
    if (liveBaseSha !== result.baseSha) {
      await client.setStatus(result.sha, {
        state: "failure",
        description: "Pull request changed during evaluation; retry required.",
      });
      return false;
    }
  }

  await client.setStatus(result.sha, {
    state: result.state,
    description: result.description,
    targetUrl: result.targetUrl,
  });
  return true;
}

async function trackPendingReviewSafely(env, ref, result) {
  try {
    await trackPendingReview(env.PENDING_REVIEWS, ref, result, {
      expirationTtl: parsePositiveInteger(
        env.PENDING_REVIEW_TTL_SECONDS,
        PENDING_REVIEW_TTL_SECONDS,
      ),
    });
    return true;
  } catch (error) {
    console.error(
      `pending review tracking failed for ${ref.owner}/${ref.repo}#${ref.prNumber}:`,
      error,
    );
    return false;
  }
}

export function shouldReportStatus(currentStatus, result) {
  if (!currentStatus) {
    return true;
  }
  return (
    String(currentStatus.state ?? "") !== result.state ||
    String(currentStatus.description ?? "") !== result.description ||
    Boolean(
      result.targetUrl &&
        String(currentStatus.target_url ?? "") !== result.targetUrl,
    )
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

  await trackPendingReviewSafely(env, ref, result);

  return result;
}

export async function reevaluateSiblingsAfterMergedPullRequest(
  env,
  eventName,
  payload,
  config,
  options = {},
) {
  const baseRef = mergedPullRequestBaseRefFromEvent(eventName, payload);
  const mergedRef = pullRequestRefFromEvent(eventName, payload);
  if (baseRef === null || mergedRef === null) {
    return [];
  }

  const installationTokenFor =
    options.getInstallationToken ?? getCachedInstallationToken;
  const token = await installationTokenFor(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    mergedRef.installationId,
  );
  const client = (options.clientFactory ??
    ((installationToken, owner, repo) =>
      new RepoClient(
        installationToken,
        owner,
        repo,
        config.statusContext,
      )))(token, mergedRef.owner, mergedRef.repo);
  const pulls = await client.openPullRequests();
  const siblings = pulls.filter(
    (pull) =>
      Number(pull?.number) !== mergedRef.prNumber &&
      String(pull?.base?.ref ?? "") === baseRef,
  );
  const evaluate = options.evaluateAndReport ?? evaluateAndReport;

  const failures = [];
  for (const pull of siblings) {
    try {
      await evaluate(
        env,
        { ...mergedRef, prNumber: Number(pull.number) },
        config,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }

  return siblings.map((pull) => Number(pull.number));
}

function emptyOpenSweepSummary() {
  return {
    installations: 0,
    repositories: 0,
    pullRequests: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    limited: false,
  };
}

export async function sweepPendingPullRequests(env, config, options = {}) {
  const maxPullRequests =
    options.maxPullRequests ??
    parsePositiveInteger(
      env.SWEEP_MAX_PENDING_PULL_REQUESTS,
      SWEEP_MAX_PENDING_PULL_REQUESTS,
    );
  const rotationSeed =
    options.rotationSeed ?? Math.floor(Date.now() / (3 * 60 * 1000));
  const installationTokenFor =
    options.getInstallationToken ?? getCachedInstallationToken;
  const clientFor =
    options.clientFactory ??
    ((token, owner, repo) =>
      new RepoClient(token, owner, repo, config.statusContext));
  const evaluate = options.evaluate ?? evaluateFromGitHub;
  const report = options.reportStatus ?? reportStatus;
  const summary = {
    enabled: Boolean(env.PENDING_REVIEWS?.list),
    queued: 0,
    pullRequests: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    requeued: 0,
    errors: 0,
    limited: false,
    processedRefs: [],
  };

  if (!summary.enabled || maxPullRequests <= 0) {
    return summary;
  }

  let listing;
  try {
    listing = await listPendingReviews(env.PENDING_REVIEWS);
  } catch (error) {
    summary.errors += 1;
    console.error("scheduled pending sweep failed to list queued reviews:", error);
    return summary;
  }

  const rotatedEntries = rotateList(
    listing.entries,
    rotationSeed,
    "pending-review-order",
  );
  const observedEntriesByPullRequest = new Map();
  for (const observedEntry of listing.entries) {
    const identity = pendingReviewIdentity(observedEntry.ref);
    const entriesForPullRequest =
      observedEntriesByPullRequest.get(identity) ?? [];
    entriesForPullRequest.push(observedEntry);
    observedEntriesByPullRequest.set(identity, entriesForPullRequest);
  }
  const seenPullRequests = new Set();
  const entries = rotatedEntries.filter((entry) => {
    const identity = pendingReviewIdentity(entry.ref);
    if (seenPullRequests.has(identity)) {
      return false;
    }
    seenPullRequests.add(identity);
    return true;
  });
  summary.queued = listing.entries.length;
  summary.limited = !listing.listComplete || entries.length > maxPullRequests;

  for (const entry of entries.slice(0, maxPullRequests)) {
    const { installationId, owner, repo, prNumber } = entry.ref;
    summary.pullRequests += 1;
    try {
      const token = await installationTokenFor(
        env.GITHUB_APP_ID,
        env.GITHUB_APP_PRIVATE_KEY,
        installationId,
      );
      const client = clientFor(token, owner, repo);
      const result = await evaluate(client, { prNumber }, config);
      const currentStatus = await client.latestStatusForContext(result.sha);
      if (shouldReportStatus(currentStatus, result)) {
        await report(client, result);
        summary.updated += 1;
      } else {
        summary.unchanged += 1;
      }

      const settlement = await settlePendingReview(
        env.PENDING_REVIEWS,
        entry,
        result,
        {
          observedEntries: observedEntriesByPullRequest.get(
            pendingReviewIdentity(entry.ref),
          ),
          expirationTtl: parsePositiveInteger(
            env.PENDING_REVIEW_TTL_SECONDS,
            PENDING_REVIEW_TTL_SECONDS,
          ),
        },
      );
      if (settlement.action === "removed") {
        summary.removed += 1;
      } else if (settlement.action === "requeued") {
        summary.requeued += 1;
      }
      summary.processedRefs.push(
        pendingReviewIdentity({ owner, repo, prNumber }),
      );
    } catch (error) {
      summary.errors += 1;
      console.error(
        `scheduled pending sweep failed for ${owner}/${repo}#${prNumber}:`,
        error,
      );
    }
  }

  return summary;
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
  const excludedPullRequests = options.excludedPullRequests ?? new Set();
  const listInstallations = options.listInstallations ?? listAppInstallations;
  const installationTokenFor =
    options.getInstallationToken ?? getCachedInstallationToken;
  const listRepositories =
    options.listRepositories ?? listInstallationRepositories;
  const clientFor =
    options.clientFactory ??
    ((token, owner, repo) =>
      new RepoClient(token, owner, repo, config.statusContext));
  const evaluate = options.evaluate ?? evaluateFromGitHub;
  const report = options.reportStatus ?? reportStatus;

  const installations = rotateList(
    await listInstallations(
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
      token = await installationTokenFor(
        env.GITHUB_APP_ID,
        env.GITHUB_APP_PRIVATE_KEY,
        installationId,
      );
      repositories = rotateList(
        await listRepositories(token, {
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

      repositoriesToSweep.push({ token, installationId, owner, repo });
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

    const { token, installationId, owner, repo } = repositories[index];
    const client = clientFor(token, owner, repo);
    const remainingRepositories = repositories.length - index;
    const remainingPullRequestBudget = maxPullRequests - summary.pullRequests;
    const pullRequestLimit = Math.max(
      1,
      Math.ceil(remainingPullRequestBudget / remainingRepositories),
    );
    const candidatePullRequestLimit =
      pullRequestLimit + excludedPullRequests.size;
    let pulls = [];
    try {
      pulls = await client.openPullRequests({
        limit: candidatePullRequestLimit,
        pageOffset: pageOffsetFor(rotationSeed, pageSpan, "pulls", owner, repo),
        pageCursor: pageCursorFor(rotationSeed, "pulls", owner, repo),
      });
      if (pulls.length >= candidatePullRequestLimit) {
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
      const pullIdentity = pendingReviewIdentity({
        owner,
        repo,
        prNumber: pull.number,
      });
      if (excludedPullRequests.has(pullIdentity)) {
        continue;
      }
      summary.pullRequests += 1;

      try {
        const result = await evaluate(
          client,
          { prNumber: Number(pull.number) },
          config,
        );
        const currentStatus = await client.latestStatusForContext(result.sha);
        if (shouldReportStatus(currentStatus, result)) {
          await report(client, result);
          summary.updated += 1;
        } else {
          summary.unchanged += 1;
        }
        await trackPendingReviewSafely(
          env,
          {
            installationId,
            owner,
            repo,
            prNumber: Number(pull.number),
          },
          result,
        );
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

export async function runScheduledSweep(env, config, options = {}) {
  const maxPendingPullRequests =
    options.maxPendingPullRequests ??
    parsePositiveInteger(
      env.SWEEP_MAX_PENDING_PULL_REQUESTS,
      SWEEP_MAX_PENDING_PULL_REQUESTS,
    );
  const maxOpenPullRequests =
    options.maxPullRequests ??
    parsePositiveInteger(env.SWEEP_MAX_PULL_REQUESTS, SWEEP_MAX_PULL_REQUESTS);
  const rotationSeed =
    options.rotationSeed ?? Math.floor(Date.now() / (3 * 60 * 1000));
  const pendingSweep = options.pendingSweep ?? sweepPendingPullRequests;
  const openSweep = options.openSweep ?? sweepOpenPullRequests;
  const pending = await pendingSweep(env, config, {
    maxPullRequests: maxPendingPullRequests,
    rotationSeed,
  });
  const open =
    maxOpenPullRequests > 0
      ? await openSweep(env, config, {
          ...options,
          rotationSeed,
          maxPullRequests: maxOpenPullRequests,
          excludedPullRequests: new Set(pending.processedRefs),
        })
      : emptyOpenSweepSummary();

  const { processedRefs: _processedRefs, ...pendingSummary } = pending;
  return {
    pending: pendingSummary,
    open,
    pullRequests: pending.pullRequests + open.pullRequests,
    updated: pending.updated + open.updated,
    unchanged: pending.unchanged + open.unchanged,
    errors: pending.errors + open.errors,
    limited: pending.limited || open.limited,
  };
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
    const summary = await runScheduledSweep(env, configFromEnv(env), {
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
      (String(payload?.comment?.body ?? "").includes(config.cleanText) ||
        eventMayCreateSettledDisposition(eventName, payload, config));
    const retryOnReviewStart = eventMayStartReview(eventName, payload, config);

    // Do the GitHub round-trips after responding so the webhook delivery is
    // acknowledged promptly even if the API calls take a moment.
    ctx.waitUntil(
      Promise.all([
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
        reevaluateSiblingsAfterMergedPullRequest(
          env,
          eventName,
          payload,
          config,
        ).catch((error) => {
          console.error(
            `same-base reevaluation failed after ${ref.owner}/${ref.repo}#${ref.prNumber} merged:`,
            error,
          );
        }),
      ]),
    );

    return new Response("Accepted", { status: 202 });
  },
};
