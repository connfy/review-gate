import { createHash } from "node:crypto";

const sha = (label) => createHash("sha1").update(label).digest("hex");
const B = sha("merge base");
const R = sha("reviewed commit");
const M = sha("integrated base");
const S = sha("sync merge");
const L = sha("live base");
const M2 = sha("second integrated base");
const S2 = sha("second sync merge");
const patch = "@@ -1 +1 @@\n-old\n+reviewed";
const leaf = (content, mode = "100644", type = "blob") => ({
  sha: sha(content),
  mode,
  type,
});
const old = leaf("old reviewed file");
const reviewed = leaf("reviewed file");
const base = leaf("old base file");
const advanced = leaf("advanced base file");

function recursiveTree(leaves) {
  const entries = new Map(
    Object.entries(leaves).map(([path, entry]) => [path, { path, ...entry }]),
  );
  for (const path of Object.keys(leaves)) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count += 1) {
      const directory = parts.slice(0, count).join("/");
      if (!entries.has(directory)) {
        entries.set(directory, { path: directory, type: "tree", mode: "040000" });
      }
    }
  }
  const directories = [...entries.values()]
    .filter((entry) => entry.type === "tree")
    .sort(
      (left, right) =>
        right.path.split("/").length - left.path.split("/").length,
    );
  const children = (directory) =>
    [...entries.values()]
      .filter(
        (entry) =>
          entry.path.slice(0, entry.path.lastIndexOf("/")) === directory,
      )
      .sort((left, right) => left.path.localeCompare(right.path));
  for (const directory of directories) {
    directory.sha = sha(JSON.stringify(children(directory.path)));
  }
  const tree = [...entries.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return { sha: sha(JSON.stringify(tree)), truncated: false, tree };
}

function setTree(fixture, commit, leaves) {
  const tree = recursiveTree(leaves);
  fixture.trees[tree.sha] = tree;
  fixture.commits[commit].tree = { sha: tree.sha };
}

function leavesFor(fixture, commit) {
  const tree = fixture.trees[fixture.commits[commit].tree.sha];
  return Object.fromEntries(
    tree.tree
      .filter((entry) => entry.type !== "tree")
      .map(({ path, sha, type, mode }) => [path, { sha, type, mode }]),
  );
}

function setLeaf(fixture, commit, path, entry) {
  const leaves = leavesFor(fixture, commit);
  if (entry === null) {
    delete leaves[path];
  } else {
    leaves[path] = entry;
  }
  setTree(fixture, commit, leaves);
}

function compare(base, head, mergeBase, status, files = [], commits) {
  const commitShas =
    commits ?? (status === "behind" || status === "identical" ? [] : [head]);
  return {
    base_commit: { sha: base },
    merge_base_commit: { sha: mergeBase },
    status,
    commits: commitShas.map((sha) => ({ sha })),
    total_commits: commitShas.length,
    files: structuredClone(files),
  };
}

function changedFile(overrides = {}) {
  return {
    filename: "src/review.txt",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch,
    ...overrides,
  };
}

export function baseSyncFixture() {
  const result = {
    reviewedSha: R,
    headSha: S,
    liveBaseSha: L,
    commits: {},
    comparisons: {},
    trees: {},
  };
  for (const [commit, parents] of [
    [B, []],
    [R, [B]],
    [M, [B]],
    [S, [R, M]],
    [L, [M]],
  ]) {
    result.commits[commit] = {
      sha: commit,
      tree: {},
      parents: parents.map((sha) => ({ sha })),
    };
  }
  setTree(result, B, { "src/review.txt": old, "src/base.txt": base });
  setTree(result, R, { "src/review.txt": reviewed, "src/base.txt": base });
  setTree(result, M, { "src/review.txt": old, "src/base.txt": advanced });
  setTree(result, S, { "src/review.txt": reviewed, "src/base.txt": advanced });
  result.commits[L].tree = { ...result.commits[M].tree };
  result.comparisons[`${M}...${L}`] = compare(M, L, M, "ahead");
  result.comparisons[`${M}...${R}`] = compare(M, R, B, "diverged", [changedFile()]);
  result.comparisons[`${M}...${S}`] = compare(
    M, S, M, "ahead", [changedFile()], [R, S],
  );
  return result;
}

function original(fixture, base = M) {
  return fixture.comparisons[`${base}...${R}`];
}

function integrated(fixture, base = M, head = S) {
  return fixture.comparisons[`${base}...${head}`];
}

function setFiles(fixture, files) {
  original(fixture).files = structuredClone(files);
  integrated(fixture).files = structuredClone(files);
}

function twoSyncs() {
  const result = baseSyncFixture();
  result.headSha = S2;
  result.liveBaseSha = M2;
  result.commits[M2] = { sha: M2, parents: [{ sha: M }], tree: {} };
  result.commits[S2] = { sha: S2, parents: [{ sha: S }, { sha: M2 }], tree: {} };
  setTree(result, M2, {
    "src/review.txt": old,
    "src/base.txt": leaf("second base advance"),
  });
  setTree(result, S2, {
    "src/review.txt": reviewed,
    "src/base.txt": leaf("second base advance"),
  });
  result.comparisons[`${M}...${M2}`] = compare(M, M2, M, "ahead");
  result.comparisons[`${M2}...${M2}`] = compare(M2, M2, M2, "identical");
  result.comparisons[`${M2}...${R}`] = compare(M2, R, B, "diverged", [changedFile()]);
  result.comparisons[`${M2}...${S2}`] = compare(
    M2, S2, M2, "ahead", [changedFile()], [R, S, S2],
  );
  return result;
}

function backwardSyncs() {
  const result = baseSyncFixture();
  result.headSha = S2;
  result.liveBaseSha = M;
  result.commits[S2] = {
    sha: S2, parents: [{ sha: S }, { sha: B }], tree: { ...result.commits[R].tree },
  };
  result.comparisons[`${M}...${M}`] = compare(M, M, M, "identical");
  result.comparisons[`${B}...${M}`] = compare(B, M, B, "ahead");
  result.comparisons[`${B}...${R}`] = compare(B, R, B, "ahead", [changedFile()]);
  result.comparisons[`${B}...${S2}`] = compare(B, S2, B, "ahead", [changedFile()], [R, M, S, S2]);
  result.comparisons[`${M}...${B}`] = compare(M, B, B, "behind");
  return result;
}

export const baseSyncTestHelpers = {
  sha,
  B, R, M, S, L, M2, S2,
  patch,
  leaf,
  old,
  reviewed,
  base,
  advanced,
  setTree,
  setLeaf,
  compare,
  changedFile,
  original,
  integrated,
  setFiles,
  twoSyncs,
  backwardSyncs,
};
