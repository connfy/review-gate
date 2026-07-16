export const PENDING_REVIEW_KEY_PREFIX = "pending-review:v1:";
export const DEFAULT_PENDING_REVIEW_TTL_SECONDS = 24 * 60 * 60;
export const MAX_PENDING_REVIEW_KEYS = 10_000;
const PENDING_REVIEW_PAGE_SIZE = 1_000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedRef(ref, sha = ref?.sha) {
  const installationId = Number(ref?.installationId);
  const prNumber = Number(ref?.prNumber);
  const owner = String(ref?.owner ?? "");
  const repo = String(ref?.repo ?? "");
  const normalizedSha = String(sha ?? "");
  const generation = String(ref?.generation ?? normalizedSha);

  if (
    !Number.isInteger(installationId) ||
    installationId <= 0 ||
    !Number.isInteger(prNumber) ||
    prNumber <= 0 ||
    owner.length === 0 ||
    repo.length === 0 ||
    normalizedSha.length === 0 ||
    generation.length === 0
  ) {
    return null;
  }

  return {
    installationId,
    owner,
    repo,
    prNumber,
    sha: normalizedSha,
    generation,
  };
}

export function pendingReviewIdentity(ref) {
  return `${String(ref?.owner ?? "")}/${String(ref?.repo ?? "")}#${Number(
    ref?.prNumber,
  )}`;
}

export function pendingReviewKey(
  ref,
  sha = ref?.sha,
  generation = ref?.generation ?? sha,
) {
  const normalized = normalizedRef({ ...ref, generation }, sha);
  if (!normalized) {
    return null;
  }

  return (
    PENDING_REVIEW_KEY_PREFIX +
    [
      normalized.installationId,
      encodeURIComponent(normalized.owner),
      encodeURIComponent(normalized.repo),
      normalized.prNumber,
      encodeURIComponent(normalized.sha),
      encodeURIComponent(normalized.generation),
    ].join(":")
  );
}

export function pendingReviewEntry(key) {
  const name = String(key?.name ?? "");
  if (!name.startsWith(PENDING_REVIEW_KEY_PREFIX)) {
    return null;
  }

  const metadataRef = normalizedRef(key?.metadata);
  if (metadataRef) {
    return { key: name, ref: metadataRef };
  }

  const parts = name.slice(PENDING_REVIEW_KEY_PREFIX.length).split(":");
  if (parts.length !== 6) {
    return null;
  }

  let owner;
  let repo;
  let sha;
  let generation;
  try {
    owner = decodeURIComponent(parts[1]);
    repo = decodeURIComponent(parts[2]);
    sha = decodeURIComponent(parts[4]);
    generation = decodeURIComponent(parts[5]);
  } catch {
    return null;
  }

  const ref = normalizedRef({
    installationId: Number(parts[0]),
    owner,
    repo,
    prNumber: Number(parts[3]),
    sha,
    generation,
  });
  return ref ? { key: name, ref } : null;
}

export async function listPendingReviews(namespace, options = {}) {
  if (!namespace?.list) {
    return { enabled: false, entries: [], listComplete: true };
  }

  const limit = Math.min(
    MAX_PENDING_REVIEW_KEYS,
    positiveInteger(options.limit, MAX_PENDING_REVIEW_KEYS),
  );
  const keys = [];
  let cursor;
  let listComplete = false;
  while (!listComplete && keys.length < limit) {
    const page = await namespace.list({
      prefix: PENDING_REVIEW_KEY_PREFIX,
      limit: Math.min(PENDING_REVIEW_PAGE_SIZE, limit - keys.length),
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...(page?.keys ?? []));
    listComplete = page?.list_complete !== false;
    cursor = page?.cursor;
    if (!listComplete && !cursor) {
      break;
    }
  }
  return {
    enabled: true,
    entries: keys
      .map((key) => pendingReviewEntry(key))
      .filter(Boolean),
    listComplete,
  };
}

export async function trackPendingReview(namespace, ref, result, options = {}) {
  if (!namespace?.put || !namespace?.delete) {
    return { enabled: false, action: "none", key: null };
  }

  const generation = result?.generation ?? result?.sha;
  const key = pendingReviewKey(ref, result?.sha, generation);
  if (!key) {
    throw new Error(
      "cannot track a pending review without a complete PR ref and SHA",
    );
  }

  if (String(result?.state ?? "") === "pending") {
    const metadata = normalizedRef({ ...ref, generation }, result.sha);
    await namespace.put(key, "", {
      expirationTtl: Math.max(
        60,
        positiveInteger(
          options.expirationTtl,
          DEFAULT_PENDING_REVIEW_TTL_SECONDS,
        ),
      ),
      metadata: {
        ...metadata,
        queuedAt: new Date(options.now ?? Date.now()).toISOString(),
      },
    });
    return { enabled: true, action: "put", key };
  }

  await namespace.delete(key);
  return { enabled: true, action: "delete", key };
}

export async function settlePendingReview(
  namespace,
  queuedEntry,
  result,
  options = {},
) {
  if (!namespace?.put || !namespace?.delete) {
    return { action: "none" };
  }

  const latestKey = pendingReviewKey(
    queuedEntry?.ref,
    result?.sha,
    result?.generation ?? result?.sha,
  );
  if (String(result?.state ?? "") === "pending") {
    if (latestKey && latestKey !== queuedEntry.key) {
      await trackPendingReview(namespace, queuedEntry.ref, result, options);
      await namespace.delete(queuedEntry.key);
      return { action: "requeued", key: latestKey };
    }
    return { action: "kept", key: queuedEntry.key };
  }

  await namespace.delete(queuedEntry.key);
  return { action: "removed", key: queuedEntry.key };
}
