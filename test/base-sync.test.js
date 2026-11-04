import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyBaseSyncEvidence } from "../src/base-sync.js";
import {
  baseSyncFixture as fixture,
  baseSyncTestHelpers,
} from "./fixtures/base-sync-synthetic.js";

const {
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
} = baseSyncTestHelpers;

function addEmptySubtree(evidence, commit, path) {
  const tree = structuredClone(evidence.trees[evidence.commits[commit].tree.sha]);
  tree.tree.push({ path, type: "tree", mode: "040000", sha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
  tree.sha = sha(JSON.stringify(tree.tree));
  evidence.trees[tree.sha] = tree;
  evidence.commits[commit].tree = { sha: tree.sha };
}

test("a merge cannot hide an unreviewed empty subtree behind an identical file patch", () => {
  const evidence = fixture();
  addEmptySubtree(evidence, S, "hidden");
  assert.throws(() => verifyBaseSyncEvidence(evidence), /complete tree delta/);
});

test("an unrelated base empty subtree is preserved as an atomic tree entry", () => {
  const evidence = fixture();
  addEmptySubtree(evidence, M, "base-empty");
  addEmptySubtree(evidence, S, "base-empty");
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
});

test("PR empty-subtree changes lack the supported text evidence required for carry", () => {
  const evidence = fixture();
  addEmptySubtree(evidence, R, "pr-empty");
  addEmptySubtree(evidence, S, "pr-empty");
  assert.throws(() => verifyBaseSyncEvidence(evidence), /complete tree delta/);
});

test("an apparently empty subtree with a nonempty object ID is incomplete evidence", () => {
  const evidence = fixture();
  addEmptySubtree(evidence, S, "hidden");
  evidence.trees[evidence.commits[S].tree.sha].tree.at(-1).sha = sha("not an empty tree");
  assert.throws(() => verifyBaseSyncEvidence(evidence), /inconsistent empty-subtree/);
});

test("an empty tree object cannot claim child entries", () => {
  const evidence = fixture();
  evidence.trees[evidence.commits[R].tree.sha].tree.find((entry) => entry.path === "src").sha =
    "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  assert.throws(() => verifyBaseSyncEvidence(evidence), /inconsistent empty-subtree/);
});

test("a second sync cannot roll back an already integrated base change", () => {
  const evidence = baseSyncTestHelpers.backwardSyncs();
  assert.throws(() => verifyBaseSyncEvidence(evidence), /moves backward or diverges/);
});

test("two base parents on the live branch cannot replace sequential base ancestry", () => {
  const evidence = twoSyncs();
  evidence.commits[M2].parents = [{ sha: B }];
  evidence.commits[L].parents = [{ sha: M }, { sha: M2 }];
  evidence.liveBaseSha = L;
  evidence.comparisons[`${M}...${L}`] = compare(M, L, M, "ahead");
  evidence.comparisons[`${M2}...${L}`] = compare(M2, L, M2, "ahead");
  evidence.comparisons[`${M}...${M2}`] = compare(M, M2, B, "diverged");
  assert.throws(() => verifyBaseSyncEvidence(evidence), /moves backward or diverges/);
});

test("an unchanged integrated base is harmless when the exact tree remains unchanged", () => {
  const evidence = twoSyncs();
  evidence.commits[S2].parents[1].sha = M;
  evidence.commits[S2].tree = { ...evidence.commits[S].tree };
  evidence.comparisons[`${M}...${S2}`] = compare(M, S2, M, "ahead", [changedFile()], [R, S, S2]);
  evidence.comparisons[`${M}...${M}`] = compare(M, M, M, "identical");
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S2);
});

test("missing evidence for base progression fails closed", () => {
  const evidence = twoSyncs();
  evidence.liveBaseSha = L;
  evidence.commits[L].parents = [{ sha: M2 }];
  evidence.comparisons[`${M2}...${L}`] = compare(M2, L, M2, "ahead");
  delete evidence.comparisons[`${M}...${M2}`];
  assert.throws(() => verifyBaseSyncEvidence(evidence), /missing comparison/);
});

test("a disjoint two-parent base sync preserves the reviewed change without mutating evidence", () => {
  const evidence = fixture();
  const before = structuredClone(evidence);
  assert.deepEqual(verifyBaseSyncEvidence(evidence), {
    reviewedSha: R,
    headSha: S,
    liveBaseSha: L,
    integratedBaseSha: M,
  });
  assert.deepEqual(evidence, before);
});

test("the integrated base can itself be the live tip", () => {
  const evidence = fixture();
  evidence.liveBaseSha = M;
  evidence.comparisons[`${M}...${M}`] = compare(M, M, M, "identical");
  assert.equal(verifyBaseSyncEvidence(evidence).integratedBaseSha, M);
});

test("two syncs remain anchored to the original directly reviewed commit", () => {
  const evidence = twoSyncs();
  assert.deepEqual(verifyBaseSyncEvidence(evidence), {
    reviewedSha: R,
    headSha: S2,
    liveBaseSha: M2,
    integratedBaseSha: M2,
  });
  delete evidence.comparisons[`${M2}...${R}`];
  evidence.comparisons[`${M2}...${S}`] = compare(M2, S, B, "diverged", [changedFile()]);
  assert.throws(() => verifyBaseSyncEvidence(evidence), /missing comparison/);
});

test("a later clean overlay cannot conceal an evil intermediate sync", () => {
  const evidence = twoSyncs();
  setLeaf(evidence, S, "src/review.txt", leaf("unreviewed intermediate edit"));
  assert.throws(() => verifyBaseSyncEvidence(evidence), /exact reviewed\/base tree overlay/);
});

test("a second base advance is checked against the original reviewed path delta", () => {
  const evidence = twoSyncs();
  setLeaf(evidence, M2, "src/review.txt", leaf("new base edits reviewed file"));
  assert.throws(() => verifyBaseSyncEvidence(evidence), /changes overlap/);
});

test("a hidden content edit fails even when both API patches say the same thing", () => {
  const evidence = fixture();
  setLeaf(evidence, S, "src/review.txt", leaf("evil merged content"));
  assert.throws(() => verifyBaseSyncEvidence(evidence), /exact reviewed\/base tree overlay/);
});

test("an executable-bit edit hidden by the patch fails the tree overlay", () => {
  const evidence = fixture();
  setLeaf(evidence, S, "src/review.txt", { ...reviewed, mode: "100755" });
  assert.throws(() => verifyBaseSyncEvidence(evidence), /exact reviewed\/base tree overlay/);
});

test("a reviewed executable-bit change accompanied by text is preserved exactly", () => {
  const evidence = fixture();
  for (const commit of [R, S]) {
    setLeaf(evidence, commit, "src/review.txt", { ...reviewed, mode: "100755" });
  }
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
});

for (const [label, mutate] of [
  ["extra file", (evidence) => setLeaf(evidence, S, "hidden.txt", leaf("extra"))],
  ["base file edit", (evidence) => setLeaf(evidence, S, "src/base.txt", leaf("evil base edit"))],
  ["base file deletion", (evidence) => setLeaf(evidence, S, "src/base.txt", null)],
  ["missing reviewed comparison file", (evidence) => { original(evidence).files = []; }],
  ["missing integrated comparison file", (evidence) => { integrated(evidence).files = []; }],
]) {
  test(`complete tree coverage detects ${label}`, () => {
    const evidence = fixture();
    mutate(evidence);
    assert.throws(() => verifyBaseSyncEvidence(evidence), /complete tree delta/);
  });
}

test("a base change to the reviewed file is ineligible even with a plausible merge patch", () => {
  const evidence = fixture();
  setLeaf(evidence, M, "src/review.txt", leaf("overlapping base edit"));
  assert.throws(() => verifyBaseSyncEvidence(evidence), /changes overlap/);
});

for (const [prPath, basePath] of [["docs/guide.txt", "docs"], ["docs", "docs/guide.txt"]]) {
  test(`file/directory overlap is detected for PR ${prPath} and base ${basePath}`, () => {
    const evidence = fixture();
    setTree(evidence, B, { "base.txt": base });
    setTree(evidence, R, { "base.txt": base, [prPath]: reviewed });
    setTree(evidence, M, { "base.txt": base, [basePath]: advanced });
    setTree(evidence, S, { "base.txt": base, [prPath]: reviewed });
    setFiles(evidence, [changedFile({ filename: prPath, status: "added", deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+reviewed" })]);
    assert.throws(() => verifyBaseSyncEvidence(evidence), /overlap|file\/directory conflict/);
  });
}

test("a modified rename accounts for both endpoints and preserves its metadata", () => {
  const evidence = fixture();
  for (const commit of [R, S]) {
    setLeaf(evidence, commit, "src/review.txt", null);
    setLeaf(evidence, commit, "docs/review.txt", reviewed);
  }
  setFiles(evidence, [changedFile({ filename: "docs/review.txt", previous_filename: "src/review.txt", status: "renamed" })]);
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
  original(evidence).files[0].previous_filename = "src/missing.txt";
  assert.throws(() => verifyBaseSyncEvidence(evidence), /unchanged path/);
});

for (const endpoint of ["src/review.txt", "docs/review.txt"]) {
  test(`base changes cannot overlap rename endpoint ${endpoint}`, () => {
    const evidence = fixture();
    for (const commit of [R, S]) {
      setLeaf(evidence, commit, "src/review.txt", null);
      setLeaf(evidence, commit, "docs/review.txt", reviewed);
    }
    setLeaf(evidence, M, endpoint, leaf("base rename collision"));
    setFiles(evidence, [changedFile({ filename: "docs/review.txt", previous_filename: "src/review.txt", status: "renamed" })]);
    assert.throws(() => verifyBaseSyncEvidence(evidence), /changes overlap/);
  });
}

test("added and deleted reviewed files use tree absences in the overlay", () => {
  const evidence = fixture();
  for (const commit of [R, S]) {
    setLeaf(evidence, commit, "src/review.txt", null);
    setLeaf(evidence, commit, "new.txt", reviewed);
  }
  setFiles(evidence, [
    changedFile({ status: "removed", additions: 0, changes: 1, patch: "@@ -1 +0,0 @@\n-old" }),
    changedFile({ filename: "new.txt", status: "added", deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+reviewed" }),
  ]);
  integrated(evidence).files.reverse();
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
});

test("unrelated base symlinks, submodules, and binary blobs survive by exact tree identity", () => {
  const evidence = fixture();
  for (const commit of [M, S]) {
    setLeaf(evidence, commit, "base-link", leaf("base symlink", "120000"));
    setLeaf(evidence, commit, "base-module", leaf("base module", "160000", "commit"));
    setLeaf(evidence, commit, "base.bin", leaf("base binary"));
  }
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
});

for (const entry of [leaf("symlink", "120000"), leaf("module", "160000", "commit")]) {
  test(`PR ${entry.type}/${entry.mode} changes take the ordinary review path`, () => {
    const evidence = fixture();
    for (const commit of [R, S]) {
      setLeaf(evidence, commit, "src/review.txt", entry);
    }
    assert.throws(() => verifyBaseSyncEvidence(evidence), /symlink, submodule, or unsupported PR file/);
  });
}

for (const count of [0, 1, 3]) {
  test(`${count}-parent commits cannot substitute for a two-parent base sync`, () => {
    const evidence = fixture();
    evidence.commits[S].parents = [R, M, L].slice(0, count).map((sha) => ({ sha }));
    assert.throws(() => verifyBaseSyncEvidence(evidence), /exactly two ordered parents/);
  });
}

test("a new authored commit after a carried sync requires a new direct review", () => {
  const evidence = fixture();
  const authored = sha("authored after sync");
  evidence.headSha = authored;
  evidence.commits[authored] = { sha: authored, tree: { ...evidence.commits[S].tree }, parents: [{ sha: S }] };
  assert.throws(() => verifyBaseSyncEvidence(evidence), /interrupts the base-sync chain/);
});

test("reversed merge parents do not reach the reviewed first-parent ancestor", () => {
  const evidence = fixture();
  evidence.commits[S].parents.reverse();
  assert.throws(() => verifyBaseSyncEvidence(evidence), /interrupts the base-sync chain/);
});

test("cycles in the first-parent walk are rejected", () => {
  const evidence = fixture();
  evidence.commits[S].parents = [{ sha: M }, { sha: L }];
  evidence.commits[M].parents = [{ sha: S }, { sha: B }];
  assert.throws(() => verifyBaseSyncEvidence(evidence), /chain contains a loop/);
});

test("a side parent pointing to a newer chain commit is also a cycle", () => {
  const evidence = twoSyncs();
  evidence.commits[S].parents[1] = { sha: S2 };
  assert.throws(() => verifyBaseSyncEvidence(evidence), /parent graph contains a loop/);
});

test("off-base second parents cannot establish base ancestry", () => {
  const evidence = fixture();
  evidence.comparisons[`${M}...${L}`] = compare(M, L, B, "diverged");
  assert.throws(() => verifyBaseSyncEvidence(evidence), /not an ancestor of the live base/);
});

test("a reversed base ancestry comparison is ineligible", () => {
  const evidence = fixture();
  evidence.comparisons[`${M}...${L}`] = compare(M, L, L, "behind");
  assert.throws(() => verifyBaseSyncEvidence(evidence), /not an ancestor of the live base/);
});

test("the synced comparison must have the integrated base as merge base", () => {
  const evidence = fixture();
  evidence.comparisons[`${M}...${S}`] = compare(M, S, B, "diverged", [changedFile()]);
  assert.throws(() => verifyBaseSyncEvidence(evidence), /does not descend from its second parent/);
});

test("complete commit lists add head validation; paginated lists never stand in for a head object", () => {
  const evidence = fixture();
  original(evidence).commits = [{ sha: B }];
  assert.throws(() => verifyBaseSyncEvidence(evidence), /complete commit list\/head/);
  original(evidence).total_commits = 2;
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
  delete original(evidence).total_commits;
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
});

test("a complete comparison identifies its head without assuming chronological tail order", () => {
  const evidence = fixture();
  original(evidence).commits = [{ sha: R }, { sha: B }];
  original(evidence).total_commits = 2;
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
});

for (const [label, mutate, pattern] of [
  ["missing commit", (evidence) => { delete evidence.commits[R]; }, /missing commit/],
  ["wrong commit identity", (evidence) => { evidence.commits[R].sha = B; }, /different SHA/],
  ["missing comparison", (evidence) => { delete evidence.comparisons[`${M}...${R}`]; }, /missing comparison/],
  ["wrong compare base", (evidence) => { original(evidence).base_commit.sha = B; }, /different base SHA/],
  ["invalid compare ancestry", (evidence) => { original(evidence).status = "ahead"; }, /inconsistent ancestry\/status/],
  ["missing commit list", (evidence) => { delete original(evidence).commits; }, /no commit list/],
  ["short merge-base SHA", (evidence) => { original(evidence).merge_base_commit.sha = "abc123"; }, /full lowercase/],
  ["duplicate parents", (evidence) => { evidence.commits[S].parents[1].sha = R; }, /duplicate parent/],
  ["self parent", (evidence) => { evidence.commits[S].parents[0].sha = S; }, /self or duplicate parent/],
  ["missing parent list", (evidence) => { delete evidence.commits[R].parents; }, /ordered parent array/],
]) {
  test(`invalid immutable evidence fails closed: ${label}`, () => {
    const evidence = fixture();
    mutate(evidence);
    assert.throws(() => verifyBaseSyncEvidence(evidence), pattern);
  });
}

for (const [label, mutate, pattern] of [
  ["missing tree", (tree, evidence) => { delete evidence.trees[tree.sha]; }, /missing complete tree/],
  ["truncated tree", (tree) => { tree.truncated = true; }, /truncated, or incomplete/],
  ["unknown completeness", (tree) => { delete tree.truncated; }, /truncated, or incomplete/],
  ["mismatched root", (tree) => { tree.sha = B; }, /mismatched, truncated/],
  ["duplicate path", (tree) => { tree.tree.push({ ...tree.tree.at(-1) }); }, /duplicate path/],
  ["invalid object SHA", (tree) => { tree.tree.at(-1).sha = "ABC"; }, /full lowercase/],
  ["invalid type", (tree) => { tree.tree.at(-1).type = "tag"; }, /invalid type\/mode/],
  ["invalid mode", (tree) => { tree.tree.at(-1).mode = "100600"; }, /invalid type\/mode/],
  ["type/mode disagreement", (tree) => { tree.tree.at(-1).mode = "040000"; }, /invalid type\/mode/],
  ["missing directory", (tree) => { tree.tree = tree.tree.filter((entry) => entry.type !== "tree"); }, /complete directory structure/],
  ["non-relative path", (tree) => { tree.tree.at(-1).path = "/absolute"; }, /relative Git path/],
  ["dot path", (tree) => { tree.tree.at(-1).path = "src/../file"; }, /relative Git path/],
]) {
  test(`incomplete or malformed tree evidence is rejected: ${label}`, () => {
    const evidence = fixture();
    mutate(evidence.trees[evidence.commits[R].tree.sha], evidence);
    assert.throws(() => verifyBaseSyncEvidence(evidence), pattern);
  });
}

test("file/directory collisions inside a purported recursive tree are invalid evidence", () => {
  const evidence = fixture();
  const tree = evidence.trees[evidence.commits[R].tree.sha];
  tree.tree.find((entry) => entry.path === "src").type = "blob";
  tree.tree.find((entry) => entry.path === "src").mode = "100644";
  assert.throws(() => verifyBaseSyncEvidence(evidence), /complete directory structure/);
});

test("file metadata is compared independently of its order and API blob SHA", () => {
  const evidence = fixture();
  original(evidence).files[0].sha = sha("original API blob field");
  integrated(evidence).files[0].sha = sha("different ignored API blob field");
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
});

for (const value of [undefined, null, "", "Binary files differ"]) {
  test(`missing or binary patch ${JSON.stringify(value)} cannot transfer review`, () => {
    const evidence = fixture();
    original(evidence).files[0].patch = value;
    integrated(evidence).files[0].patch = value;
    assert.throws(() => verifyBaseSyncEvidence(evidence), /complete text patch|outside a unified patch/);
  });
}

for (const [label, badPatch] of [
  ["missing added line", "@@ -1 +1 @@\n-old"],
  ["too many old lines", "@@ -1 +1 @@\n-old\n-hidden\n+reviewed"],
  ["malformed header", "@@ -1 +1 @\n-old\n+reviewed"],
  ["zero non-empty start", "@@ -0 +1 @@\n-old\n+reviewed"],
  ["unknown body prefix", "@@ -1 +1 @@\nold\n+reviewed"],
  ["dangling marker", "@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+reviewed"],
  ["repeated marker", "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n\\ No newline at end of file\n+reviewed"],
  ["lines beyond old EOF", "@@ -1,2 +1 @@\n-old\n\\ No newline at end of file\n-hidden\n+reviewed"],
  ["overlapping hunks", "@@ -1 +1 @@\n-old\n+reviewed\n@@ -1 +1 @@\n-old\n+reviewed"],
  ["unreported earlier hunk", "@@ -1 +2 @@\n-old\n+reviewed"],
  ["empty body line", "@@ -1 +1 @@\n-old\n\n+reviewed"],
]) {
  test(`malformed/incomplete unified patch is rejected: ${label}`, () => {
    const evidence = fixture();
    setFiles(evidence, [changedFile({ patch: badPatch })]);
    assert.throws(() => verifyBaseSyncEvidence(evidence), /patch|hunk|no-newline/);
  });
}

test("a syntactically valid patch must also match per-file additions/deletions", () => {
  const evidence = fixture();
  setFiles(evidence, [changedFile({ additions: 2, changes: 3 })]);
  assert.throws(() => verifyBaseSyncEvidence(evidence), /additions\/deletions disagree/);
});

test("metadata-only changes without text patches use ordinary review", () => {
  const evidence = fixture();
  setFiles(evidence, [changedFile({ additions: 0, deletions: 0, changes: 0, patch: "@@ -1 +1 @@\n unchanged" })]);
  assert.throws(() => verifyBaseSyncEvidence(evidence), /without a text change/);
});

test("only hunk start numbers normalize; counts, section labels, context, and whitespace remain exact", () => {
  const evidence = fixture();
  const first = "@@ -2,2 +2,3 @@ section\n context \r\n-old \r\n+reviewed \r\n+extra\n@@ -10 +11 @@\n-last\n+new";
  const shifted = first.replace("-2,2 +2,3", "-20,2 +20,3").replace("-10 +11", "-30 +31");
  setFiles(evidence, [changedFile({ additions: 3, deletions: 2, changes: 5, patch: first })]);
  integrated(evidence).files[0].patch = shifted;
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
  for (const altered of [
    shifted.replace("section", "different section"),
    shifted.replace(" context \r", " context\r"),
    shifted.replace("+reviewed \r", "+reviewed\r"),
    shifted.replace("-30 +31", "-30,1 +31,1"),
    shifted + "\n",
  ]) {
    integrated(evidence).files[0].patch = altered;
    assert.throws(() => verifyBaseSyncEvidence(evidence), /reviewed patch or metadata/);
  }
});

test("no-newline markers remain part of the reviewed patch", () => {
  const evidence = fixture();
  const marked = "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+reviewed\n\\ No newline at end of file";
  setFiles(evidence, [changedFile({ patch: marked })]);
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
  integrated(evidence).files[0].patch = patch;
  assert.throws(() => verifyBaseSyncEvidence(evidence), /reviewed patch or metadata/);
});

test("CRLF patch syntax and markers are preserved without line-ending normalization", () => {
  const evidence = fixture();
  const crlf = "@@ -1 +1 @@\r\n-old\r\n\\ No newline at end of file\r\n+reviewed\r\n\\ No newline at end of file\r";
  setFiles(evidence, [changedFile({ patch: crlf })]);
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
  integrated(evidence).files[0].patch = crlf.replaceAll("\r", "");
  assert.throws(() => verifyBaseSyncEvidence(evidence), /reviewed patch or metadata/);
});

for (const [label, mutate, pattern] of [
  ["missing files array", (file, comparison) => { delete comparison.files; }, /complete files array/],
  ["duplicate filename", (file, comparison) => { comparison.files.push({ ...file }); }, /duplicate file/],
  ["unsupported status", (file) => { file.status = "copied"; }, /unsupported file status/],
  ["wrong status", (file) => { file.status = "added"; }, /status disagrees/],
  ["orphan rename source", (file) => { file.previous_filename = "old.txt"; }, /rename source for a non-renamed/],
  ["invalid additions", (file) => { file.additions = -1; }, /non-negative safe integer/],
  ["inconsistent changes", (file) => { file.changes = 3; }, /changes disagree/],
]) {
  test(`comparison metadata cannot hide a different delta: ${label}`, () => {
    const evidence = fixture();
    mutate(original(evidence).files[0], original(evidence));
    assert.throws(() => verifyBaseSyncEvidence(evidence), pattern);
  });
}

test("the documented 300-file cap fails closed even if both lists look equal", () => {
  const evidence = fixture();
  setFiles(evidence, Array.from({ length: 300 }, (_, index) => changedFile({ filename: `file-${index}.txt` })));
  assert.throws(() => verifyBaseSyncEvidence(evidence), /300-file comparison limit/);
});

test("299 complete file deltas remain eligible without a smaller arbitrary limit", () => {
  const evidence = fixture();
  const before = { "base.txt": base };
  const after = { "base.txt": base };
  const files = [];
  for (let index = 0; index < 299; index += 1) {
    const filename = `file-${index}.txt`;
    before[filename] = old;
    after[filename] = reviewed;
    files.push(changedFile({ filename }));
  }
  setTree(evidence, B, before);
  setTree(evidence, R, after);
  setTree(evidence, M, { ...before, "base.txt": advanced });
  setTree(evidence, S, { ...after, "base.txt": advanced });
  setFiles(evidence, files);
  assert.equal(verifyBaseSyncEvidence(evidence).headSha, S);
});

test("input identities and maps are required, and the direct reviewed head is not a sync", () => {
  for (const evidence of [null, {}, { ...fixture(), reviewedSha: "ABC" }, { ...fixture(), commits: new Map() }]) {
    assert.throws(() => verifyBaseSyncEvidence(evidence), /Base sync evidence:/);
  }
  assert.throws(() => verifyBaseSyncEvidence({ ...fixture(), headSha: R }), /no base sync to verify/);
});
