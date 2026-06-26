// Pure gate-evaluation logic, shared by the Worker runtime and unit tests.
//
// The gate passes when the configured review bot left a clean review after the
// latest head commit and there are no unresolved current review threads. The
// review bot login(s), the clean-review marker text, and the status context are
// all configurable so the tool can be reused with any AI/code reviewer, not
// just Codex.
//
// The "@codex review" thumbs-up reaction shortcut is intentionally not
// supported: GitHub does not deliver reaction webhooks, so a pure webhook gate
// cannot observe it. Rely on the reviewer's clean review comment instead.

export const DEFAULT_CLEAN_TEXT = "Codex Review: Didn't find any major issues.";
export const DEFAULT_BOT_LOGINS = Object.freeze([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
export const DEFAULT_STATUS_CONTEXT = "review-gate/codex-clean";

const HEAD_REF_EVENTS = new Set(["head_ref_force_pushed", "head_ref_restored"]);

export function resolveConfig(config = {}) {
  return {
    cleanText: config.cleanText ?? DEFAULT_CLEAN_TEXT,
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

function headCommitTimestamp(timelineEvents, sha) {
  for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
    const event = timelineEvents[index];
    if (event?.event === "committed" && String(event?.sha ?? "") === sha) {
      return event?.author?.date ?? event?.created_at ?? null;
    }
  }
  return null;
}

function isCommentAfterHeadByTimestamp(comment, sha, timelineEvents) {
  const headTime = headCommitTimestamp(timelineEvents, sha);
  const commentTime = comment?.created_at;
  if (!headTime || !commentTime) {
    return false;
  }
  if (Date.parse(commentTime) <= Date.parse(headTime)) {
    return false;
  }

  const commentIndex = timelineEvents.findIndex(
    (event) =>
      event?.event === "commented" && Number(event?.id) === Number(comment?.id),
  );
  if (commentIndex < 0) {
    return true;
  }

  const boundaryIndex = latestHeadBoundaryIndex(timelineEvents, sha);
  return boundaryIndex !== null && commentIndex > boundaryIndex;
}

function issueCommentQualifies(comment, sha, timelineEvents, config) {
  const { cleanText, botLogins } = resolveConfig(config);
  const author = loginFor(comment?.user);
  const body = String(comment?.body ?? "");
  if (!botLogins.has(author) || !body.includes(cleanText)) {
    return false;
  }

  const idsAfterHead = issueCommentIdsAfterHead(timelineEvents, sha);
  if (idsAfterHead.has(Number(comment?.id))) {
    return true;
  }

  const reviewedPrefix = extractReviewedCommitPrefix(body);
  if (reviewedPrefix) {
    return shaMatchesPrefix(sha, reviewedPrefix);
  }

  return isCommentAfterHeadByTimestamp(comment, sha, timelineEvents);
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

    const headTime = headCommitTimestamp(timelineEvents, sha);
    if (
      headTime &&
      comment?.created_at &&
      Date.parse(comment.created_at) < Date.parse(headTime)
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
  issueComments,
  reviews,
  timelineEvents,
  config,
}) {
  const { cleanText, botLogins } = resolveConfig(config);
  const cleanEvents = cleanCommentsFromTimeline(timelineEvents, sha, config);

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
    details.push(
      staleReview ??
        "No clean review pass after the latest head update. Need a clean review comment.",
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
