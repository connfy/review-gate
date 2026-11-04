// Pure gate-evaluation logic, shared by the Worker runtime and unit tests.
//
// Clean authority requires a configured Bot's completed full-head review and
// no current blockers. Other reviewers can use full-SHA formal reviews or clean
// receipts; short receipts/reactions require Codex's versioned binding protocol.

import { verifyBaseSyncEvidence } from "./base-sync.js";
import { parseCodeReviewStates } from "./review-state.js";

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
// Codex keeps one live summary per PR. Its existence/text never marks a result;
// versioned full-head metadata may bind a separate clean signal (ADR 0005).
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
  "No clean review pass after the latest head update. Need a completed clean review bound to this head.";

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
    baseSyncEnabled: config.baseSyncEnabled === true,
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

// The bot's live status board is neither a review response nor a clean pass,
// whatever text it currently shows.
function isStatusBoard(body, config) {
  const { statusBoardMarker } = resolveConfig(config);
  return (
    Boolean(statusBoardMarker) &&
    String(body ?? "").includes(statusBoardMarker)
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

// Diagnostic hint only. This approximation must never authorize a clean pass.
function issueCommentLooksCurrentForDiagnostics(comment, sha, timelineEvents, config) {
  const { cleanText, botLogins } = resolveConfig(config);
  const author = loginFor(comment?.user);
  const body = String(comment?.body ?? "");
  if (
    !botLogins.has(author) ||
    !body.includes(cleanText) ||
    isStatusBoard(body, config)
  ) {
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

function issueBodyInProgressReactionQualifies(reaction, boundary, config) {
  const { inProgressReactionContent } = resolveConfig(config);
  return botReactionQualifies(
    reaction,
    inProgressReactionContent,
    boundary,
    config,
  );
}

// Success authority uses GitHub's exact commit binding and server times. Git
// author/committer dates and timeline position cannot attest when a head arrived.
function serverReviewBoundary({ issueComments, timelineEvents, config }) {
  const values = [];
  for (const event of timelineEvents) {
    if (!HEAD_REF_EVENTS.has(event?.event) && event?.event !== "ready_for_review") continue;
    const value = parseTimestamp(event.created_at);
    if (value === null) return { invalid: true, timestamp: null };
    values.push(value);
  }
  for (const comment of [
    ...issueComments,
    ...timelineEvents.filter((event) => event?.event === "commented"),
  ]) {
    if (!isReviewRequestComment(comment, config)) continue;
    const value = parseTimestamp(comment.created_at);
    if (value === null) return { invalid: true, timestamp: null };
    values.push(value);
  }
  return { invalid: false, timestamp: values.length ? Math.max(...values) : null };
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

  const resolved = resolveConfig(config);
  const states = statesFromComments(reviewCommentSnapshot(issueComments, timelineEvents, resolved), resolved);
  for (const state of states.values()) {
    if (state.reviewedSha === sha && state.status === "running") {
      events.push({ detail: "The review bot's full-head Code Review state is running.",
        timestamp: state.timestamp });
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
  const { botLogins, cleanText } = resolveConfig(config);
  const boundComments = new Map(cleanReviewSources({
    issueComments, reviews, timelineEvents, config,
  }).filter((source) => source.kind === "comment" && source.reviewedSha === sha)
    .map((source) => [source.id, source.timestamp]));
  const resolved = resolveConfig(config);
  const knownRunning = [...statesFromComments(reviewCommentSnapshot(issueComments, timelineEvents, resolved), resolved).values()]
    .some((state) => state.reviewedSha === sha && state.status === "running");
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
    if (!responseAppliesToHeads(comment, "comment", new Set([sha]))) continue;
    const body = String(comment?.body ?? "");
    if (isStatusBoard(body, config)) {
      continue;
    }
    // A receipt can arrive before its full-head binding. Keep a requested or
    // eyes-started round in the existing priority queue until that read catches
    // up; a board alone still never finishes the wait (ADR 0002).
    if (body.includes(cleanText) && !boundComments.has(comment.id)) {
      continue;
    }
    if (body.includes(cleanText)) {
      updateLatest(boundComments.get(comment.id) ?? null);
      continue;
    }
    if (knownRunning && extractReviewedCommitPrefix(body)?.toLowerCase() !== sha) continue;
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

  const states = statesFromComments(reviewCommentSnapshot(issueComments, timelineEvents, resolved), resolved);
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
    // An attestation covers findings already known in its round, never a
    // newer completed non-clean review of the same immutable head.
    if ([...states.values()].some((state) => state.reviewedSha === sha &&
      !state.clean && state.timestamp >= timestamp)) continue;
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

function findStaleCleanReaction({ issueComments, issueReactions, timelineEvents, config }) {
  const { cleanReactionContent, botLogins } = resolveConfig(config);
  const latest = issueReactions.filter((reaction) =>
    botLogins.has(loginFor(reaction?.user)) && reaction.content === cleanReactionContent)
    .map((reaction) => parseTimestamp(reaction.created_at))
    .filter((timestamp) => timestamp !== null).sort((a, b) => b - a)[0];
  if (latest === undefined) return null;
  const requestTime = latestReviewRequestTime(issueComments, timelineEvents, config);
  if (requestTime !== null && latest <= requestTime) {
    return `Review bot PR body ${cleanReactionContent} reaction is stale; it predates the latest review request.`;
  }
  return `PR body ${cleanReactionContent} reaction is stale or has no completed clean review bound to this head.`;
}

function findStaleCleanReview({ sha, issueComments, timelineEvents, config }) {
  const { cleanText, botLogins } = resolveConfig(config);
  for (const comment of issueComments) {
    const author = loginFor(comment?.user);
    const body = String(comment?.body ?? "");
    if (!botLogins.has(author) || !body.includes(cleanText)) {
      continue;
    }
    if (issueCommentLooksCurrentForDiagnostics(comment, sha, timelineEvents, config)) {
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

// Combine both API representations before assigning review authority. A live
// provider summary may bind a separate signal, but cannot create one by itself.
function reviewCommentSnapshot(issueComments, timelineEvents, resolved) {
  const comments = new Map();
  const conflicting = new Set();
  for (const value of [
    ...issueComments,
    ...timelineEvents.filter((event) => event?.event === "commented")
      .map((event) => ({ ...event, user: event.user ?? event.actor })),
  ]) {
    // Unknown endpoint typing must not hide findings or conflicting copies.
    // Positive sources still require a Bot comment; reactions join that actor
    // by immutable numeric ID because their API may label the same Bot "User".
    if (!resolved.botLogins.has(loginFor(value?.user))) continue;
    const previous = comments.get(value.id);
    if (previous && (previous.body !== value.body ||
      previous.user?.id !== value.user?.id || previous.created_at !== value.created_at)) {
      conflicting.add(value.id);
    }
    if (!previous) comments.set(value.id, value);
  }
  return { comments, conflicting };
}

function stateEvidenceFromComments({ comments, conflicting }, resolved) {
  // A conflicting summary cannot vanish and leave another summary apparently
  // unique for its actor. Preserve an invalid board in that snapshot instead.
  const boards = [...comments.values()].map((value) => conflicting.has(value.id)
    ? { ...value, body: `${resolved.statusBoardMarker}\nconflicting snapshot` } : value);
  const evidence = parseCodeReviewStates(boards, resolved.statusBoardMarker);
  evidence.failures = evidence.failures.map((failure) => conflicting.has(failure.commentId)
    ? { ...failure, code: "conflicting-summary-snapshot" } : failure);
  return evidence;
}

function statesFromComments(snapshot, resolved) {
  return stateEvidenceFromComments(snapshot, resolved).states;
}

// Missing head identity is a verification problem, never completion evidence.
// Only a plausible result of the current round can exhaust its verification
// window; old receipts before a new request/start do not end a running review.
function unverifiedCleanReceipts({ sha, issueComments, issueReactions, timelineEvents, config, startedAt }) {
  const resolved = resolveConfig(config);
  const snapshot = reviewCommentSnapshot(issueComments, timelineEvents, resolved);
  const { states, failures } = stateEvidenceFromComments(snapshot, resolved);
  const boundary = serverReviewBoundary({ issueComments, timelineEvents, config: resolved });
  if (boundary.invalid) return { receipts: [], failures };
  const candidates = [];
  for (const comment of snapshot.comments.values()) {
    const body = String(comment.body ?? "");
    const prefix = extractReviewedCommitPrefix(body)?.toLowerCase();
    if (body.includes(resolved.cleanText) && !isStatusBoard(body, resolved) &&
      !/^[0-9a-f]{40}$/.test(prefix ?? "") && (!prefix || sha.startsWith(prefix))) {
      candidates.push({ value: comment, kind: "comment" });
    }
  }
  for (const reaction of issueReactions) {
    if (resolved.botLogins.has(loginFor(reaction?.user)) &&
      reaction.content === resolved.cleanReactionContent) candidates.push({ value: reaction, kind: "reaction" });
  }
  const receipts = [];
  const knownRunning = [...states.values()].some((state) =>
    state.reviewedSha === sha && state.status === "running");
  for (const { value, kind } of candidates) {
    const timestamp = parseTimestamp(value.created_at);
    if (timestamp === null || (boundary.timestamp !== null && timestamp <= boundary.timestamp) ||
      (startedAt !== null && timestamp < startedAt)) continue;
    const state = states.get(value.user.id);
    // A known running review has not returned its result yet. Do not expire it
    // merely because an older/other round emitted an unbound signal.
    if (knownRunning) continue;
    if (state?.reviewedSha === sha && state.clean &&
      (boundary.timestamp === null || state.timestamp > boundary.timestamp) &&
      (startedAt === null || state.timestamp >= startedAt)) continue;
    receipts.push({ timestamp, kind, commentId: value.id ?? null, code:
      failures.find((failure) => failure.actorId === value.user.id)?.code ??
      (state ? "stale-or-non-clean-completion" : "missing-full-head-binding") });
  }
  return { receipts, failures };
}

function responseAppliesToHeads(value, kind, heads) {
  let prefix = null;
  if (kind === "review") {
    if (/^[0-9a-f]{40}$/.test(String(value?.commit_id ?? ""))) prefix = value.commit_id;
  } else {
    const body = String(value?.body ?? "");
    const labels = body.match(/\*\*Reviewed commit:\*\*/gi) ?? [];
    const candidate = extractReviewedCommitPrefix(body)?.toLowerCase();
    if (labels.length === 1 && /^[0-9a-f]{1,40}$/.test(candidate ?? "")) prefix = candidate;
  }
  // Explicitly different heads cannot supersede a review of this covered
  // change set. Unknown or prefix-colliding identities remain conservative.
  return prefix === null || [...heads].some((head) => head.startsWith(prefix));
}

// Every returned source has a full immutable head binding. No Git ref lookup,
// timeline ordering, commit date, settlement, or carried status creates a source.
export function cleanReviewSources({
  issueComments = [], issueReactions = [], issueEyesReactions = [],
  reviewRequestReactions = [], reviews = [], timelineEvents = [], config,
}) {
  const resolved = resolveConfig(config);
  if (!String(resolved.cleanText).length) return [];
  const boundary = serverReviewBoundary({ issueComments, timelineEvents, config: resolved });
  if (boundary.invalid) return [];
  const { comments, conflicting } = reviewCommentSnapshot(issueComments, timelineEvents, resolved);
  const usable = [...comments.values()].filter((value) =>
    value.user?.type === "Bot" && !conflicting.has(value.id));
  const states = statesFromComments({ comments, conflicting }, resolved);
  const bindings = new Map([...states].filter(([, state]) => state.clean));
  const sources = [];
  for (const review of reviews) {
    const timestamp = parseTimestamp(review?.submitted_at);
    if (resolved.botLogins.has(loginFor(review?.user)) && review?.user?.type === "Bot" &&
      ["commented", "approved"].includes(String(review?.state).toLowerCase()) &&
      !isStatusBoard(review.body, resolved) &&
      String(review.body ?? "").includes(resolved.cleanText) &&
      /^[0-9a-f]{40}$/.test(String(review.commit_id ?? "")) && timestamp !== null) {
      sources.push({ reviewedSha: review.commit_id, timestamp,
        url: review.html_url, kind: "review", id: review.id, value: review,
        detail: `clean review body at ${review.submitted_at}` });
    }
  }
  for (const comment of usable) {
    const body = String(comment.body ?? "");
    const signalTime = parseTimestamp(comment.created_at);
    if (!body.includes(resolved.cleanText) || isStatusBoard(body, resolved) ||
      signalTime === null || !Number.isSafeInteger(comment.id) || comment.id <= 0) continue;
    const prefix = extractReviewedCommitPrefix(body)?.toLowerCase();
    const labels = body.match(/\*\*Reviewed commit:\*\*/gi) ?? [];
    if (labels.length > 1 || (labels.length === 1 && !prefix)) continue;
    const binding = bindings.get(comment.user.id);
    let reviewedSha;
    let timestamp = signalTime;
    if (/^[0-9a-f]{40}$/.test(prefix ?? "")) {
      reviewedSha = prefix;
    } else if (binding && (!prefix || binding.reviewedSha.startsWith(prefix))) {
      reviewedSha = binding.reviewedSha;
      // The provider may post its receipt BEFORE recording completion in the
      // summary. Both records must predate no later request; never refresh an
      // old signal using the board's unrelated updated_at timestamp.
      timestamp = Math.min(signalTime, binding.timestamp);
    } else continue;
    sources.push({ reviewedSha, timestamp, signalTime,
      url: comment.html_url, kind: "comment", id: comment.id, value: comment,
      detail: `clean review comment at ${comment.created_at}` });
  }
  for (const reaction of issueReactions) {
    const binding = bindings.get(reaction?.user?.id);
    const signalTime = parseTimestamp(reaction?.created_at);
    if (!binding ||
      !resolved.botLogins.has(loginFor(reaction.user)) ||
      reaction.content !== resolved.cleanReactionContent || signalTime === null) continue;
    sources.push({ reviewedSha: binding.reviewedSha,
      timestamp: Math.min(signalTime, binding.timestamp), signalTime,
      url: binding.board.html_url, kind: "reaction", id: reaction.id, value: reaction,
      detail: `clean PR body reaction at ${reaction.created_at} bound by completed Code Review state` });
  }
  const eyeTimes = [...issueEyesReactions,
    ...reviewRequestReactions.flatMap((group) => group.reactions ?? [])]
    .filter((reaction) => resolved.botLogins.has(loginFor(reaction?.user)) &&
      reaction.content === resolved.inProgressReactionContent)
    .map((reaction) => parseTimestamp(reaction.created_at));
  return sources.filter((source) => {
    // Requests and head-ref boundaries invalidate every older head source too;
    // reject before optional graph collection, not after fetching a long chain.
    if (boundary.timestamp !== null && source.timestamp <= boundary.timestamp) return false;
    if (eyeTimes.some((time) => time === null || time >= source.timestamp)) return false;
    const state = states.get(source.value?.user?.id);
    // A known newer Code Review state can retract older authority without
    // treating the board as a response or a clean signal. Other roles cannot.
    return !state || state.clean || state.reviewedSha !== source.reviewedSha ||
      state.timestamp < source.timestamp;
  });
}

export function codexCleanEvents(inputs) {
  const { sha, issueComments = [], reviews = [], timelineEvents = [], prCreatedAt, config } = inputs;
  const resolved = resolveConfig(config);
  if (reviews.some((review) => resolved.botLogins.has(loginFor(review?.user)) &&
    review.commit_id === sha &&
    (parseTimestamp(review.submitted_at) === null ||
      !["commented", "approved", "changes_requested", "dismissed"].includes(String(review.state).toLowerCase())))) {
    return [];
  }
  const boundary = serverReviewBoundary({ issueComments, timelineEvents, prCreatedAt, config: resolved });
  if (boundary.invalid) return [];
  const { comments, conflicting } = reviewCommentSnapshot(issueComments, timelineEvents, resolved);
  const sources = cleanReviewSources(inputs).filter((source) => source.reviewedSha === sha);
  const heads = new Set([sha]);
  const responses = [
    ...reviews.filter((review) => resolved.botLogins.has(loginFor(review?.user)) &&
      responseAppliesToHeads(review, "review", heads))
      .map((review) => ({ timestamp: parseTimestamp(review.submitted_at), kind: "review", id: review.id, value: review })),
    ...[...comments.values()].filter((value) => {
      if (isStatusBoard(value.body, resolved)) return false;
      return responseAppliesToHeads(value, "comment", heads);
    }).map((value) => ({
      timestamp: conflicting.has(value.id) ? null : parseTimestamp(value.updated_at ?? value.created_at),
      kind: "comment", id: value.id, value,
    })),
  ];
  return sources.filter((source) => {
    const createdAt = parseTimestamp(prCreatedAt);
    if (createdAt !== null && source.timestamp < createdAt) return false;
    if (boundary.timestamp !== null && source.timestamp <= boundary.timestamp) return false;
    return !responses.some((response) => {
      const otherClean = sources.some((other) => other.value === response.value ||
        (Number.isSafeInteger(other.id) && other.kind === response.kind && other.id === response.id));
      return !otherClean && (response.timestamp === null || response.timestamp >= source.timestamp);
    });
  }).map((source) => source.detail);
}

export function baseSyncReviewAuthority(inputs, evidence) {
  const resolved = resolveConfig(inputs.config);
  const sources = cleanReviewSources(inputs);
  const source = sources.filter((value) => value.reviewedSha === evidence.reviewedSha &&
    Number.isSafeInteger(value.id) && value.id > 0 && typeof value.url === "string" && value.url.length > 0)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!source) return null;
  const states = statesFromComments(reviewCommentSnapshot(
    inputs.issueComments, inputs.timelineEvents, resolved,
  ), resolved);
  const timeline = inputs.timelineEvents;
  const chain = new Set([evidence.reviewedSha]);
  let cursor = evidence.headSha;
  while (cursor !== evidence.reviewedSha) {
    if (chain.has(cursor)) return null;
    chain.add(cursor);
    cursor = evidence.commits[cursor]?.parents?.[0]?.sha;
    if (!cursor) return null;
  }
  for (const state of states.values()) {
    // Include intermediate sync heads, while preserving the ordinary rule
    // that a late result explicitly targeting an older head is outdated.
    if (chain.has(state.reviewedSha) && !state.clean && state.timestamp >= source.timestamp) return null;
  }
  const positions = new Map();
  timeline.forEach((event, index) => {
    if (event?.event === "committed" && chain.has(event?.sha)) {
      positions.set(event.sha, index);
    }
  });
  if ([...chain].some((sha) => !positions.has(sha))) return null;
  const botComments = new Map(inputs.issueComments.filter((comment) =>
    resolved.botLogins.has(loginFor(comment?.user)) && !isStatusBoard(comment.body, resolved) &&
    responseAppliesToHeads(comment, "comment", chain),
  ).map((comment) => [comment.id, comment]));
  const timelineBotComments = new Map(timeline.filter((event) =>
    event?.event === "commented" &&
    resolved.botLogins.has(loginFor(event.user ?? event.actor)) &&
    !isStatusBoard(event.body, resolved) && responseAppliesToHeads(event, "comment", chain),
  ).map((event) => [event.id, event]));
  // Either API can briefly lag the other. A newer response visible in only one
  // read, or incompatible versions of a comment, cannot authorize a carry.
  for (const id of new Set([...botComments.keys(), ...timelineBotComments.keys()])) {
    const comment = botComments.get(id);
    const event = timelineBotComments.get(id);
    const time = parseTimestamp(comment?.updated_at ?? comment?.created_at ?? event?.created_at);
    if (time === null || (time >= source.timestamp &&
      (!comment || !event || comment.body !== event.body))) return null;
  }
  const headAt = (index) => [...positions.entries()]
    .filter(([, position]) => position < index)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const requests = new Map();
  for (const [index, event] of timeline.entries()) {
    if (HEAD_REF_EVENTS.has(event?.event)) {
      const time = parseTimestamp(event.created_at);
      if (time === null || time >= source.timestamp) return null;
    }
    if (event?.event === "commented" && isReviewRequestComment(event, resolved)) {
      requests.set(Number(event.id), { comment: event, index });
    }
    if (event?.event === "ready_for_review") {
      const time = parseTimestamp(event.created_at);
      if (time === null || time >= source.timestamp ||
        (headAt(index) && headAt(index) !== evidence.reviewedSha)) return null;
    }
  }
  for (const comment of inputs.issueComments) {
    if (!isReviewRequestComment(comment, resolved)) continue;
    if (!requests.has(Number(comment.id))) return null;
    requests.set(Number(comment.id), { comment, index: requests.get(Number(comment.id)).index });
  }
  for (const { comment, index } of requests.values()) {
    const time = parseTimestamp(comment.created_at);
    if (time === null || time >= source.timestamp ||
      (headAt(index) && headAt(index) !== evidence.reviewedSha)) return null;
  }

  // A base update cannot erase a newer request, findings, or an unfinished
  // round, even when that evidence precedes the latest sync merge's boundary.
  const responses = [
    ...inputs.reviews.map((value) => ({ value, kind: "review", time: value.submitted_at })),
    ...inputs.issueComments.map((value) => ({
      value, kind: "comment", time: value.updated_at ?? value.created_at,
    })),
  ];
  for (const { value, kind, time } of responses) {
    if (!resolved.botLogins.has(loginFor(value?.user)) ||
      isStatusBoard(value?.body, resolved)) continue;
    if (!responseAppliesToHeads(value, kind, chain)) continue;
    if (!Number.isSafeInteger(value?.id) || value.id <= 0) return null;
    const timestamp = parseTimestamp(time);
    if (timestamp === null) return null;
    const sameClean = sources.some((candidate) =>
      candidate.kind === kind && candidate.id === value.id &&
      candidate.reviewedSha === source.reviewedSha,
    );
    if (sameClean) continue;
    if (timestamp >= source.timestamp ||
      (kind === "review" && chain.has(value.commit_id) &&
        value.commit_id !== source.reviewedSha)) return null;
  }
  const eyes = [
    ...inputs.issueEyesReactions,
    ...inputs.reviewRequestReactions.flatMap((group) => group.reactions ?? []),
  ];
  for (const reaction of eyes) {
    if (!resolved.botLogins.has(loginFor(reaction?.user)) ||
      reaction?.content !== resolved.inProgressReactionContent) continue;
    const time = parseTimestamp(reaction.created_at);
    if (time === null || time >= source.timestamp) return null;
  }
  return source;
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
  baseSyncEvidence = null,
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
    issueEyesReactions,
    reviewRequestReactions,
    reviews,
    timelineEvents,
    prCreatedAt: pr.created_at,
    config: resolved,
  });
  if (details.length === 0 && reviews.some((review) =>
    resolved.botLogins.has(loginFor(review?.user)) &&
    String(review.commit_id ?? "") === sha && String(review.state).toLowerCase() === "pending")) {
    return { prNumber, sha, baseSha, prState, generation, state: "pending",
      description: REVIEW_IN_PROGRESS_DESCRIPTION,
      details: ["The review bot has a pending formal review for the current head."] };
  }
  let disposition = null;
  let baseSync = null;
  let baseSyncSource = null;
  let baseSyncFailure = null;
  let reviewIdentityFailures = [];
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
    const verification = unverifiedCleanReceipts({ sha, issueComments, issueReactions, timelineEvents,
      config: resolved, startedAt: latestInProgressTime });
    const expiredReceipt = verification.receipts.some((receipt) =>
      now - receipt.timestamp > resolved.reviewStartWindowMs);
    const identityFailures = [
      ...verification.failures,
      ...verification.receipts.map(({ code, commentId }) => ({ code, commentId })),
    ];
    reviewIdentityFailures = identityFailures;
    // Expiry changes pending verification to visible failure only. It never
    // becomes completion evidence. A separately verified historical base-sync
    // source may still establish coverage of this head below.
    if (
      details.length === 0 &&
      inProgressEvents.length > 0 &&
      !botFinishedReview && !expiredReceipt
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
        ...(identityFailures.length ? { reviewIdentityFailures: identityFailures } : {}),
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
    if (awaitedRequest !== null && !expiredReceipt) {
      return {
        prNumber,
        sha,
        baseSha,
        prState,
        generation,
        state: "pending",
        description: REVIEW_REQUESTED_DESCRIPTION,
        details: [awaitedRequest.detail],
        ...(identityFailures.length ? { reviewIdentityFailures: identityFailures } : {}),
      };
    }

    if (resolved.baseSyncEnabled && baseSyncEvidence && details.length === 0) {
      try {
        if (baseSyncEvidence.headSha !== sha ||
          baseSyncEvidence.baseRef !== pr.base?.ref ||
          baseSyncEvidence.baseRepository !== pr.base?.repo?.full_name) {
          throw new Error("base sync: PR identity does not match evidence");
        }
        const source = baseSyncReviewAuthority({
          pr, issueComments, issueReactions, issueEyesReactions, reviews, reviewRequestReactions,
          timelineEvents, config: resolved,
        }, baseSyncEvidence);
        if (source !== null) {
          baseSync = verifyBaseSyncEvidence(baseSyncEvidence);
          baseSyncSource = source;
          cleanEvents.push(
            `base sync of reviewed head ${baseSync.reviewedSha} onto ` +
            `${baseSync.integratedBaseSha}; head ${sha}; live base ` +
            `${baseSync.liveBaseSha}; review ${source.url}`,
          );
        } else {
          baseSyncFailure = "base sync: no uninvalidated commit-bound clean review";
        }
      } catch (error) {
        baseSyncFailure = String(error?.message ?? error);
      }
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
      reviews,
      timelineEvents,
      prCreatedAt: pr.created_at,
      config: resolved,
    });
    if (cleanEvents.length === 0) {
      const identityIssue = verification.receipts.length > 0;
      const stalledVerification = expiredReceipt && inProgressEvents.length > 0 && !botFinishedReview;
      const identityDetail = "Clean review signal has no verified full-head binding; check reviewer state or receipt format.";
      details.push(staleReview ?? (stalledVerification
        ? "Clean review identity verification exceeded the review-start window; reviewer evidence needs attention."
        : verification.failures.length > 0 && identityIssue
        ? identityDetail : staleReaction ?? (identityIssue ? identityDetail : NO_CLEAN_REVIEW_DESCRIPTION)));

    }

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
      ...(baseSyncFailure ? { baseSyncFailure } : {}),
      ...(reviewIdentityFailures.length ? { reviewIdentityFailures } : {}),
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
      baseSync !== null
        ? `Review gate passed: base sync of reviewed head ${baseSync.reviewedSha} onto ${baseSync.integratedBaseSha}.`
        : disposition === null
        ? "Review gate passed."
        : `Settled by @${disposition.login} for head ${sha.slice(0, 12)} on base ${baseSha.slice(0, 12)}.`,
    details: cleanEvents,
    ...(disposition?.url ? { targetUrl: disposition.url } : {}),
    ...(baseSync ? {
      baseSync: {
        ...baseSync,
        baseRef: baseSyncEvidence.baseRef,
        baseRepository: baseSyncEvidence.baseRepository,
      },
      targetUrl: baseSyncSource.url,
    } : {}),
  };
}
