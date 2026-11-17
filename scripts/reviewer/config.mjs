export const DEFAULT_ALLOWED_REPOS = Object.freeze([
  "connfy/aimstrings-docs",
  "connfy/aimstrings-web",
]);

export function allowedRepositories(env = process.env) {
  const names = env.API_REVIEW_ALLOWED_REPOS === undefined
    ? DEFAULT_ALLOWED_REPOS : env.API_REVIEW_ALLOWED_REPOS.split(",").map((s) => s.trim().toLowerCase());
  if (!names.length || names.some((s) => !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/.test(s) || [".", ".."].includes(s.split("/")[1]))) {
    throw new Error("API_REVIEW_ALLOWED_REPOS must be an explicit comma-separated repository allowlist, without wildcards");
  }
  return new Set(names);
}

export function assertAllowedRepository(repo, env = process.env) {
  if (!allowedRepositories(env).has(repo)) throw new Error(`Repository is not allowed: ${repo}`);
}

export function requestConfig(env = process.env) {
  return {
    apiReviewBotLogin: env.API_REVIEW_BOT_LOGIN,
    apiReviewBotId: env.API_REVIEW_BOT_ID,
    reviewRequestText: env.REVIEW_REQUEST_TEXT,
    botLogins: env.REVIEW_BOT_LOGINS?.split(",").map((s) => s.trim()).filter(Boolean),
  };
}
