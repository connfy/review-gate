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
export const DEFAULT_SETTLED_DISPOSITION_COMMAND = "@review-gate settle";
export const DEFAULT_BOT_LOGINS = Object.freeze([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
export const DEFAULT_SETTLED_DISPOSITION_LOGINS = Object.freeze([]);
export const DEFAULT_STATUS_CONTEXT = "review-gate/codex-clean";
export const REVIEW_IN_PROGRESS_DESCRIPTION =
  "Review bot is reviewing the latest head.";
export const REVIEW_EVIDENCE_CHANGED_DESCRIPTION =
  "Review evidence changed; a new exact-head disposition is required.";
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
    settledDispositionCommand:
      config.settledDispositionCommand ?? DEFAULT_SETTLED_DISPOSITION_COMMAND,
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

function issueCommentTimelineEvent(timelineEvents, comment) {
  const numericId = Number(comment?.id);
  const commentId = Number.isFinite(numericId) ? numericId : null;
  const commentTime = parseTimestamp(comment?.created_at);
  return (
    timelineEvents.find((event) => {
      if (event?.event !== "commented") {
        return false;
      }
      const eventNumericId = Number(event?.id);
      const eventId = Number.isFinite(eventNumericId) ? eventNumericId : null;
      if (commentId !== null && eventId !== null) {
        return eventId === commentId;
      }
      if (commentId !== null || eventId !== null) {
        return false;
      }
      const eventTime = timelineEventTimestamp(event);
      return (
        commentTime !== null &&
        eventTime === commentTime &&
        loginFor(event?.user ?? event?.actor) === loginFor(comment?.user) &&
        String(event?.body ?? "") === String(comment?.body ?? "")
      );
    }) ?? null
  );
}

function includesText(body, text) {
  const needle = String(text ?? "");
  if (needle.length === 0) {
    return false;
  }
  return String(body ?? "").toLowerCase().includes(needle.toLowerCase());
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractSettledDispositionSha(body, config) {
  const { settledDispositionCommand } = resolveConfig(config);
  const command = String(settledDispositionCommand ?? "").trim();
  if (command.length === 0) {
    return null;
  }
  const match = String(body ?? "").match(
    new RegExp(`^\\s*${escapeRegExp(command)}\\s+([0-9a-f]{40})\\s*$`, "i"),
  );
  return match?.[1]?.toLowerCase() ?? null;
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

function reviewRequestTimestamp(comment, config) {
  const { botLogins, reviewRequestText } = resolveConfig(config);
  const author = loginFor(comment?.user ?? comment?.actor);
  if (botLogins.has(author) || !includesText(comment?.body, reviewRequestText)) {
    return null;
  }
  return parseTimestamp(comment?.updated_at) ?? parseTimestamp(comment?.created_at);
}

function latestReviewRequestTime(issueComments, timelineEvents, config) {
  return (
    latestReviewRequest(issueComments, timelineEvents, config)?.timestamp ?? null
  );
}

function latestReviewRequest(issueComments, timelineEvents, config) {
  let latest = null;
  const consider = (comment) => {
    const timestamp = reviewRequestTimestamp(comment, config);
    if (timestamp !== null) {
      const numericId = Number(comment?.id);
      const id = Number.isFinite(numericId) ? numericId : null;
      if (
        latest === null ||
        timestamp > latest.timestamp ||
        (timestamp === latest.timestamp && id !== null && id > (latest.id ?? -1))
      ) {
        latest = { timestamp, id };
      }
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

function reviewGeneration(issueComments, timelineEvents, config) {
  const latest = latestReviewRequest(issueComments, timelineEvents, config);
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

  const boundaryIndex = latestHeadBoundaryIndex(timelineEvents, sha);
  const timelineEvent = issueCommentTimelineEvent(timelineEvents, comment);
  return (
    boundaryIndex !== null &&
    timelineEvent !== null &&
    timelineEvents.indexOf(timelineEvent) > boundaryIndex
  );
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
  const { botLogins } = resolveConfig(config);
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

function currentHeadReviewBotResponses({
  sha,
  issueComments,
  reviews,
  timelineEvents,
  config,
}) {
  const { botLogins, cleanText } = resolveConfig(config);
  const responses = [];

  for (const comment of issueComments) {
    if (!botLogins.has(loginFor(comment?.user))) {
      continue;
    }
    const body = String(comment?.body ?? "");
    const reviewedPrefix = extractReviewedCommitPrefix(body);
    const timelineEvent = issueCommentTimelineEvent(timelineEvents, comment);
    const timelineIndex =
      timelineEvent === null ? null : timelineEvents.indexOf(timelineEvent);
    const qualifies =
      shaMatchesPrefix(sha, reviewedPrefix) ||
      (includesText(body, cleanText) &&
        issueCommentQualifies(comment, sha, timelineEvents, config));
    const createdTime = parseTimestamp(comment?.created_at);
    const updatedTime = parseTimestamp(comment?.updated_at);
    const timestamp = updatedTime ?? createdTime;
    const wasEdited =
      createdTime !== null && updatedTime !== null && updatedTime !== createdTime;
    if (qualifies && timestamp !== null) {
      responses.push({
        timestamp,
        timelineIndex: wasEdited ? null : timelineIndex,
        detail: `review bot comment at ${comment.created_at}`,
      });
    }
  }

  for (const review of reviews) {
    const timestamp = parseTimestamp(review?.submitted_at);
    if (
      botLogins.has(loginFor(review?.user)) &&
      String(review?.commit_id ?? "") === sha &&
      String(review?.state ?? "").toLowerCase() !== "dismissed" &&
      timestamp !== null
    ) {
      const reviewId = Number(review?.id);
      const timelineEvent = Number.isFinite(reviewId)
        ? timelineEvents.find(
            (event) =>
              event?.event === "reviewed" &&
              Number(event?.id) === reviewId,
          )
        : undefined;
      responses.push({
        timestamp,
        timelineIndex:
          timelineEvent === undefined
            ? null
            : timelineEvents.indexOf(timelineEvent),
        detail: `review bot review at ${review.submitted_at}`,
      });
    }
  }

  return responses;
}

function latestTimestampedEvent(events) {
  if (events.length === 0) {
    return null;
  }
  const latestTimestamp = Math.max(...events.map((event) => event.timestamp));
  const latestEvents = events.filter(
    (event) => event.timestamp === latestTimestamp,
  );
  if (latestEvents.some((event) => event.timelineIndex === null)) {
    return null;
  }
  return latestEvents.reduce((latest, event) =>
    latest === null || event.timelineIndex > latest.timelineIndex
      ? event
      : latest,
  );
}

function reviewEvidenceChangeBoundary(currentStatus) {
  if (
    String(currentStatus?.state ?? "") !== "failure" ||
    String(currentStatus?.description ?? "") !==
      REVIEW_EVIDENCE_CHANGED_DESCRIPTION
  ) {
    return null;
  }
  return {
    timestamp:
      parseTimestamp(currentStatus?.created_at) ?? Number.POSITIVE_INFINITY,
    targetUrl: String(
      currentStatus?.target_url ?? currentStatus?.targetUrl ?? "",
    ),
  };
}

function settledDisposition({
  sha,
  issueComments,
  issueEyesReactions,
  reviews,
  reviewRequestReactions,
  timelineEvents,
  currentStatus,
  config,
}) {
  const resolved = resolveConfig(config);
  if (resolved.settledDispositionLogins.size === 0) {
    return null;
  }

  const headBoundaryIndex = latestHeadBoundaryIndex(timelineEvents, sha);
  const headBoundaryTime = latestHeadBoundaryTime(timelineEvents, sha);
  const request = latestReviewRequest(issueComments, [], resolved);
  if (
    headBoundaryIndex === null ||
    headBoundaryTime === null ||
    request === null ||
    request.id === null
  ) {
    return null;
  }

  const requestTimelineEvent = timelineEvents.find(
    (event) =>
      event?.event === "commented" &&
      Number(event?.id) === Number(request.id),
  );
  const requestTimelineIndex =
    requestTimelineEvent == null
      ? null
      : timelineEvents.indexOf(requestTimelineEvent);
  const requestComment = issueComments.find(
    (comment) => Number(comment?.id) === Number(request.id),
  );
  const requestCreatedTime = parseTimestamp(requestComment?.created_at);
  const requestUpdatedTime = parseTimestamp(requestComment?.updated_at);
  const requestWasEdited =
    requestCreatedTime !== null &&
    requestUpdatedTime !== null &&
    requestUpdatedTime !== requestCreatedTime;
  if (
    requestComment == null ||
    requestTimelineIndex === null ||
    requestTimelineIndex <= headBoundaryIndex
  ) {
    return null;
  }
  const botResponse = latestTimestampedEvent(
    currentHeadReviewBotResponses({
      sha,
      issueComments,
      reviews,
      timelineEvents,
      config: resolved,
    }).filter(
      (response) =>
        response.timestamp > request.timestamp ||
        (!requestWasEdited &&
          response.timestamp === request.timestamp &&
          requestTimelineIndex !== null &&
          response.timelineIndex !== null &&
          response.timelineIndex > requestTimelineIndex),
    ),
  );
  if (botResponse === null || botResponse.timelineIndex === null) {
    return null;
  }

  const latestInProgressTime = reviewInProgressEvents({
    sha,
    issueComments,
    issueEyesReactions,
    reviewRequestReactions,
    timelineEvents,
    config: resolved,
  }).reduce(
    (latest, event) =>
      latest === null ? event.timestamp : Math.max(latest, event.timestamp),
    null,
  );
  if (
    latestInProgressTime !== null &&
    latestInProgressTime >= botResponse.timestamp
  ) {
    return null;
  }

  const boundaryTime = Math.max(
    headBoundaryTime,
    request.timestamp,
    botResponse.timestamp,
    reviewEvidenceChangeBoundary(currentStatus)?.timestamp ??
      Number.NEGATIVE_INFINITY,
  );
  let latest = null;
  for (const comment of issueComments) {
    if (!isSettledDispositionAuthor(comment, resolved)) {
      continue;
    }
    const dispositionSha = extractSettledDispositionSha(comment?.body, resolved);
    const createdTime = parseTimestamp(comment?.created_at);
    const updatedTime = parseTimestamp(comment?.updated_at);
    const timestamp = createdTime;
    const timelineEvent = issueCommentTimelineEvent(timelineEvents, comment);
    const timelineIndex =
      timelineEvent === null ? null : timelineEvents.indexOf(timelineEvent);
    if (
      dispositionSha !== sha.toLowerCase() ||
      timestamp === null ||
      (updatedTime !== null && updatedTime !== createdTime) ||
      timestamp < boundaryTime ||
      timelineEvent === null ||
      timelineEventTimestamp(timelineEvent) !== timestamp ||
      (timestamp === botResponse.timestamp &&
        (botResponse.timelineIndex === null ||
          timelineIndex === null ||
          timelineIndex <= botResponse.timelineIndex))
    ) {
      continue;
    }
    const numericId = Number(comment?.id);
    const id = Number.isFinite(numericId) ? numericId : null;
    if (
      latest === null ||
      timestamp > latest.timestamp ||
      (timestamp === latest.timestamp && id !== null && id > (latest.id ?? -1))
    ) {
      latest = {
        timestamp,
        id,
        login: loginFor(comment.user),
        url: String(comment?.html_url ?? ""),
        detail: `settled disposition by @${loginFor(comment.user)} at ${
          comment.created_at
        }`,
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

export function evaluateGate({
  pr,
  issueComments = [],
  issueReactions = [],
  issueEyesReactions = [],
  reviews = [],
  reviewThreads = [],
  reviewRequestReactions = [],
  timelineEvents = [],
  currentStatus = null,
  config,
}) {
  const resolved = resolveConfig(config);
  const prNumber = Number(pr.number);
  const sha = String(pr.head.sha);
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
      issueComments,
      issueEyesReactions,
      reviews,
      reviewRequestReactions,
      timelineEvents,
      currentStatus,
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
      (latest, event) =>
        latest === null ? event.timestamp : Math.max(latest, event.timestamp),
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
        prState,
        generation,
        state: "pending",
        description: REVIEW_IN_PROGRESS_DESCRIPTION,
        details: inProgressEvents.map((event) => event.detail),
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
    const evidenceChange = reviewEvidenceChangeBoundary(currentStatus);
    details.push(
      evidenceChange === null
        ? staleReview ?? staleReaction ?? NO_CLEAN_REVIEW_DESCRIPTION
        : REVIEW_EVIDENCE_CHANGED_DESCRIPTION,
    );
  }

  if (details.length > 0) {
    const evidenceChange = reviewEvidenceChangeBoundary(currentStatus);
    return {
      prNumber,
      sha,
      prState,
      generation,
      state: "failure",
      description:
        evidenceChange === null
          ? summarizeFailureDetails(details)
          : REVIEW_EVIDENCE_CHANGED_DESCRIPTION,
      details,
      ...(evidenceChange?.targetUrl
        ? { targetUrl: evidenceChange.targetUrl }
        : {}),
    };
  }

  return {
    prNumber,
    sha,
    prState,
    generation,
    state: "success",
    description:
      disposition === null
        ? "Review gate passed."
        : `Settled by @${disposition.login} for ${sha.slice(0, 12)}.`,
    details: cleanEvents,
    ...(disposition?.url ? { targetUrl: disposition.url } : {}),
  };
}
