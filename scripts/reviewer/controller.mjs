import { SHA, reviewPayload } from "./contract.mjs";
import { publishReview } from "./github.mjs";

export function freezePullRequest(pr, repo, number) {
  if (pr.base?.repo?.full_name?.toLowerCase() !== repo || pr.number !== number || pr.state !== "open") throw new Error("Wrong or closed PR target");
  const snapshot = Object.freeze({ repo, number, head: pr.head?.sha, base: pr.base?.sha, frozenAt: new Date().toISOString() });
  if (!SHA.test(snapshot.head) || !SHA.test(snapshot.base)) throw new Error("Missing frozen SHAs");
  return snapshot;
}

// The model's only return channel is a validated native result. It never
// selects the destination, reviewed SHAs, review event, clean text, or tokens.
export async function reviewAndPublish({ snapshot, performReview, saveResult, publish = false, api, identity, cleanText, beforePost }) {
  const result = await performReview(snapshot);
  const payload = reviewPayload(snapshot, result, cleanText);
  await saveResult(result, payload);
  const publication = publish
    ? await publishReview({ api, snapshot, payload, identity, beforePost })
    : { dryRun: true };
  return { result, publication };
}
