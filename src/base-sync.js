// Immutable GitHub evidence for the narrow base-sync exception. Review-source
// authority and current PR lifecycle checks belong to the caller.

const FULL_SHA = /^[0-9a-f]{40}$/;
// SHA-1 of the Git object `tree 0\0`; an empty subtree has no file leaves but
// remains a tracked tree entry that the exact overlay must preserve.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FILE_LIMIT = 300; // GitHub's compare endpoint returns at most 300 files.
const FILE_MODES = new Set(["100644", "100755"]);
const MODES_BY_TYPE = {
  blob: new Set([...FILE_MODES, "120000"]),
  commit: new Set(["160000"]),
  tree: new Set(["040000"]),
};

function fail(message) {
  throw new Error(`Base sync evidence: ${message}`);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    fail(`${label} must be a full lowercase commit/object SHA`);
  }
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requirePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`${label} is not a complete relative Git path`);
  }
  return value;
}

function entryEqual(left, right) {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.sha === right.sha &&
      left.type === right.type &&
      left.mode === right.mode)
  );
}

function treeDelta(before, after) {
  const delta = new Set();
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (!entryEqual(before.get(path), after.get(path))) {
      delta.add(path);
    }
  }
  return delta;
}

function assertDisjoint(prDelta, baseDelta) {
  // A changed file also owns its directory structure: a base file at `a`
  // conflicts with a reviewed file at `a/b`, and conversely.
  const prAncestors = new Set();
  for (const path of prDelta) {
    let separator = path.indexOf("/");
    while (separator >= 0) {
      prAncestors.add(path.slice(0, separator));
      separator = path.indexOf("/", separator + 1);
    }
  }
  for (const path of baseDelta) {
    if (prDelta.has(path) || prAncestors.has(path)) {
      fail(`base and reviewed changes overlap at ${path}`);
    }
    let separator = path.indexOf("/");
    while (separator >= 0) {
      if (prDelta.has(path.slice(0, separator))) {
        fail(`base and reviewed changes have a file/directory conflict at ${path}`);
      }
      separator = path.indexOf("/", separator + 1);
    }
  }
}

function parseRange(startText, countText, label) {
  const start = Number(startText);
  const count = countText === undefined ? 1 : Number(countText);
  requireCount(start, `${label} start`);
  requireCount(count, `${label} count`);
  if (count > 0 && start === 0) {
    fail(`${label} has a zero start for a non-empty range`);
  }
  if (!Number.isSafeInteger(start + count)) {
    fail(`${label} range exceeds safe integer precision`);
  }
  // Empty ranges designate a boundary after start; non-empty ranges start at
  // a one-based line. This lets us detect missing hunks as well as overlaps.
  return { start, count, boundary: start - (count === 0 ? 0 : 1) };
}

