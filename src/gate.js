// Pure gate-evaluation logic, shared by the Worker runtime and unit tests.
//
// The gate passes when the configured review bot left a clean review after the
// latest head commit and there are no unresolved current review threads. The
// review bot login(s), the clean-review marker text/reaction, and the status
// context are all configurable so the tool can be reused with any AI/code
// reviewer, not just Codex.

export const DEFAULT_CLEAN_TEXT = "Codex Review: Didn't find any major issues.";
export const DEFAULT_CLEAN_REACTION_CONTENT = "+1";
export const DEFAULT_IN_PROGRESS_REACTION_CONTENT = "eyes";
export const DEFAULT_REVIEW_REQUEST_TEXT = "@codex review";
export const DEFAULT_BOT_LOGINS = Object.freeze([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
export const DEFAULT_SETTLED_DISPOSITION_LOGINS = Object.freeze([]);
export const DEFAULT_STATUS_CONTEXT = "review-gate/codex-clean";
// Codex keeps one live summary comment per PR. It is created when the first
// review starts and edited in place afterwards, so it never marks a finished
// review.
export const DEFAULT_STATUS_BOARD_MARKER =
  "<!-- codex-pull-request-review-summary -->";
// How long a requested review may show no reviewer signal before the gate
// stops awaiting it. Reviews normally start within seconds and finish within
// minutes; a longer silence is a stall that the author must act on.
export const DEFAULT_REVIEW_START_WINDOW_MS = 20 * 60 * 1000;
export const REVIEW_IN_PROGRESS_DESCRIPTION =
  "Review bot is reviewing the latest head.";
export const REVIEW_REQUESTED_DESCRIPTION =
  "Review requested for the latest head; waiting for the review bot.";
export const NO_CLEAN_REVIEW_DESCRIPTION =
  "No clean review pass after the latest head update. Need a clean " +
  "review comment, matching review body, or fresh PR body reaction.";

const HEAD_REF_EVENTS = new Set(["head_ref_force_pushed", "head_ref_restored"]);

export function resolveConfig(config = {}) {
  return {
    cleanText: config.cleanText ?? DEFAULT_CLEAN_TEXT,
    cleanReactionContent:
      config.cleanReactionContent ?? DEFAULT_CLEAN_REACTION_CONTENT,
    inProgressReactionContent:
      config.inProgressReactionContent ?? DEFAULT_IN_PROGRESS_REACTION_CONTENT,
    reviewRequestText: config.reviewRequestText ?? DEFAULT_REVIEW_REQUEST_TEXT,
    botLogins:
      config.botLogins instanceof Set
        ? config.botLogins
        : new Set(config.botLogins ?? DEFAULT_BOT_LOGINS),
    settledDispositionLogins:
      config.settledDispositionLogins instanceof Set
        ? config.settledDispositionLogins
        : new Set(
            config.settledDispositionLogins ??
              DEFAULT_SETTLED_DISPOSITION_LOGINS,
          ),
    statusContext: config.statusContext ?? DEFAULT_STATUS_CONTEXT,
    statusBoardMarker: config.statusBoardMarker ?? DEFAULT_STATUS_BOARD_MARKER,
    reviewStartWindowMs:
      Number.isFinite(config.reviewStartWindowMs) &&
      config.reviewStartWindowMs >= 0
        ? config.reviewStartWindowMs
        : DEFAULT_REVIEW_START_WINDOW_MS,
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

// Server-generated head boundary for the requestless settlement anchor.
// Git author/committer dates are client-controlled: a future-dated commit
// would push a git-derived anchor past every real review and block
// settlement forever. PR creation and head-ref events are stamped by GitHub.
function latestServerHeadBoundaryTime(timelineEvents, prCreatedAt) {
  let boundaryTime = parseTimestamp(prCreatedAt);
  for (const event of timelineEvents) {
    if (!HEAD_REF_EVENTS.has(String(event?.event ?? ""))) {
      continue;
    }
    const eventTime = parseTimestamp(event?.created_at);
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

export function extractSettledDispositionShas(body) {
  const match = String(body ?? "").match(
    /^@review-gate settle ([0-9a-f]{40}) ([0-9a-f]{40})$/,
  );
  return match
    ? {
        headSha: match[1],
        baseSha: match[2],
      }
    : null;
}

export function isSettledDispositionAuthor(comment, config) {
  const { settledDispositionLogins } = resolveConfig(config);
  return (
    String(comment?.user?.type ?? "") === "User" &&
    settledDispositionLogins.has(loginFor(comment?.user))
  );
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

function isReviewRequestComment(comment, config) {
  const { botLogins, reviewRequestText } = resolveConfig(config);
  const author = loginFor(comment?.user ?? comment?.actor);
  return !botLogins.has(author) && includesText(comment?.body, reviewRequestText);
}

function reviewRequestTimestamp(comment, config) {
  return isReviewRequestComment(comment, config)
    ? parseTimestamp(comment?.created_at)
    : null;
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

function latestReviewRequestComment(issueComments, timelineEvents, config) {
  const candidates = [];
  for (const comment of issueComments) {
    if (!isReviewRequestComment(comment, config) || comment?.id == null) {
      continue;
    }
    const timelineIndex = timelineEvents.findIndex(
      (event) =>
        event?.event === "commented" &&
        Number(event?.id) === Number(comment.id),
    );
    if (timelineIndex < 0) {
      return null;
    }
    candidates.push({
      timestamp: parseTimestamp(comment?.created_at),
      timelineIndex,
    });
  }
  // A fresh review request can surface in the already-fetched timeline before
  // the issue-comments endpoint catches up. Include qualifying timeline
  // commented events so a newer timeline-only request still invalidates a
  // prior disposition. Issue-comment candidates are pushed first, so the strict
  // reduce below keeps their timestamp on a same-index tie.
  timelineEvents.forEach((event, index) => {
    if (event?.event === "commented" && isReviewRequestComment(event, config)) {
      candidates.push({
        timestamp: parseTimestamp(event?.created_at),
        timelineIndex: index,
      });
    }
  });
  return candidates.reduce(
    (latest, candidate) =>
      latest === null || candidate.timelineIndex > latest.timelineIndex
        ? candidate
        : latest,
    null,
  );
}

function reviewGeneration(issueComments, timelineEvents, config) {
  let latest = null;
  const consider = (comment) => {
    const timestamp = reviewRequestTimestamp(comment, config);
    if (timestamp === null) {
      return;
    }
    const numericId = Number(comment?.id);
    const id = Number.isFinite(numericId) ? numericId : null;
    if (
      latest === null ||
      timestamp > latest.timestamp ||
      (timestamp === latest.timestamp && id !== null && id > (latest.id ?? -1))
    ) {
      latest = { timestamp, id };
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

  if (latest === null) {
    return "head";
  }
  return latest.id === null
    ? `request-time:${latest.timestamp}`
    : `request:${latest.id}`;
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

function botReactionQualifies(reaction, content, boundary, config) {
  const { botLogins } = resolveConfig(config);
  const author = loginFor(reaction?.user);
  const reactionTime = parseTimestamp(reaction?.created_at);
  return (
    botLogins.has(author) &&
    String(reaction?.content ?? "") === content &&
    reactionTime !== null &&
    boundary.timestamp !== null &&
    reactionTime >= boundary.timestamp
  );
}

function issueBodyReactionQualifies(reaction, boundary, config) {
  const { cleanReactionContent } = resolveConfig(config);
  return botReactionQualifies(reaction, cleanReactionContent, boundary, config);
}

function issueBodyInProgressReactionQualifies(reaction, boundary, config) {
  const { inProgressReactionContent } = resolveConfig(config);
  return botReactionQualifies(
    reaction,
    inProgressReactionContent,
    boundary,
    config,
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

function reviewRequestReactionQualifies(group, boundary, config) {
  const { botLogins, inProgressReactionContent } = resolveConfig(config);
  const requestTime = reviewRequestTimestamp(group?.comment, config);
  if (
    requestTime === null ||
    boundary.timestamp === null ||
    requestTime < boundary.timestamp
  ) {
    return null;
  }

  for (const reaction of group?.reactions ?? []) {
    const author = loginFor(reaction?.user);
    const reactionTime = parseTimestamp(reaction?.created_at);
    if (
      botLogins.has(author) &&
      String(reaction?.content ?? "") === inProgressReactionContent &&
      reactionTime !== null &&
      reactionTime >= requestTime
    ) {
      return {
        detail: `review request ${inProgressReactionContent} reaction at ${reaction?.created_at}`,
        timestamp: reactionTime,
      };
    }
  }

  return null;
}

function reviewInProgressEvents({
  sha,
  issueComments,
  issueEyesReactions,
  reviewRequestReactions,
  timelineEvents,
  config,
}) {
  const boundary = cleanReactionBoundary({
    sha,
    issueComments,
    timelineEvents,
    config,
  });
  const events = [];

  for (const reaction of issueEyesReactions) {
    if (issueBodyInProgressReactionQualifies(reaction, boundary, config)) {
      const { inProgressReactionContent } = resolveConfig(config);
      events.push({
        detail: `PR body ${inProgressReactionContent} reaction at ${reaction?.created_at}`,
        timestamp: parseTimestamp(reaction?.created_at) ?? boundary.timestamp,
      });
    }
  }

  for (const group of reviewRequestReactions) {
    const event = reviewRequestReactionQualifies(group, boundary, config);
    if (event !== null) {
      events.push(event);
    }
  }

  return events;
}

function latestReviewBotResponseTime({
  sha,
  issueComments,
  reviews,
  timelineEvents,
  config,
}) {
  const { botLogins, statusBoardMarker } = resolveConfig(config);
  const headBoundaryTime = latestHeadBoundaryTime(timelineEvents, sha);
  let latest = null;
  const updateLatest = (timestamp) => {
    if (timestamp !== null) {
      latest = latest === null ? timestamp : Math.max(latest, timestamp);
    }
  };

  for (const comment of issueComments) {
    const author = loginFor(comment?.user);
    if (!botLogins.has(author)) {
      continue;
    }
    const body = String(comment?.body ?? "");
    if (statusBoardMarker && body.includes(statusBoardMarker)) {
      continue;
    }
    const reviewedPrefix = extractReviewedCommitPrefix(body);
    const commentTime = parseTimestamp(comment?.created_at);
    if (
      shaMatchesPrefix(sha, reviewedPrefix) ||
      (headBoundaryTime !== null &&
        commentTime !== null &&
        commentTime >= headBoundaryTime)
    ) {
      updateLatest(commentTime);
    }
  }

  for (const review of reviews) {
    const author = loginFor(review?.user);
    if (
      botLogins.has(author) &&
      String(review?.commit_id ?? "") === sha
    ) {
      updateLatest(parseTimestamp(review?.submitted_at));
    }
  }

  return latest;
}

function reviewIsInProgress({
  sha,
  issueComments,
  issueEyesReactions,
  reviews,
  reviewRequestReactions,
  timelineEvents,
  config,
}) {
  const latestInProgressTime = reviewInProgressEvents({
    sha,
    issueComments,
    issueEyesReactions,
    reviewRequestReactions,
    timelineEvents,
    config,
  }).reduce(
    (latest, event) =>
      latest === null ? event.timestamp : Math.max(latest, event.timestamp),
    null,
  );
  if (latestInProgressTime === null) {
    return false;
  }
  const latestBotResponseTime = latestReviewBotResponseTime({
    sha,
    issueComments,
    reviews,
    timelineEvents,
    config,
  });
  return (
    latestBotResponseTime === null ||
    latestBotResponseTime < latestInProgressTime
  );
}

function settledDisposition({
  sha,
  baseSha,
  prCreatedAt,
  issueComments,
  issueEyesReactions,
  reviews,
  reviewRequestReactions,
  timelineEvents,
  config,
}) {
  const resolved = resolveConfig(config);
  if (resolved.settledDispositionLogins.size === 0) {
    return null;
  }

  const headBoundaryIndex = latestHeadBoundaryIndex(timelineEvents, sha);
  if (headBoundaryIndex === null) {
    return null;
  }
  const request = latestReviewRequestComment(
    issueComments,
    timelineEvents,
    resolved,
  );
  const requestObserved =
    issueComments.some((comment) => isReviewRequestComment(comment, resolved)) ||
    timelineEvents.some(
      (event) =>
        event?.event === "commented" && isReviewRequestComment(event, resolved),
    );
  let anchorTime = null;
  if (request !== null) {
    if (request.timestamp === null || request.timelineIndex <= headBoundaryIndex) {
      return null;
    }
    anchorTime = request.timestamp;
  } else if (requestObserved) {
    // A request comment exists but cannot be correlated to the timeline yet
    // (fetch lag). A fresh request must invalidate settlement, so fail closed.
    return null;
  } else {
    // Auto-fired round: no review-request comment exists for this PR at all
    // (the initial review fires on open/ready). A server-generated boundary
    // anchors the round in place of a request comment; commit_id binding on
    // the qualifying review keeps an early anchor safe.
    anchorTime = latestServerHeadBoundaryTime(timelineEvents, prCreatedAt);
  }
  if (anchorTime === null) {
    return null;
  }
  if (
    reviewIsInProgress({
      sha,
      issueComments,
      issueEyesReactions,
      reviews,
      reviewRequestReactions,
      timelineEvents,
      config: resolved,
    })
  ) {
    return null;
  }

  let latest = null;
  for (const comment of issueComments) {
    const attestedPair = extractSettledDispositionShas(comment?.body);
    if (
      !isSettledDispositionAuthor(comment, resolved) ||
      attestedPair?.headSha !== sha ||
      attestedPair?.baseSha !== baseSha
    ) {
      continue;
    }
    const timestamp = parseTimestamp(comment?.created_at);
    const timelineIndex = timelineEvents.findIndex(
      (event) =>
        event?.event === "commented" &&
        Number(event?.id) === Number(comment?.id),
    );
    if (timestamp === null || timelineIndex < 0) {
      continue;
    }
    const hasQualifyingReview = reviews.some(
      (review) =>
        resolved.botLogins.has(loginFor(review?.user)) &&
        String(review?.state ?? "").toLowerCase() !== "dismissed" &&
        String(review?.commit_id ?? "") === sha &&
        parseTimestamp(review?.submitted_at) > anchorTime &&
        parseTimestamp(review?.submitted_at) < timestamp,
    );
    const url = String(comment?.html_url ?? "");
    if (!hasQualifyingReview || url.length === 0) {
      continue;
    }
    if (
      latest === null ||
      timestamp > latest.timestamp ||
      (timestamp === latest.timestamp && timelineIndex > latest.timelineIndex)
    ) {
      latest = {
        timestamp,
        timelineIndex,
        login: loginFor(comment.user),
        url,
        detail:
          `settled disposition by @${loginFor(comment.user)} for ` +
          `head ${sha} and base ${baseSha} at ${comment.created_at}`,
      };
    }
  }

  return latest;
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
    `Review bot PR body ${cleanReactionContent} reaction at ` +
    `${latestReaction.createdAt} is stale; it predates the ${source}. ` +
    "Re-request a review."
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
      return `Review bot reviewed ${reviewedPrefix}, but head is now ${String(sha).slice(0, 12)}. Re-request a review.`;
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
      return "Review bot clean review is stale: a newer commit landed after the review. Re-request a review.";
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

// A review that was requested for the current head, by opening the PR, marking
// it ready, or an explicit request comment, and that has produced no review bot
// response since. Only server-generated timestamps anchor the request. The
// result can only turn a failure into pending, never into success.
function awaitedReviewRequest({
  pr,
  sha,
  issueComments,
  reviews,
  timelineEvents,
  now,
  config,
}) {
  const { reviewStartWindowMs } = resolveConfig(config);
  const headBoundaryTime = latestHeadBoundaryTime(timelineEvents, sha);
  if (headBoundaryTime === null) {
    return null;
  }

  const starts = [];
  const openedAt = parseTimestamp(pr?.created_at);
  if (openedAt !== null) {
    starts.push({ timestamp: openedAt, detail: `PR opened at ${pr.created_at}` });
  }
  for (const event of timelineEvents) {
    if (event?.event !== "ready_for_review") {
      continue;
    }
    const readyAt = parseTimestamp(event?.created_at);
    if (readyAt !== null) {
      starts.push({
        timestamp: readyAt,
        detail: `PR marked ready at ${event.created_at}`,
      });
    }
  }
  const requestedAt = latestReviewRequestTime(
    issueComments,
    timelineEvents,
    config,
  );
  if (requestedAt !== null) {
    starts.push({
      timestamp: requestedAt,
      detail: `review requested at ${new Date(requestedAt).toISOString()}`,
    });
  }

  const latestStart = starts.reduce(
    (latest, start) =>
      latest === null || start.timestamp > latest.timestamp ? start : latest,
    null,
  );
  if (
    latestStart === null ||
    latestStart.timestamp < headBoundaryTime ||
    now - latestStart.timestamp > reviewStartWindowMs
  ) {
    return null;
  }

  const latestResponseTime = latestReviewBotResponseTime({
    sha,
    issueComments,
    reviews,
    timelineEvents,
    config,
  });
  if (latestResponseTime !== null && latestResponseTime >= latestStart.timestamp) {
    return null;
  }
  return latestStart;
}

export function evaluateGate({
  pr,
  issueComments = [],
  issueReactions = [],
  issueEyesReactions = [],
  reviews = [],
  reviewThreads = [],
  reviewRequestReactions = [],
  timelineEvents = [],
  config,
  now = Date.now(),
}) {
  const resolved = resolveConfig(config);
  const prNumber = Number(pr.number);
  const sha = String(pr.head.sha);
  const baseSha = String(pr.base?.sha ?? "");
  const prState = String(pr.state ?? "open");
  const generation = reviewGeneration(
    issueComments,
    timelineEvents,
    resolved,
  );
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
  let disposition = null;
  if (cleanEvents.length === 0) {
    disposition = settledDisposition({
      sha,
      baseSha,
      prCreatedAt: pr?.created_at,
      issueComments,
      issueEyesReactions,
      reviews,
      reviewRequestReactions,
      timelineEvents,
      config: resolved,
    });
    if (disposition !== null) {
      cleanEvents.push(disposition.detail);
    }
  }
  if (cleanEvents.length === 0) {
    const inProgressEvents = reviewInProgressEvents({
      sha,
      issueComments,
      issueEyesReactions,
      reviewRequestReactions,
      timelineEvents,
      config: resolved,
    });
    const latestInProgressTime = inProgressEvents.reduce(
      (latestTime, event) =>
        latestTime === null
          ? event.timestamp
          : Math.max(latestTime, event.timestamp),
      null,
    );
    const latestBotResponseTime = latestReviewBotResponseTime({
      sha,
      issueComments,
      reviews,
      timelineEvents,
      config: resolved,
    });
    const botFinishedReview =
      latestInProgressTime !== null &&
      latestBotResponseTime !== null &&
      latestBotResponseTime >= latestInProgressTime;
    if (
      details.length === 0 &&
      inProgressEvents.length > 0 &&
      !botFinishedReview
    ) {
      return {
        prNumber,
        sha,
        baseSha,
        prState,
        generation,
        state: "pending",
        description: REVIEW_IN_PROGRESS_DESCRIPTION,
        details: inProgressEvents.map((event) => event.detail),
      };
    }

    // A requested review often shows no in-progress signal for a while, and
    // GitHub sends no webhook when the bot later reacts. Reporting pending
    // keeps the PR in the priority queue so the reaction is seen by the next
    // scheduled sweep instead of the slow repository rotation.
    const awaitedRequest =
      details.length === 0
        ? awaitedReviewRequest({
            pr,
            sha,
            issueComments,
            reviews,
            timelineEvents,
            now,
            config: resolved,
          })
        : null;
    if (awaitedRequest !== null) {
      return {
        prNumber,
        sha,
        baseSha,
        prState,
        generation,
        state: "pending",
        description: REVIEW_REQUESTED_DESCRIPTION,
        details: [awaitedRequest.detail],
      };
    }

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
        NO_CLEAN_REVIEW_DESCRIPTION,
    );
  }

  if (details.length > 0) {
    return {
      prNumber,
      sha,
      baseSha,
      prState,
      generation,
      state: "failure",
      description: summarizeFailureDetails(details),
      details,
    };
  }

  return {
    prNumber,
    sha,
    baseSha,
    prState,
    generation,
    state: "success",
    description:
      disposition === null
        ? "Review gate passed."
        : `Settled by @${disposition.login} for head ${sha.slice(0, 12)} on base ${baseSha.slice(0, 12)}.`,
    details: cleanEvents,
    ...(disposition?.url ? { targetUrl: disposition.url } : {}),
  };
}
