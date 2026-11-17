import { SHA, reviewPayload } from "./contract.mjs";
import { publishReview } from "./github.mjs";
import { assertAllowedRepository } from "./config.mjs";

export function freezePullRequest(pr, repo, number, { reviewBoundary = Date.parse(pr.created_at) } = {}) {
  assertAllowedRepository(repo);
  if (pr.base?.repo?.full_name?.toLowerCase() !== repo || pr.number !== number || pr.state !== "open") throw new Error("Wrong or closed PR target");
  if (!Number.isSafeInteger(reviewBoundary)) throw new Error("Missing server-stamped review boundary");
  const snapshot = Object.freeze({ repo, number, head: pr.head?.sha, base: pr.base?.sha, reviewBoundary, frozenAt: new Date().toISOString() });
  if (!SHA.test(snapshot.head) || !SHA.test(snapshot.base)) throw new Error("Missing frozen SHAs");
  return snapshot;
}

export const publicationReceiptKey = (snapshot) =>
  `${snapshot.repo.replace("/", "--")}-${snapshot.number}-${snapshot.head}-${snapshot.reviewBoundary}`;

// The model's only return channel is a validated native result. It never
// selects the destination, reviewed SHAs, review event, clean text, or tokens.
export async function reviewAndPublish({ snapshot, performReview, saveResult, publish = false, api, identity, cleanText, beforePost }) {
  assertAllowedRepository(snapshot.repo);
  const result = await performReview(snapshot);
  const payload = reviewPayload(snapshot, result, cleanText);
  await saveResult(result, payload);
  const publication = publish
    ? await publishReview({ api, snapshot, payload, identity, beforePost })
    : { dryRun: true };
  return { result, publication };
}
