# Recorded public GitHub base-sync fixture

Source: [cli/cli PR #14914](https://github.com/cli/cli/pull/14914), a public MIT-licensed repository. Captured using existing `gh` user authentication on 2026-11-04. `manifest.json` records each exact endpoint, capture time, raw SHA-256, stored SHA-256, and byte count. Every `raw/*.json.gz` decompresses to the unedited GitHub REST response; gzip timestamps are zero for reproducibility. `LICENSE.upstream` is the source repository's license at the integrated base commit.

`manifest.json` stores paths for `commits`, `comparisons`, and `trees`, plus `reviewedSha`, `headSha`, and `liveBaseSha`. A test can read/gunzip/JSON-parse those paths to construct the verifier's plain input object. There is no executable loader and no network access is required for replay. All five Git commit objects B, R, M, N, and L are included; the verifier validates L even though it does not need L's complete tree.

## What the recording establishes

The recorded PR head is `8aefc2564e7fa0d6aad62418fc491e266f193931` (N), with exactly two ordered parents:

- `23ca8c45cd3f0f0320e0d2577eac64380fe9b530` (R), the pre-sync PR head.
- `c4513d446bf98cfcbe72ed83f17cd3220174d88f` (M), the integrated `trunk` commit.

GitHub created N at `2026-11-03T10:40:37Z` with message `Merge branch 'trunk' into fix/issue-14856-549`. The raw Git commit has a verified signature and the REST commit metadata identifies committer `web-flow`. These are real GitHub-created Update branch merge responses. The public APIs do not attest whether a human clicked the UI button or invoked the equivalent update-branch API.

The merge base B is `d6b82b12e67d108b7c82d76d943a3a47814acbc1`. The live `trunk` ref captured independently is `eeb44bc432c0107de002dadd34a61b4e2bd15882` (L); `M...L` proves M is on that history. The captured PR's `base.sha` is M and is not used as the live ref.

R changes one leaf, `pkg/cmd/issue/develop/develop.go`; the base changes 196 independent leaves. Both PR comparisons have the same complete three-hunk patch (8 additions and 8 deletions). All four recursive trees are untruncated. An independent recording check found zero overlapping/file-directory paths and zero exact-overlay mismatches, comparing SHA/type/mode over every leaf. B/R have 1,495 leaves and M/N have 1,545 leaves.

A full REST first-parent commit diff was unexpectedly about 1 MB because it shows the 196-file base integration. It is retained only in external local evidence. The compact `merge-commit-origin-page1.json.gz` response deliberately requests one file and is used only for GitHub committer provenance; it is never evidence of complete changed-file coverage. The three compare responses and complete trees supply the geometry proof.

The complete recording was replayed successfully through `verifyBaseSyncEvidence` in `src/base-sync.js` at 2026-11-04T14:55:18.228Z (source SHA-256 `c286e48ffcd7eaaa6fe5012bdae69bea7512624fb9f6463b9ee6e80a547b8576`). The result identifies the expected R, N, L, and integrated M. This records a completed geometry-verifier replay and does not establish review authority.

## Scope of the test

This is a positive **merge geometry** recording. The name `reviewedSha` identifies the verifier's hypothetical source head R. No Codex review of this upstream PR was searched for, recorded, or asserted. The recording alone cannot authorize a Review Gate success. Authority, invalidation, current PR state, and publication-race checks require separate tests and evidence.
