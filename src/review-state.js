// Codex's versioned state supplies a full commit identity for its separate
// abbreviated receipt or PR reaction. The live summary alone is never a result.
const STATE_MARKER = "<!-- codex-review-state:v1 ";
const SHA = /^[0-9a-f]{40}$/;

export function parseCodeReviewStates(comments, statusBoardMarker) {
  const states = new Map();
  const failures = [];
  if (!statusBoardMarker) return { states, failures };
  const reject = (board, code) => failures.push({
    code, actorId: board?.user?.id ?? null, commentId: board?.id ?? null,
  });
  const byActor = new Map();
  for (const comment of comments) {
    const actor = comment?.user;
    if (actor?.type !== "Bot" || !String(comment?.body ?? "").includes(statusBoardMarker)) continue;
    if (!Number.isSafeInteger(actor.id) || actor.id <= 0) {
      reject(comment, "missing-actor-id");
      continue;
    }
    if (!byActor.has(actor.id)) byActor.set(actor.id, []);
    byActor.get(actor.id).push(comment);
  }
  for (const [actorId, boards] of byActor) {
    // One mutable provider summary is expected per actor. Conflicting snapshots
    // or multiple summaries cannot identify which review generation is current.
    if (boards.length !== 1) {
      reject(boards[0], "multiple-summaries");
      continue;
    }
    const board = boards[0];
    const body = String(board.body);
    const lines = body.split("\n");
    if (lines[0] !== statusBoardMarker ||
      !lines[1]?.startsWith(STATE_MARKER) || !lines[1].endsWith(" -->") ||
      (body.match(/<!-- codex-review-state:/g) ?? []).length !== 1) {
      reject(board, "unsupported-state-format");
      continue;
    }
    let state;
    try {
      state = JSON.parse(lines[1].slice(STATE_MARKER.length, -4));
    } catch {
      reject(board, "invalid-state-json");
      continue;
    }
    const code = state?.code_review;
    // A security-only summary has a present, explicitly never-run Code slot.
    // It is absent evidence, not protocol drift or a completed review.
    if (code && ["commit_sha", "has_any_findings", "has_unresolved_findings", "status"]
      .every((key) => Object.hasOwn(code, key) && code[key] === null)) continue;
    if (!code || typeof code.commit_sha !== "string" || !SHA.test(code.commit_sha) ||
      !["completed", "running"].includes(code.status)) {
      reject(board, "invalid-code-review-state");
      continue;
    }
    if (code.status === "completed" &&
      (typeof code.has_any_findings !== "boolean" || typeof code.has_unresolved_findings !== "boolean")) {
      reject(board, "invalid-findings-flags");
      continue;
    }
    const rows = lines.filter((line) => line.includes("**Code Review**"));
    const row = rows.length === 1 && rows[0].match(
      /^\| [^|]*\*\*Code Review\*\* \| [^|]*\*\*(Completed|Running)\*\* (?:since )?<relative-time datetime="([0-9T:.Z-]+)">[^<]*<\/relative-time> \| `([0-9a-f]+)` \|[^|]*\|\s*$/,
    );
    if (!row || row[1].toLowerCase() !== code.status || !code.commit_sha.startsWith(row[3])) {
      reject(board, "inconsistent-code-review-row");
      continue;
    }
    const stateTime = Date.parse(row[2]);
    const updatedAt = Date.parse(board.updated_at);
    if (!Number.isFinite(stateTime) || !Number.isFinite(updatedAt) ||
      Math.floor(stateTime / 1000) > Math.floor(updatedAt / 1000)) {
      reject(board, "inconsistent-code-review-time");
      continue;
    }
    // Other review roles can edit this board much later. Only the Code Review
    // row timestamps this activity; optional Security Review is a separate role.
    states.set(actorId, {
      reviewedSha: code.commit_sha,
      timestamp: Math.floor(stateTime / 1000) * 1000,
      clean: code.status === "completed" && code.has_any_findings === false && code.has_unresolved_findings === false,
      status: code.status,
      board,
    });
  }
  return { states, failures };
}
