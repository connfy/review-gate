# Recorded Codex authority evidence

Unedited public issue-comment API responses from connfy/review-gate PR #14,
captured on 2026-11-04. `summary.json` is issue comment 6634436926;
`receipt.json` is issue comment 6634435696. Both were read with
`GET /repos/connfy/review-gate/issues/comments/{id}`. No private consumer source
is included.

The separate receipt precedes the summary row's completion time. The production
parser must bind the receipt to the versioned full SHA without a mutable Git
ref lookup or an invented timestamp tolerance. This recording supplies actual
provider format evidence; it is independent of the Update branch geometry
recording under `base-sync-real`.

`summary-pr12.json` and `receipt-pr12.json` are complete comment objects extracted
from the paginated `GET /repos/connfy/review-gate/issues/12/comments` response;
`reactions-pr12.json` is its complete issue-reactions response. They were read
on 2026-11-04 UTC. The summary's Code Review is completed while optional Security
Review is running; the surviving PR-body `eyes` predates Code Review completion.
These static snapshots do not establish per-run reaction lifecycle. No running
Code Review sample was found in the bounded PR #1–#13 read. Running Code Review
rows elsewhere in tests are synthetic, using the observed Running presentation.

`summary-pr13.json` is the complete public PR #13 comment object from the same
comments read; `reactions-pr13.json` is its complete issue-reactions response,
read on 2026-11-04 UTC. This automatic-ready review has no separate clean receipt.
Its real `+1` reports `user.type: "User"`; the summary's Bot author and canonical
user endpoint identify the same numeric actor 199175422. Tests replay this
reaction-only authority instead of assuming a synthetic reaction's actor type.