function normalizePatch(patch, label) {
  if (typeof patch !== "string" || patch.length === 0) {
    fail(`${label} has no complete text patch`);
  }
  const lines = patch.split("\n");
  const hasFinalNewline = lines.at(-1) === "";
  if (hasFinalNewline) {
    lines.pop();
  }
  const normalized = [];
  let hunk = null;
  let additions = 0;
  let deletions = 0;
  let oldLines = 0;
  let newLines = 0;
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  let previousBody = null;
  let oldEnded = false;
  let newEnded = false;
  const finishHunk = () => {
    if (
      hunk &&
      (hunk.oldSeen !== hunk.old.count || hunk.newSeen !== hunk.new.count)
    ) {
      fail(`${label} has an incomplete unified patch hunk`);
    }
    if (hunk && !hunk.changed) {
      fail(`${label} has a hunk without a text change`);
    }
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      finishHunk();
      const header = line.match(
        /^@@ -((?:0|[1-9][0-9]*))(?:,((?:0|[1-9][0-9]*)))? \+((?:0|[1-9][0-9]*))(?:,((?:0|[1-9][0-9]*)))? @@([^\n]*)$/,
      );
      if (!header) {
        fail(`${label} has a malformed unified patch hunk header`);
      }
      const old = parseRange(header[1], header[2], `${label} old hunk`);
      const next = parseRange(header[3], header[4], `${label} new hunk`);
      if (
        old.boundary < previousOldEnd ||
        next.boundary < previousNewEnd ||
        next.boundary - old.boundary !== additions - deletions
      ) {
        fail(`${label} has overlapping, reversed, or incomplete hunk ranges`);
      }
      previousOldEnd = old.boundary + old.count;
      previousNewEnd = next.boundary + next.count;
      hunk = { old, new: next, oldSeen: 0, newSeen: 0, changed: false };
      previousBody = null;
      normalized.push(
        `@@ -?${header[2] === undefined ? "" : `,${header[2]}`} +?${header[4] === undefined ? "" : `,${header[4]}`} @@${header[5]}`,
      );
      continue;
    }
    if (!hunk) {
      fail(`${label} has content outside a unified patch hunk`);
    }
    if (
      line === "\\ No newline at end of file" ||
      line === "\\ No newline at end of file\r"
    ) {
      if (previousBody === null) {
        fail(`${label} has a misplaced no-newline marker`);
      }
      oldEnded ||= previousBody === "-" || previousBody === " ";
      newEnded ||= previousBody === "+" || previousBody === " ";
      previousBody = null;
      normalized.push(line);
      continue;
    }
    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") {
      fail(`${label} has a malformed unified patch body`);
    }
    if ((prefix !== "+" && oldEnded) || (prefix !== "-" && newEnded)) {
      fail(`${label} has lines after a no-newline end-of-file marker`);
    }
    if (prefix !== "+") {
      hunk.oldSeen += 1;
      oldLines += 1;
    }
    if (prefix !== "-") {
      hunk.newSeen += 1;
      newLines += 1;
    }
    if (prefix === "+") {
      additions += 1;
      hunk.changed = true;
    }
    if (prefix === "-") {
      deletions += 1;
      hunk.changed = true;
    }
    if (hunk.oldSeen > hunk.old.count || hunk.newSeen > hunk.new.count) {
      fail(`${label} has more patch lines than its hunk counts`);
    }
    previousBody = prefix;
    normalized.push(line);
  }
  finishHunk();
  if (!hunk || additions + deletions === 0) {
    fail(`${label} has no text change patch`);
  }
  return {
    text: normalized.join("\n") + (hasFinalNewline ? "\n" : ""),
    additions,
    deletions,
    oldLines,
    newLines,
  };
}

