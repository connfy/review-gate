// GitHub App authentication plus the REST/GraphQL calls the gate needs.
// Runs on the Cloudflare Workers runtime using fetch + Web Crypto only.

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "review-gate";
const TOKEN_REFRESH_SKEW_MS = 60_000;

let privateKeyCache = null;
const installationTokenCache = new Map();

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const normalized = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(normalized);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

async function importPrivateKey(privateKeyPem) {
  if (privateKeyCache?.pem === privateKeyPem) {
    return privateKeyCache.key;
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  privateKeyCache = { pem: privateKeyPem, key };
  return key;
}

// Builds a short-lived App JWT (RS256). The private key must be PKCS#8 PEM.
export async function createAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 540, iss: String(appId) };

  const encoder = new TextEncoder();
  const signingInput =
    base64UrlEncode(encoder.encode(JSON.stringify(header))) +
    "." +
    base64UrlEncode(encoder.encode(JSON.stringify(payload)));

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function parseLastPageFromLink(linkHeader) {
  const link = String(linkHeader ?? "");
  const lastLink = link
    .split(",")
    .map((part) => part.trim())
    .find((part) => /;\s*rel="last"/.test(part));
  const match = lastLink?.match(/[?&]page=(\d+)/);
  const page = Number(match?.[1]);
  return Number.isInteger(page) && page > 0 ? page : null;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : fallback;
}

