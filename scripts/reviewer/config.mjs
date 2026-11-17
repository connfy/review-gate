// Owner, 2026-11-17: the reviewer may run on every repository of the connfy
// account (the App is installed on all of them). API_REVIEW_ALLOWED_OWNERS
// widens or narrows the accounts; API_REVIEW_ALLOWED_REPOS adds exact repos.
export const DEFAULT_ALLOWED_OWNERS = Object.freeze(["connfy"]);

const OWNER_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/;

function list(value) {
  return value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function allowedOwners(env = process.env) {
  const names = env.API_REVIEW_ALLOWED_OWNERS === undefined ? [...DEFAULT_ALLOWED_OWNERS] : list(env.API_REVIEW_ALLOWED_OWNERS);
  if (names.some((s) => !OWNER_RE.test(s))) {
    throw new Error("API_REVIEW_ALLOWED_OWNERS must be a comma-separated list of account names, without wildcards");
  }
  return new Set(names);
}

export function allowedRepositories(env = process.env) {
  const names = env.API_REVIEW_ALLOWED_REPOS === undefined
    ? [] : env.API_REVIEW_ALLOWED_REPOS.split(",").map((s) => s.trim().toLowerCase());
  if (names.some((s) => !REPO_RE.test(s) || [".", ".."].includes(s.split("/")[1]))) {
    throw new Error("API_REVIEW_ALLOWED_REPOS must be an explicit comma-separated repository allowlist, without wildcards");
  }
  return new Set(names);
}

export function assertAllowedRepository(repo, env = process.env) {
  const name = String(repo).toLowerCase();
  if (!REPO_RE.test(name) || [".", ".."].includes(name.split("/")[1])) throw new Error(`Repository is not allowed: ${repo}`);
  const owners = allowedOwners(env);
  const repos = allowedRepositories(env);
  if (!owners.has(name.split("/")[0]) && !repos.has(name)) throw new Error(`Repository is not allowed: ${repo}`);
  if (!owners.size && !repos.size) throw new Error("No repository is allowed");
}

export function requestConfig(env = process.env) {
  return {
    apiReviewBotLogin: env.API_REVIEW_BOT_LOGIN,
    apiReviewBotId: env.API_REVIEW_BOT_ID,
    reviewRequestText: env.REVIEW_REQUEST_TEXT,
    botLogins: env.REVIEW_BOT_LOGINS?.split(",").map((s) => s.trim()).filter(Boolean),
  };
}