function reviewedFiles(comparison, before, after, label) {
  if (!Array.isArray(comparison.files)) {
    fail(`${label} has no complete files array`);
  }
  if (comparison.files.length >= FILE_LIMIT) {
    fail(`${label} reaches GitHub's ${FILE_LIMIT}-file comparison limit`);
  }
  const delta = treeDelta(before, after);
  const coverage = new Set();
  const files = new Map();
  for (const file of comparison.files) {
    requireRecord(file, `${label} file`);
    const path = requirePath(file.filename, `${label} filename`);
    if (files.has(path)) {
      fail(`${label} has duplicate file ${path}`);
    }
    if (!["added", "removed", "modified", "renamed"].includes(file.status)) {
      fail(`${label} has unsupported file status at ${path}`);
    }
    let previous = null;
    if (file.status === "renamed") {
      previous = requirePath(file.previous_filename, `${label} rename source`);
      if (previous === path) {
        fail(`${label} has a rename to the same path ${path}`);
      }
    } else if (file.previous_filename !== undefined) {
      fail(`${label} has a rename source for a non-renamed file ${path}`);
    }
    const paths = previous === null ? [path] : [previous, path];
    for (const changedPath of paths) {
      if (!delta.has(changedPath)) {
        fail(`${label} reports an unchanged path ${changedPath}`);
      }
      coverage.add(changedPath);
      for (const leaf of [before.get(changedPath), after.get(changedPath)]) {
        if (leaf && (leaf.type !== "blob" || !FILE_MODES.has(leaf.mode))) {
          fail(`${label} has a symlink, submodule, or unsupported PR file ${changedPath}`);
        }
      }
    }
    const oldPath = previous ?? path;
    const oldLeaf = before.get(oldPath);
    const newLeaf = after.get(path);
    if (
      (file.status === "added" && (oldLeaf || !newLeaf)) ||
      (file.status === "removed" && (!oldLeaf || newLeaf)) ||
      (file.status === "modified" && (!oldLeaf || !newLeaf)) ||
      (file.status === "renamed" && (!oldLeaf || !newLeaf))
    ) {
      fail(`${label} file status disagrees with complete trees at ${path}`);
    }
    const additions = requireCount(file.additions, `${label} ${path} additions`);
    const deletions = requireCount(file.deletions, `${label} ${path} deletions`);
    if (file.changes !== undefined && file.changes !== additions + deletions) {
      fail(`${label} ${path} changes disagree with additions/deletions`);
    }
    const patch = normalizePatch(file.patch, `${label} ${path}`);
    if (patch.additions !== additions || patch.deletions !== deletions) {
      fail(`${label} ${path} patch additions/deletions disagree with file counts`);
    }
    if (
      (file.status === "added" && patch.oldLines !== 0) ||
      (file.status === "removed" && patch.newLines !== 0)
    ) {
      fail(`${label} ${path} patch disagrees with added/removed file status`);
    }
    files.set(path, {
      filename: path,
      status: file.status,
      previous_filename: previous,
      additions,
      deletions,
      patch: patch.text,
    });
  }
  if (
    coverage.size !== delta.size ||
    [...delta].some((path) => !coverage.has(path))
  ) {
    fail(`${label} files do not cover the complete tree delta`);
  }
  return files;
}

function assertSameReviewedFiles(original, integrated) {
  if (original.size !== integrated.size) {
    fail("base sync changed the reviewed file list");
  }
  for (const [path, file] of original) {
    const other = integrated.get(path);
    if (!other || Object.keys(file).some((key) => file[key] !== other[key])) {
      fail(`base sync changed the reviewed patch or metadata at ${path}`);
    }
  }
}