async function githubFetchResponse(token, method, path, { body, accept } = {}) {
  const headers = {
    Accept: accept ?? "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${text}`);
  }
  const text = await response.text();
  return {
    data: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

async function githubFetch(token, method, path, options = {}) {
  const response = await githubFetchResponse(token, method, path, options);
  return response.data;
}

async function githubPaginate(
  token,
  path,
  { accept, limit = Infinity, pageOffset = 0, pageCursor = pageOffset } = {},
) {
  if (Number.isFinite(limit) && limit <= 0) {
    return [];
  }
  const separator = path.includes("?") ? "&" : "?";
  const out = [];
  const perPage = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 100;
  const cursor = normalizeNonNegativeInteger(pageCursor);
  let page = normalizeNonNegativeInteger(pageOffset) + 1;
  let startPage = page;
  let wrapped = false;
  let retargeted = false;
  for (;;) {
    if (wrapped && page === startPage) {
      return out;
    }
    const response = await githubFetchResponse(
      token,
      "GET",
      `${path}${separator}per_page=${perPage}&page=${page}`,
      { accept },
    );
    const rows = response.data;
    if (!Array.isArray(rows)) {
      throw new Error(`expected list response from ${path}`);
    }
    const lastPage = parseLastPageFromLink(response.headers.get("link"));
    if (lastPage !== null && !retargeted) {
      const targetPage = (cursor % lastPage) + 1;
      retargeted = true;
      if (targetPage !== page) {
        page = targetPage;
        startPage = targetPage;
        wrapped = false;
        continue;
      }
    }
    if (rows.length === 0 && startPage > 1 && page > 1 && !wrapped) {
      page = 1;
      wrapped = true;
      continue;
    }
    out.push(...rows.slice(0, limit - out.length));
    if (out.length >= limit || rows.length < perPage) {
      return out;
    }
    page += 1;
  }
}

async function requestInstallationToken(jwt, installationId) {
  return githubFetch(
    jwt,
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    { body: {} },
  );
}

export async function getInstallationToken(jwt, installationId) {
  const data = await requestInstallationToken(jwt, installationId);
  return data.token;
}

export async function getCachedInstallationToken(
  appId,
  privateKeyPem,
  installationId,
) {
  const cacheKey = `${appId}:${installationId}`;
  const now = Date.now();
  const cached = installationTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
    return cached.token;
  }

  const jwt = await createAppJwt(appId, privateKeyPem);
  const data = await requestInstallationToken(jwt, installationId);
  const parsedExpiresAt = Date.parse(data.expires_at ?? "");
  const expiresAtMs = Number.isFinite(parsedExpiresAt)
    ? parsedExpiresAt
    : now + 55 * 60 * 1000;
  installationTokenCache.set(cacheKey, {
    token: data.token,
    expiresAtMs,
  });
  return data.token;
}

export async function listAppInstallations(appId, privateKeyPem, options = {}) {
  const jwt = await createAppJwt(appId, privateKeyPem);
  return githubPaginate(jwt, "/app/installations", options);
}

export async function listInstallationRepositories(token, options = {}) {
  const out = [];
  const limit = options.limit ?? Infinity;
  if (Number.isFinite(limit) && limit <= 0) {
    return out;
  }
  const perPage = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 100;
  const cursor = normalizeNonNegativeInteger(
    options.pageCursor ?? options.pageOffset,
  );
  let page = normalizeNonNegativeInteger(options.pageOffset) + 1;
  let wrapped = false;
  let retargeted = false;
  for (;;) {
    const response = await githubFetchResponse(
      token,
      "GET",
      `/installation/repositories?per_page=${perPage}&page=${page}`,
    );
    const data = response.data;
    const repositories = Array.isArray(data?.repositories)
      ? data.repositories
      : [];
    const totalCount = Number(data?.total_count);
    const lastPageFromCount =
      Number.isFinite(totalCount) && totalCount > 0
        ? Math.max(1, Math.ceil(totalCount / perPage))
        : null;
    const lastPage =
      parseLastPageFromLink(response.headers.get("link")) ?? lastPageFromCount;
    if (lastPage !== null && !retargeted) {
      const targetPage = (cursor % lastPage) + 1;
      retargeted = true;
      if (targetPage !== page) {
        page = targetPage;
        continue;
      }
    }
    if (repositories.length === 0 && page > 1 && !wrapped) {
      page = 1;
      wrapped = true;
      continue;
    }
    out.push(...repositories.slice(0, limit - out.length));
    if (out.length >= limit || repositories.length < perPage) {
      return out;
    }
    page += 1;
  }
}

export class RepoClient {
  constructor(token, owner, repo, statusContext) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.statusContext = statusContext;
  }

  pullRequest(prNumber) {
    return githubFetch(
      this.token,
      "GET",
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`,
    );
  }

  openPullRequests(options = {}) {
    return githubPaginate(
      this.token,
      `/repos/${this.owner}/${this.repo}/pulls?state=open&sort=updated&direction=desc`,
      options,
    );
  }

  issueComments(prNumber) {
    return githubPaginate(
      this.token,
      `/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`,
    );
  }

  issueReactions(prNumber, content = "+1") {
    const encodedContent = encodeURIComponent(content);
    const path =
      `/repos/${this.owner}/${this.repo}/issues/${prNumber}/reactions` +
      `?content=${encodedContent}`;
    return githubPaginate(this.token, path);
  }

  issueCommentReactions(commentId, content = "eyes") {
    const encodedContent = encodeURIComponent(content);
    const path =
      `/repos/${this.owner}/${this.repo}/issues/comments/${commentId}/reactions` +
      `?content=${encodedContent}`;
    return githubPaginate(this.token, path);
  }

  reviews(prNumber) {
    return githubPaginate(
      this.token,
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`,
    );
  }

  timelineEvents(prNumber) {
    return githubPaginate(
      this.token,
      `/repos/${this.owner}/${this.repo}/issues/${prNumber}/timeline`,
    );
  }

  async reviewThreads(prNumber) {
    const query = `
      query($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id isResolved isOutdated }
            }
          }
        }
      }
    `;
    const out = [];
    let cursor = null;
    for (;;) {
      const response = await fetch(`${API_ROOT}/graphql`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          query,
          variables: {
            owner: this.owner,
            repo: this.repo,
            number: prNumber,
            after: cursor,
          },
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub GraphQL failed: ${response.status} ${text}`);
      }
      const payload = await response.json();
      if (payload.errors) {
        throw new Error(JSON.stringify(payload.errors));
      }
      const threads =
        payload.data.repository.pullRequest.reviewThreads;
      out.push(...threads.nodes);
      if (!threads.pageInfo.hasNextPage) {
        return out;
      }
      cursor = threads.pageInfo.endCursor;
    }
  }

  setStatus(sha, { state, description, targetUrl }) {
    const body = {
      state,
      context: this.statusContext,
      description: description.slice(0, 140),
    };
    if (targetUrl) {
      body.target_url = targetUrl;
    }
    return githubFetch(
      this.token,
      "POST",
      `/repos/${this.owner}/${this.repo}/statuses/${sha}`,
      { body },
    );
  }

  async latestStatusForContext(sha) {
    const statuses = await githubPaginate(
      this.token,
      `/repos/${this.owner}/${this.repo}/commits/${sha}/statuses`,
      { limit: 1000 },
    );
    return (
      statuses.find((status) => status?.context === this.statusContext) ?? null
    );
  }
}
