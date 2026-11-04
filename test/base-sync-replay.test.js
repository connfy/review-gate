import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { verifyBaseSyncEvidence } from "../src/base-sync.js";

const root = new URL("./fixtures/base-sync-real/cli-cli-pr-14914/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const response = (path) => JSON.parse(gunzipSync(readFileSync(new URL(path, root))));
const mapResponses = (paths) => Object.fromEntries(
  Object.entries(paths).map(([sha, path]) => [sha, response(path)]),
);

test("recorded public Update branch responses retain their raw bytes and provenance", () => {
  for (const source of manifest.sources) {
    const stored = readFileSync(new URL(source.path, root));
    const raw = gunzipSync(stored);
    assert.equal(createHash("sha256").update(stored).digest("hex"), source.storedSha256);
    assert.equal(createHash("sha256").update(raw).digest("hex"), source.rawSha256);
    assert.equal(source.method, "GET");
  }
  assert.equal(response(manifest.metadata.repository).private, false);
  const origin = response(manifest.metadata.mergeCommitOrigin);
  assert.equal(origin.sha, manifest.headSha);
  assert.equal(origin.committer.login, "web-flow");
  assert.equal(origin.commit.committer.name, "GitHub");
});

test("real GitHub Update branch geometry replays through the production verifier", () => {
  const evidence = {
    reviewedSha: manifest.reviewedSha,
    headSha: manifest.headSha,
    liveBaseSha: manifest.liveBaseSha,
    commits: mapResponses(manifest.commits),
    comparisons: mapResponses(manifest.comparisons),
    trees: mapResponses(manifest.trees),
  };
  const result = verifyBaseSyncEvidence(evidence);
  assert.equal(result.reviewedSha, manifest.reviewedSha);
  assert.equal(result.headSha, manifest.headSha);
  assert.equal(result.liveBaseSha, manifest.liveBaseSha);
  assert.equal(result.integratedBaseSha, evidence.commits[manifest.headSha].parents[1].sha);
  // This recording establishes merge geometry only. No Codex review or gate
  // authority is asserted for an upstream PR; those are separate policy tests.
});
