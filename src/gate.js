// Pure gate-evaluation logic, shared by the Worker runtime and unit tests.
//
// The gate passes when the configured review bot left a clean review after the
// latest head commit and there are no unresolved current review threads. The
// review bot login(s), the clean-review marker text/reaction, and the status
// context are all configurable so the tool can be reused with any AI/code
// reviewer, not just Codex.

export const DEFAULT_CLEAN_TEXT = "Codex Review: Didn't find any major issues.";
export const DEFAULT_CLEAN_REACTION_CONTENT = "+1";
export const DEFAULT_REVIEW_REQUEST_TEXT = "@codex review";
export const DEFAULT_BOT_LOGINS = Object.freeze([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
export const DEFAULT_STATUS_CONTEXT = "review-gate/codex-clean";

const HEAD_REF_EVENTS = new Set(["head_ref_force_pushed", "head_ref_restored"]);

export function resolveConfig(config = {}) {
  return {
    cleanText: config.cleanText ?? DEFAULT_CLEAN_TEXT,
    cleanReactionContent:
      config.cleanReactionContent ?? DEFAULT_CLEAN_REACTION_CONTENT,
    reviewRequestText: config.reviewRequestText ?? DEFAULT_REVIEW_REQUEST_TEXT,
    botLogins:
      config.botLogins instanceof Set
        ? config.botLogins
        : new Set(config.botLogins ?? DEFAULT_BOT_LOGINS),
    statusContext: config.statusContext ?? DEFAULT_STATUS_CONTEXT,
  };
}

function loginFor(user) {
  if (!user || typeof user !== "object") {
    return "";
  }
  return String(user.login ?? "");
}

function latestHeadBoundaryIndex(timelineEvents, sha) {
  let boundaryIndex = null;
  timelineEvents.forEach((event, index) => {
    const eventName = String(event?.event ?? "");
    const isCurrentHeadCommit =
      eventName === "committed" && String(event?.sha ?? "") === sha;
    if (isCurrentHeadCommit || HEAD_REF_EVENTS.has(eventName)) {
      boundaryIndex = index;
    }
  });
  return boundaryIndex;
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function timelineEventTimestamp(event) {
  return (
    parseTimestamp(event?.created_at) ??
    parseTimestamp(event?.committer?.date) ??
    parseTimestamp(event?.author?.date)
  );
}

function latestHeadBoundaryTime(timelineEvents, sha) {
  let boundaryTime = null;
  for (const event of timelineEvents) {
    const eventName = String(event?.event ?? "");
    const isCurrentHeadCommit =
      eventName === "committed" && String(event?.sha ?? "") === sha;
    if (!isCurrentHeadCommit && !HEAD_REF_EVENTS.has(eventName)) {
      continue;
    }
    const eventTime = timelineEventTimestamp(event);
    if (eventTime !== null) {
      boundaryTime =
        boundaryTime === null ? eventTime : Math.max(boundaryTime, eventTime);
    }
  }
  return boundaryTime;
}

function issueCommentIdsAfterHead(timelineEvents, sha) {
  const boundaryIndex = latestHeadBoundaryIndex(timelineEvents, sha);
  const commentIds = new Set();
  if (boundaryIndex === null) {
    return commentIds;
  }
  for (const event of timelineEvents.slice(boundaryIndex + 1)) {
    if (event?.event === "commented" && event?.id != null) {
      commentIds.add(Number(event.id));
    }
  }
  return commentIds;
}

function includesText(body, text) {
  const needle = String(text ?? "");
  if (needle.length === 0) {
    return false;
  }
  return String(body ?? "").toLowerCase().includes(needle.toLowerCase());
}

export function extractReviewedCommitPrefix(body) {
  const match = String(body ?? "").match(
    /\*\*Reviewed commit:\*\*\s*`([0-9a-f]+)`/i,
  );
  return match?.[1] ?? null;
}

function shaMatchesPrefix(fullSha, prefix) {
  if (!prefix) {
    return false;
  }
  return String(fullSha).toLowerCase().startsWith(String(prefix).toLowerCase());
}

function reviewRequestTimestamp(comment, config) {
  const { botLogins, reviewRequestText } = resolveConfig(config);
  const author = loginFor(comment?.user ?? comment?.actor);
  if (botLogins.has(author) || !includesText(comment?.body, reviewRequestText)) {
    return null;
  }
  return parseTimestamp(comment?.created_at);
}

function latestReviewRequestTime(issueComments, timelineEvents, config) {
  let latest = null;
  const consider = (comment) => {
    const timestamp = reviewRequestTimestamp(comment, config);
    if (timestamp !== null) {
      latest = latest === null ? timestamp : Math.max(latest, timestamp);
    }
  };

  for (const comment of issueComments) {
    consider(comment);
  }
  for (const event of timelineEvents) {
    if (event?.event === "commented") {
      consider(event);
    }
  }

  return latest;
}

function cleanReactionBoundary({ sha, issueComments, timelineEvents, config }) {
  const headBoundaryTime = latestHeadBoundaryTime(timelineEvents, sha);
  const requestBoundaryTime = latestReviewRequestTime(
    issueComments,
    timelineEvents,
    config,
  );
  const boundaryTimes = [headBoundaryTime, requestBoundaryTime].filter(
    (timestamp) => timestamp !== null,
  );
  if (boundaryTimes.length === 0) {
    return { timestamp: null, source: null };
  }
  const timestamp = Math.max(...boundaryTimes);
  return {
    timestamp,
    source:
      requestBoundaryTime !== null && requestBoundaryTime === timestamp
        ? "latest review request"
        : "latest head update",
  };
}

function issueCommentQualifies(comment, sha, timelineEvents, config) {
  const { cleanText, botLogins } = resolveConfig(config);
  const author = loginFor(comment?.user);
  const body = String(comment?.body ?? "");
  if (!botLogins.has(author) || !body.includes(cleanText)) {
    return false;
  }

  const reviewedPrefix = extractReviewedCommitPrefix(body);
  if (reviewedPrefix) {
    return shaMatchesPrefix(sha, reviewedPrefix);
  }

  const idsAfterHead = issueCommentIdsAfterHead(timelineEvents, sha);
  return idsAfterHead.has(Number(comment?.id));
}

function issueBodyReactionQualifies(reaction, boundary, config) {
  const { cleanReactionContent, botLogins } = resolveConfig(config);
  const author = loginFor(reaction?.user);
  const reactionTime = parseTimestamp(reaction?.created_at);
  return (
    botLogins.has(author) &&
    String(reaction?.content ?? "") === cleanReactionContent &&
    reactionTime !== null &&
    boundary.timestamp !== null &&
    reactionTime >= boundary.timestamp
  );
}

function cleanBodyReactions({
  sha,
  issueComments,
  issueReactions,
  timelineEvents,
  config,
}) {
  const boundary = cleanReactionBoundary({
    sha,
    issueComments,
    timelineEvents,
    config,
  });
  const cleanEvents = [];
  for (const reaction of issueReactions) {
    if (issueBodyReactionQualifies(reaction, boundary, config)) {
      cleanEvents.push(`clean PR body reaction at ${reaction?.created_at}`);
    }
  }
  return cleanEvents;
}

function cleanCommentsFromTimeline(timelineEvents, sha, config) {
  const boundaryIndex = latestHeadBoundaryIndex(timelineEvents, sha);
  if (boundaryIndex === null) {
    return [];
  }

  const { cleanText, botLogins } = resolveConfig(config);
  const cleanEvents = [];
  for (const event of timelineEvents.slice(boundaryIndex + 1)) {
    if (event?.event !== "commented") {
      continue;
    }
    const author = loginFor(event?.user ?? event?.actor);
    const body = String(event?.body ?? "");
    if (!botLogins.has(author) || !body.includes(cleanText)) {
      continue;
    }
    const reviewedPrefix = extractReviewedCommitPrefix(body);
    if (reviewedPrefix && !shaMatchesPrefix(sha, reviewedPrefix)) {
      continue;
    }
    cleanEvents.push(
      `clean review comment at ${event?.created_at ?? "unknown"}`,
    );
  }
  return cleanEvents;
}

function findStaleCleanReaction({
  sha,
  issueComments,
  issueReactions,
  timelineEvents,
  config,
}) {
  const { cleanReactionContent, botLogins } = resolveConfig(config);
  const boundary = cleanReactionBoundary({
    sha,
    issueComments,
    timelineEvents,
    config,
  });
  if (boundary.timestamp === null) {
    return null;
  }

  let latestReaction = null;
  for (const reaction of issueReactions) {
    if (
      !botLogins.has(loginFor(reaction?.user)) ||
      String(reaction?.content ?? "") !== cleanReactionContent
    ) {
      continue;
    }
    if (issueBodyReactionQualifies(reaction, boundary, config)) {
      return null;
    }

    const reactionTime = parseTimestamp(reaction?.created_at);
    if (reactionTime === null) {
      continue;
    }
    if (latestReaction === null || reactionTime > latestReaction.timestamp) {
      latestReaction = {
        timestamp: reactionTime,
        createdAt: reaction.created_at,
      };
    }
  }

  if (latestReaction === null) {
    return null;
  }

  const source =
    boundary.source === "latest review request"
      ? "latest review request"
      : "latest head update";
  return (
    `Codex PR body ${cleanReactionContent} reaction at ` +
    `${latestReaction.createdAt} is stale; it predates the ${source}. ` +
    "Re-request @codex review."
  );
}

function findStaleCleanReview({ sha, issueComments, timelineEvents, config }) {
  const { cleanText, botLogins } = resolveConfig(config);
  for (const comment of issueComments) {
    const author = loginFor(comment?.user);
    const body = String(comment?.body ?? "");
    if (!botLogins.has(author) || !body.includes(cleanText)) {
      continue;
    }
    if (issueCommentQualifies(comment, sha, timelineEvents, config)) {
      continue;
    }

    const reviewedPrefix = extractReviewedCommitPrefix(body);
    if (reviewedPrefix && !shaMatchesPrefix(sha, reviewedPrefix)) {
      return `Codex reviewed ${reviewedPrefix}, but head is now ${String(sha).slice(0, 12)}. Re-request @codex review.`;
    }

    const boundaryIndex = latestHeadBoundaryIndex(timelineEvents, sha);
    const commentIndex = timelineEvents.findIndex(
      (event) =>
        event?.event === "commented" &&
        Number(event?.id) === Number(comment?.id),
    );
    if (
      boundaryIndex !== null &&
      commentIndex >= 0 &&
      commentIndex <= boundaryIndex
    ) {
      return "Codex clean review is stale: a newer commit landed after the review. Re-request @codex review.";
    }
  }
  return null;
}

export function summarizeFailureDetails(details) {
  return details[0]?.slice(0, 140) ?? "A clean review is required before merge.";
}

export function codexCleanEvents({
  sha,
  issueComments = [],
  issueReactions = [],
  reviews = [],
  timelineEvents = [],
  config,
}) {
  const { cleanText, botLogins } = resolveConfig(config);
  const cleanEvents = cleanCommentsFromTimeline(timelineEvents, sha, config);
  cleanEvents.push(
    ...cleanBodyReactions({
      sha,
      issueComments,
      issueReactions,
      timelineEvents,
      config,
    }),
  );

  for (const comment of issueComments) {
    if (issueCommentQualifies(comment, sha, timelineEvents, config)) {
      cleanEvents.push(`clean review comment at ${comment?.created_at}`);
    }
  }

  for (const review of reviews) {
    const author = loginFor(review?.user);
    const body = String(review?.body ?? "");
    const submittedAt = review?.submitted_at;
    if (!submittedAt) {
      continue;
    }
    if (
      botLogins.has(author) &&
      body.includes(cleanText) &&
      String(review?.commit_id ?? "") === sha
    ) {
      cleanEvents.push(`clean review body at ${submittedAt}`);
    }
  }

  return cleanEvents;
}

export function evaluateGate({
  pr,
  issueComments = [],
  issueReactions = [],
  reviews = [],
  reviewThreads = [],
  timelineEvents = [],
  config,
}) {
  const resolved = resolveConfig(config);
  const prNumber = Number(pr.number);
  const sha = String(pr.head.sha);
  const details = [];

  if (pr.draft) {
    details.push("PR is draft; the initial review may not run.");
  }

  const unresolvedCurrent = reviewThreads.filter(
    (thread) => !thread?.isResolved && !thread?.isOutdated,
  );
  if (unresolvedCurrent.length > 0) {
    details.push(
      `${unresolvedCurrent.length} unresolved current review thread(s).`,
    );
  }

  const cleanEvents = codexCleanEvents({
    sha,
    issueComments,
    issueReactions,
    reviews,
    timelineEvents,
    config: resolved,
  });
  if (cleanEvents.length === 0) {
    const staleReview = findStaleCleanReview({
      sha,
      issueComments,
      timelineEvents,
      config: resolved,
    });
    const staleReaction = findStaleCleanReaction({
      sha,
      issueComments,
      issueReactions,
      timelineEvents,
      config: resolved,
    });
    details.push(
      staleReview ??
        staleReaction ??
        "No clean review pass after the latest head update. Need a clean " +
          "review comment, matching review body, or fresh PR body reaction.",
    );
  }

  if (details.length > 0) {
    return {
      prNumber,
      sha,
      state: "failure",
      description: summarizeFailureDetails(details),
      details,
    };
  }

  return {
    prNumber,
    sha,
    state: "success",
    description: "Review gate passed.",
    details: cleanEvents,
  };
}