export function verifyBaseSyncEvidence(evidence = {}) {
  requireRecord(evidence, "input");
  const { reviewedSha, headSha, liveBaseSha, commits, comparisons, trees } =
    evidence;
  requireSha(reviewedSha, "reviewed SHA");
  requireSha(headSha, "head SHA");
  requireSha(liveBaseSha, "live base SHA");
  requireRecord(commits, "commits map");
  requireRecord(comparisons, "comparisons map");
  requireRecord(trees, "trees map");
  const commitCache = new Map();
  const treeCache = new Map();

  const commitFor = (sha) => {
    if (commitCache.has(sha)) {
      return commitCache.get(sha);
    }
    if (!Object.hasOwn(commits, sha)) {
      fail(`missing commit ${sha}`);
    }
    const commit = requireRecord(commits[sha], `commit ${sha}`);
    if (commit.sha !== sha) {
      fail(`commit ${sha} returned a different SHA`);
    }
    requireSha(commit.tree?.sha, `commit ${sha} tree SHA`);
    if (!Array.isArray(commit.parents)) {
      fail(`commit ${sha} has no ordered parent array`);
    }
    const parents = new Set();
    for (const parent of commit.parents) {
      const parentSha = requireSha(parent?.sha, `commit ${sha} parent SHA`);
      if (parentSha === sha || parents.has(parentSha)) {
        fail(`commit ${sha} has a self or duplicate parent`);
      }
      parents.add(parentSha);
    }
    commitCache.set(sha, commit);
    return commit;
  };

  const treeFor = (sha) => {
    const treeSha = commitFor(sha).tree.sha;
    if (treeCache.has(treeSha)) {
      return treeCache.get(treeSha);
    }
    if (!Object.hasOwn(trees, treeSha)) {
      fail(`missing complete tree ${treeSha} for commit ${sha}`);
    }
    const tree = requireRecord(trees[treeSha], `tree ${treeSha}`);
    if (
      tree.sha !== treeSha ||
      tree.truncated !== false ||
      !Array.isArray(tree.tree)
    ) {
      fail(`tree ${treeSha} is mismatched, truncated, or incomplete`);
    }
    const entries = new Map();
    const leaves = new Map();
    const parentsWithChildren = new Set();
    for (const entry of tree.tree) {
      requireRecord(entry, `tree ${treeSha} entry`);
      const path = requirePath(entry.path, `tree ${treeSha} entry path`);
      requireSha(entry.sha, `tree ${treeSha} ${path} object SHA`);
      if (
        !Object.hasOwn(MODES_BY_TYPE, entry.type) ||
        !MODES_BY_TYPE[entry.type].has(entry.mode)
      ) {
        fail(`tree ${treeSha} has an invalid type/mode at ${path}`);
      }
      if (entries.has(path)) {
        fail(`tree ${treeSha} has duplicate path ${path}`);
      }
      entries.set(path, entry);
      if (path.includes("/")) parentsWithChildren.add(path.slice(0, path.lastIndexOf("/")));
      if (entry.type !== "tree") {
        leaves.set(path, { sha: entry.sha, type: entry.type, mode: entry.mode });
      }
    }
    for (const [path, entry] of entries) {
      if (entry.type !== "tree") continue;
      const empty = !parentsWithChildren.has(path);
      if (empty !== (entry.sha === EMPTY_TREE_SHA)) {
        fail(`tree ${treeSha} has inconsistent empty-subtree evidence at ${path}`);
      }
      // Ordinary directory structure follows its children; terminal empty
      // directories must instead participate as atomic overlay entries. A PR
      // change to one has no supported text patch and takes the normal path.
      if (empty) leaves.set(path, { sha: entry.sha, type: entry.type, mode: entry.mode });
    }
    for (const path of entries.keys()) {
      let separator = path.lastIndexOf("/");
      while (separator >= 0) {
        const directory = path.slice(0, separator);
        if (entries.get(directory)?.type !== "tree") {
          fail(`tree ${treeSha} lacks complete directory structure at ${directory}`);
        }
        separator = directory.lastIndexOf("/");
      }
    }
    treeCache.set(treeSha, leaves);
    return leaves;
  };

  const comparisonFor = (base, head) => {
    const key = `${base}...${head}`;
    if (!Object.hasOwn(comparisons, key)) {
      fail(`missing comparison ${key}`);
    }
    const comparison = requireRecord(comparisons[key], `comparison ${key}`);
    if (comparison.base_commit?.sha !== base) {
      fail(`comparison ${key} returned a different base SHA`);
    }
    const mergeBase = requireSha(
      comparison.merge_base_commit?.sha,
      `${key} merge base SHA`,
    );
    const status = comparison.status;
    if (
      !["ahead", "behind", "diverged", "identical"].includes(status) ||
      (status === "identical" && (base !== head || mergeBase !== base)) ||
      (status !== "identical" && base === head) ||
      (status === "ahead" && mergeBase !== base) ||
      (status === "behind" && mergeBase !== head) ||
      (status === "diverged" && (mergeBase === base || mergeBase === head))
    ) {
      fail(`comparison ${key} has inconsistent ancestry/status`);
    }
    if (!Array.isArray(comparison.commits)) {
      fail(`comparison ${key} has no commit list`);
    }
    for (const commit of comparison.commits) {
      requireSha(commit?.sha, `${key} compared commit SHA`);
    }
    if (comparison.total_commits !== undefined) {
      const total = requireCount(comparison.total_commits, `${key} total_commits`);
      if (
        comparison.commits.length > total ||
        (["ahead", "diverged"].includes(status) && total === 0) ||
        (["behind", "identical"].includes(status) && total !== 0) ||
        (total > 0 &&
          comparison.commits.length === total &&
          !comparison.commits.some((commit) => commit.sha === head))
      ) {
        fail(`comparison ${key} has an inconsistent complete commit list/head`);
      }
    }
    // GitHub compare has no head_commit field, and page one may not include
    // the head in its commit list. The full-SHA request key binds that read;
    // separately fetched commits and complete tree deltas prove its file result.
    commitFor(base);
    commitFor(head);
    return comparison;
  };

  commitFor(reviewedSha);
  commitFor(liveBaseSha);
  const chain = [];
  const seen = new Map();
  let current = headSha;
  while (current !== reviewedSha) {
    if (seen.has(current)) {
      fail("first-parent base-sync chain contains a loop");
    }
    seen.set(current, chain.length);
    const commit = commitFor(current);
    if (commit.parents.length !== 2) {
      fail(`commit ${current} interrupts the base-sync chain; exactly two ordered parents required`);
    }
    chain.push({ sha: current, base: commit.parents[1].sha });
    current = commit.parents[0].sha;
  }
  if (chain.length === 0) {
    fail("head is already the reviewed commit; no base sync to verify");
  }
  for (const [index, sync] of chain.entries()) {
    if (seen.has(sync.base) && seen.get(sync.base) <= index) {
      fail("base-sync parent graph contains a loop");
    }
  }
  // A sync must retain the base history integrated by the preceding sync.
  // Membership of both side parents in L alone permits a backward/divergent
  // second parent and an overlay that silently discards earlier base changes.
  for (let index = 0; index + 1 < chain.length; index += 1) {
    const olderBase = chain[index + 1].base;
    const newerBase = chain[index].base;
    const progression = comparisonFor(olderBase, newerBase);
    if (!["ahead", "identical"].includes(progression.status) ||
      progression.merge_base_commit.sha !== olderBase) {
      fail("base-sync chain moves backward or diverges from previously integrated base history");
    }
  }

  const reviewedTree = treeFor(reviewedSha);
  for (const sync of chain) {
    const ancestry = comparisonFor(sync.base, liveBaseSha);
    if (
      !["ahead", "identical"].includes(ancestry.status) ||
      ancestry.merge_base_commit.sha !== sync.base
    ) {
      fail(`second parent ${sync.base} is not an ancestor of the live base`);
    }
    const original = comparisonFor(sync.base, reviewedSha);
    const integrated = comparisonFor(sync.base, sync.sha);
    if (
      integrated.merge_base_commit.sha !== sync.base ||
      integrated.status !== "ahead"
    ) {
      fail(`sync ${sync.sha} does not descend from its second parent`);
    }
    const mergeBaseTree = treeFor(original.merge_base_commit.sha);
    const baseTree = treeFor(sync.base);
    const integratedTree = treeFor(sync.sha);
    const prDelta = treeDelta(mergeBaseTree, reviewedTree);
    assertDisjoint(prDelta, treeDelta(mergeBaseTree, baseTree));
    const originalFiles = reviewedFiles(
      original,
      mergeBaseTree,
      reviewedTree,
      `${sync.base}...${reviewedSha}`,
    );
    const integratedFiles = reviewedFiles(
      integrated,
      baseTree,
      integratedTree,
      `${sync.base}...${sync.sha}`,
    );
    assertSameReviewedFiles(originalFiles, integratedFiles);
    const paths = new Set([
      ...reviewedTree.keys(),
      ...baseTree.keys(),
      ...integratedTree.keys(),
    ]);
    for (const path of paths) {
      const expected = prDelta.has(path)
        ? reviewedTree.get(path)
        : baseTree.get(path);
      if (!entryEqual(expected, integratedTree.get(path))) {
        fail(`sync ${sync.sha} is not the exact reviewed/base tree overlay at ${path}`);
      }
    }
  }
  return {
    reviewedSha,
    headSha,
    liveBaseSha,
    integratedBaseSha: chain[0].base,
  };
}
