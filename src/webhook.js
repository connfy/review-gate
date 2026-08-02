// Pure webhook helpers: signature verification, event routing, and cheap
// event-level decisions that avoid full PR re-evaluation when the payload cannot
// move the gate forward.

import {
  extractSettledDispositionSha,
  isSettledDispositionAuthor,
  resolveConfig,
} from "./gate.js";

const RELEVANT_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
]);

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

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Verifies the X-Hub-Signature-256 header against the raw request body.
export async function verifySignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const expected = `sha256=${toHex(signature)}`;
  return timingSafeEqual(expected, signatureHeader);
}

// Returns the PR coordinates a given event refers to, or null when the event
// is not a pull-request event the gate should react to.
export function pullRequestRefFromEvent(eventName, payload) {
  if (!RELEVANT_EVENTS.has(eventName)) {
    return null;
  }

  const repository = payload?.repository;
  const installationId = payload?.installation?.id;
  if (!repository || installationId == null) {
    return null;
  }

  let prNumber = null;
  if (eventName === "issue_comment") {
    if (!payload?.issue?.pull_request) {
      return null;
    }
    prNumber = payload?.issue?.number;
  } else {
    prNumber = payload?.pull_request?.number;
  }
  if (prNumber == null) {
    return null;
  }

  return {
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: Number(prNumber),
    installationId: Number(installationId),
  };
}

export function shouldIgnoreEvent(eventName, payload, config) {
  if (eventName !== "issue_comment") {
    return false;
  }
  if (!payload?.issue?.pull_request) {
    return true;
  }

  const { cleanText, botLogins, reviewRequestText } = resolveConfig(config);
  const author = loginFor(payload?.comment?.user);
  const action = String(payload?.action ?? "");
  const body = String(payload?.comment?.body ?? "");
  if (
    action === "created" &&
    isSettledDispositionAuthor(payload?.comment, config) &&
    extractSettledDispositionSha(body) !== null
  ) {
    return false;
  }
  if (!botLogins.has(author)) {
    return !includesText(body, reviewRequestText);
  }

  if (action === "created") {
    return !body.includes(cleanText);
  }

  // A clean-pass comment should not normally be edited or deleted, but if the
  // configured bot does change one, re-evaluate instead of trusting stale state.
  return action !== "edited" && action !== "deleted";
}
