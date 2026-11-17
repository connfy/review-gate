import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { apiReviewBoundaryTime } from "../../src/gate.js";
import { assertAllowedRepository, requestConfig } from "./config.mjs";

const GITHUB_REQUEST_TIMEOUT_MS = 60_000;
// Cover the bounded HTTP request lifetime so credentials do not expire while
// a publication read/write is in flight. Refresh on demand, not on a timer.
const TOKEN_REFRESH_MARGIN_MS = GITHUB_REQUEST_TIMEOUT_MS;

export function githubClient(token, fetcher = fetch) {
  return async (endpoint, { method = "GET", body } = {}) => {
    const response = await fetcher(`https://api.github.com${endpoint}`, {
      method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "connfy-api-reviewer" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${endpoint}: HTTP ${response.status}`);
    return response.json();
  };
}

export async function appClient(env = process.env, fetcher = fetch, { now = Date.now } = {}) {
  for (const key of ["API_REVIEW_APP_ID", "API_REVIEW_INSTALLATION_ID", "API_REVIEW_PRIVATE_KEY_PATH", "API_REVIEW_BOT_LOGIN", "API_REVIEW_BOT_ID"]) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  for (const key of ["API_REVIEW_APP_ID", "API_REVIEW_INSTALLATION_ID", "API_REVIEW_BOT_ID"]) {
    if (!/^[1-9][0-9]*$/.test(env[key])) throw new Error(`Invalid ${key}`);
  }
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const privateKey = createPrivateKey(await readFile(env.API_REVIEW_PRIVATE_KEY_PATH));
  const appAuth = () => {
    const seconds = Math.floor(now() / 1000);
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: seconds - 60, exp: seconds + 540, iss: env.API_REVIEW_APP_ID })}`;
    const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
    return githubClient(jwt, fetcher);
  };
  const app = await appAuth()("/app");
  let installationApi, expiresAt = 0, refreshing;
  const refresh = async () => {
    // A long inference also outlives the original App JWT; sign a fresh one.
    const receipt = await appAuth()(`/app/installations/${env.API_REVIEW_INSTALLATION_ID}/access_tokens`, {
      method: "POST", body: { permissions: { contents: "read", pull_requests: "write" } },
    });
    if (typeof receipt.token !== "string" || !receipt.token.trim()) throw new Error("Missing App installation token");
    const expiry = Date.parse(receipt.expires_at);
    if (!Number.isFinite(expiry) || expiry <= now() + TOKEN_REFRESH_MARGIN_MS) throw new Error("Invalid App installation token expiry/lifetime");
    installationApi = githubClient(receipt.token, fetcher);
    expiresAt = expiry;
  };
  const api = async (endpoint, options) => {
    if (!installationApi || now() + TOKEN_REFRESH_MARGIN_MS >= expiresAt) {
      refreshing ??= refresh().finally(() => { refreshing = undefined; });
      await refreshing;
    }
    // Never retry this request: an ambiguous Review POST is still ambiguous.
    return installationApi(endpoint, options);
  };
  // App JWTs authenticate App endpoints; ordinary REST reads use the
  // installation token, including the public bot-user identity lookup.
  const user = await api(`/users/${encodeURIComponent(env.API_REVIEW_BOT_LOGIN)}`);
  if (`${app.slug}[bot]` !== env.API_REVIEW_BOT_LOGIN || user.login !== env.API_REVIEW_BOT_LOGIN ||
      String(user.id) !== env.API_REVIEW_BOT_ID || user.type !== "Bot") throw new Error("App/bot identity mismatch");
  return api;
}

export async function listReviews(api, repo, number) {
  assertAllowedRepository(repo);
  return listPages(api, `/repos/${repo}/pulls/${number}/reviews`);
}

async function listPages(api, endpoint) {
  const values = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${endpoint}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Invalid paginated GitHub evidence");
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}

export async function reviewCycle(api, snapshot, pr) {
  assertAllowedRepository(snapshot.repo);
  const prefix = `/repos/${snapshot.repo}`;
  const live = pr ?? await api(`${prefix}/pulls/${snapshot.number}`);
  const [issueComments, timelineEvents] = await Promise.all([
    listPages(api, `${prefix}/issues/${snapshot.number}/comments`),
    listPages(api, `${prefix}/issues/${snapshot.number}/timeline`),
  ]);
  const boundary = apiReviewBoundaryTime({ prCreatedAt: live.created_at, issueComments, timelineEvents, config: requestConfig() });
  if (boundary === null) throw new Error("Cannot establish current review boundary");
  return { pr: live, boundary };
}

export function isPublishedReview(review, snapshot, identity) {
  return review.user?.login === identity.login && String(review.user?.id) === String(identity.id) &&
    review.user?.type === "Bot" && review.commit_id === snapshot.head &&
    review.state === "COMMENTED" && Number.isSafeInteger(snapshot.reviewBoundary) &&
    Date.parse(review.submitted_at) > snapshot.reviewBoundary &&
    new RegExp(`^<!-- api-credit-review:v1 head=${snapshot.head} base=[0-9a-f]{40} -->\\n`).test(String(review.body));
}

export async function publishReview({ api, snapshot, payload, identity, beforePost = async () => {} }) {
  const { repo, number } = snapshot;
  assertAllowedRepository(repo);
  const { pr: live, boundary } = await reviewCycle(api, snapshot);
  if (live.state !== "open" || live.draft || live.head.sha !== snapshot.head || live.base.sha !== snapshot.base || live.base.repo.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error("PR changed or is not publishable");
  if (boundary !== snapshot.reviewBoundary) throw new Error("Review request/head boundary changed; review the new cycle");
  if ((await listReviews(api, repo, number)).some((r) => isPublishedReview(r, snapshot, identity))) return { deduplicated: true };
  if (payload.commit_id !== snapshot.head || payload.event !== "COMMENT") throw new Error("Wrong publication commit/event");
  await beforePost(); // Persist POST intent; an ambiguous network failure must not cause an automatic retry.
  const review = await api(`/repos/${repo}/pulls/${number}/reviews`, { method: "POST", body: payload });
  if (!isPublishedReview(review, snapshot, identity)) throw new Error("Unexpected published review receipt; reconcile before retry");
  return { reviewId: review.id, url: review.html_url };
}
