import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

export function githubClient(token, fetcher = fetch) {
  return async (endpoint, { method = "GET", body } = {}) => {
    const response = await fetcher(`https://api.github.com${endpoint}`, {
      method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "connfy-api-reviewer" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${endpoint}: HTTP ${response.status}`);
    return response.json();
  };
}

export async function appClient(env = process.env, fetcher = fetch) {
  for (const key of ["API_REVIEW_APP_ID", "API_REVIEW_INSTALLATION_ID", "API_REVIEW_PRIVATE_KEY_PATH", "API_REVIEW_BOT_LOGIN", "API_REVIEW_BOT_ID"]) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  for (const key of ["API_REVIEW_APP_ID", "API_REVIEW_INSTALLATION_ID", "API_REVIEW_BOT_ID"]) {
    if (!/^[1-9][0-9]*$/.test(env[key])) throw new Error(`Invalid ${key}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: env.API_REVIEW_APP_ID })}`;
  const privateKey = createPrivateKey(await readFile(env.API_REVIEW_PRIVATE_KEY_PATH));
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const auth = githubClient(jwt, fetcher);
  const app = await auth("/app");
  const { token } = await auth(`/app/installations/${env.API_REVIEW_INSTALLATION_ID}/access_tokens`, {
    method: "POST", body: { permissions: { contents: "read", pull_requests: "write" } },
  });
  if (typeof token !== "string" || !token.trim()) throw new Error("Missing App installation token");
  const api = githubClient(token, fetcher);
  // App JWTs authenticate App endpoints; ordinary REST reads use the
  // installation token, including the public bot-user identity lookup.
  const user = await api(`/users/${encodeURIComponent(env.API_REVIEW_BOT_LOGIN)}`);
  if (`${app.slug}[bot]` !== env.API_REVIEW_BOT_LOGIN || user.login !== env.API_REVIEW_BOT_LOGIN ||
      String(user.id) !== env.API_REVIEW_BOT_ID || user.type !== "Bot") throw new Error("App/bot identity mismatch");
  return api;
}

export async function listReviews(api, repo, number) {
  const reviews = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Invalid review list");
    reviews.push(...batch);
    if (batch.length < 100) return reviews;
  }
}

export function isPublishedReview(review, snapshot, identity) {
  return review.user?.login === identity.login && String(review.user?.id) === String(identity.id) &&
    review.user?.type === "Bot" && review.commit_id === snapshot.head &&
    review.state === "COMMENTED" && Boolean(review.submitted_at) &&
    new RegExp(`^<!-- api-credit-review:v1 head=${snapshot.head} base=[0-9a-f]{40} -->\\n`).test(String(review.body));
}

export async function publishReview({ api, snapshot, payload, identity, beforePost = async () => {} }) {
  const { repo, number } = snapshot;
  if ((await listReviews(api, repo, number)).some((r) => isPublishedReview(r, snapshot, identity))) return { deduplicated: true };
  const live = await api(`/repos/${repo}/pulls/${number}`);
  if (live.state !== "open" || live.draft || live.head.sha !== snapshot.head || live.base.sha !== snapshot.base || live.base.repo.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error("PR changed or is not publishable");
  if (payload.commit_id !== snapshot.head || payload.event !== "COMMENT") throw new Error("Wrong publication commit/event");
  await beforePost(); // Persist POST intent; an ambiguous network failure must not cause an automatic retry.
  const review = await api(`/repos/${repo}/pulls/${number}/reviews`, { method: "POST", body: payload });
  if (!isPublishedReview(review, snapshot, identity)) throw new Error("Unexpected published review receipt; reconcile before retry");
  return { reviewId: review.id, url: review.html_url };
}
