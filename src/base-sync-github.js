// Collect immutable GitHub objects for the pure base-sync proof. No status or
// stored exemption is evidence: each evaluation starts from the actual review.
import { baseSyncReviewAuthority, cleanReviewSources, resolveConfig } from "./gate.js";

const fullSha = (value) => /^[0-9a-f]{40}$/.test(String(value ?? ""));

export async function collectBaseSyncEvidence(client, inputs) {
  inputs = { ...inputs, config: resolveConfig(inputs.config) };
  const { pr } = inputs;
  if (!inputs.config?.baseSyncEnabled) return null;
  const headSha = String(pr?.head?.sha ?? "");
  const baseRef = String(pr?.base?.ref ?? "");
  const baseRepository = String(pr?.base?.repo?.full_name ?? "");
  if (
    !fullSha(headSha) || !baseRef ||
    baseRepository.toLowerCase() !== `${client.owner}/${client.repo}`.toLowerCase()
  ) {
    return null;
  }
  const sources = cleanReviewSources(inputs);
  if (sources.length === 0) return null;
  const timelineHeads = new Set((inputs.timelineEvents ?? [])
    .filter((event) => event?.event === "committed").map((event) => event.sha));

  const commits = {};
  const comparisons = {};
  const trees = {};
  const pendingCommits = new Map();
  const pendingComparisons = new Map();
  const pendingTrees = new Map();
  const commit = (sha) => {
    if (!fullSha(sha)) throw new Error("base sync: invalid commit SHA");
    if (!pendingCommits.has(sha)) {
      pendingCommits.set(sha, client.gitCommit(sha).then((value) => {
        if (value?.sha !== sha) throw new Error("base sync: commit identity mismatch");
        commits[sha] = value;
        return value;
      }));
    }
    return pendingCommits.get(sha);
  };
  const compare = (base, head) => {
    if (!fullSha(base) || !fullSha(head)) {
      throw new Error("base sync: invalid comparison SHA");
    }
    const key = `${base}...${head}`;
    if (!pendingComparisons.has(key)) {
      pendingComparisons.set(key, client.compareCommits(base, head).then((value) => {
        comparisons[key] = value;
        return value;
      }));
    }
    return pendingComparisons.get(key);
  };
  const tree = async (sha) => {
    const value = await commit(sha);
    const treeSha = value?.tree?.sha;
    if (!fullSha(treeSha)) throw new Error("base sync: missing commit tree");
    if (!pendingTrees.has(treeSha)) {
      pendingTrees.set(treeSha, client.gitTree(treeSha).then((value) => {
        trees[treeSha] = value;
      }));
    }
    return pendingTrees.get(treeSha);
  };

  const merges = [];
  const visited = new Set();
  let cursor = headSha;
  let reviewedSha = null;
  while (!visited.has(cursor)) {
    if (!timelineHeads.has(cursor)) return null;
    visited.add(cursor);
    const value = await commit(cursor);
    if (!Array.isArray(value.parents) || value.parents.length !== 2) return null;
    merges.push(cursor);
    const parent = String(value.parents[0]?.sha ?? "");
    if (!timelineHeads.has(parent)) return null;
    await commit(parent);
    if (sources.some((source) => source.reviewedSha === parent)) {
      reviewedSha = parent;
      break;
    }
    cursor = parent;
  }
  if (reviewedSha === null) return null;
  if (!baseSyncReviewAuthority(inputs, { headSha, reviewedSha, commits })) {
    console.debug(`base sync: reviewed head ${reviewedSha} has superseding or incomplete review/timeline evidence`);
    return null;
  }

  const ref = await client.branchRef(baseRef);
  const liveBaseSha = String(ref?.object?.sha ?? "");
  if (ref?.object?.type !== "commit" || !fullSha(liveBaseSha)) {
    throw new Error("base sync: base ref is not a commit");
  }
  await commit(liveBaseSha);
  for (const sha of merges) {
    const base = String(commits[sha].parents[1]?.sha ?? "");
    const [, original] = await Promise.all([
      compare(base, liveBaseSha),
      compare(base, reviewedSha),
      compare(base, sha),
      commit(base),
    ]);
    const mergeBase = String(original?.merge_base_commit?.sha ?? "");
    await Promise.all([tree(mergeBase), tree(reviewedSha), tree(base), tree(sha)]);
  }
  for (let index = 0; index + 1 < merges.length; index += 1) {
    await compare(
      commits[merges[index + 1]].parents[1].sha,
      commits[merges[index]].parents[1].sha,
    );
  }
  return {
    headSha, reviewedSha, liveBaseSha, commits, comparisons, trees,
    baseRef, baseRepository,
  };
}
