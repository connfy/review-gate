import path from "node:path";

export const CLEAN_TEXT = "API Credit Codex Review: No actionable P0–P2 findings.";
export const SHA = /^[0-9a-f]{40}$/;
export const marker = ({ head, base }) => `<!-- api-credit-review:v1 head=${head} base=${base} -->`;
const fail = (message) => { throw new Error(message); };
const text = (v) => typeof v === "string" && v.trim().length > 0;
const score = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const keys = (v, expected) => v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join() === expected.sort().join();

// Native review's parser has a prose fallback with empty correctness. Never
// promote that fallback (or missing fields/unknown priorities) to a clean pass.
export function validateReview(result, { checkout, changedLines }) {
  if (!keys(result, ["findings", "overall_correctness", "overall_explanation", "overall_confidence_score"]) ||
      !Array.isArray(result.findings) || !text(result.overall_explanation) ||
      !score(result.overall_confidence_score) ||
      !["patch is correct", "patch is incorrect"].includes(result.overall_correctness)) fail("Incomplete native review result");
  const seen = new Set();
  const findings = result.findings.map((f) => {
    if (!keys(f, ["title", "body", "confidence_score", "priority", "code_location"]) ||
        !text(f.title) || !text(f.body) || !score(f.confidence_score) ||
        !Number.isInteger(f.priority) || f.priority < 0 || f.priority > 3 ||
        !f.title.startsWith(`[P${f.priority}]`) ||
        !keys(f.code_location, ["absolute_file_path", "line_range"]) ||
        !keys(f.code_location.line_range, ["start", "end"])) fail("Malformed finding");
    const { absolute_file_path: file, line_range: { start, end } } = f.code_location;
    if (!text(file) || !path.isAbsolute(file) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) fail("Invalid finding location");
    const relative = path.relative(checkout, file);
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) fail("Finding outside reviewed checkout");
    const sides = changedLines.get(relative);
    // A native finding must overlap the diff. Do not silently discard an invalid
    // finding and turn a failed review into a clean one.
    const side = ["RIGHT", "LEFT"].find((s) => sides?.[s] && [...sides[s]].some((line) => line >= start && line <= end));
    if (!side) fail("Finding does not overlap reviewed diff");
    const key = `${relative}:${start}:${end}:${f.title}`;
    if (seen.has(key)) fail("Duplicate finding");
    seen.add(key);
    const line = [...sides[side]].find((n) => n >= start && n <= end);
    return { ...f, path: relative, line, side };
  });
  const blocking = findings.filter((f) => f.priority <= 2);
  if ((blocking.length === 0) !== (result.overall_correctness === "patch is correct")) fail("Inconsistent correctness verdict");
  return { ...result, findings, blocking };
}

// Parse a zero-context, non-quoted git diff, retaining both added and deleted
// line anchors so actionable removals can be published, not silently dropped.
export function changedLinesFromDiff(diff) {
  const files = new Map();
  let file, oldFile;
  const ensure = (name) => { if (!files.has(name)) files.set(name, { RIGHT: new Set(), LEFT: new Set() }); };
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- a/")) oldFile = line.slice(6);
    else if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      if (file.startsWith('"')) fail("Quoted diff path unsupported");
      ensure(file);
    } else if (line.startsWith("+++ /dev/null")) { file = oldFile; if (file) ensure(file); }
    else if (file && line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) fail("Malformed diff hunk");
      for (const [side, start, count] of [["LEFT", m[1], m[2]], ["RIGHT", m[3], m[4]]]) {
        for (let i = 0; i < Number(count ?? 1); i++) files.get(file)[side].add(Number(start) + i);
      }
    }
  }
  return files;
}

export function reviewPayload(snapshot, result, cleanText = CLEAN_TEXT) {
  if (!SHA.test(snapshot.head) || !SHA.test(snapshot.base) || !text(cleanText)) fail("Invalid publication contract");
  const body = result.blocking.length === 0
    ? `${marker(snapshot)}\n\n${cleanText}\n\nReviewed head: \`${snapshot.head}\`\nComparison base: \`${snapshot.base}\`\nNon-blocking P3 findings: ${result.findings.length}.`
    : `${marker(snapshot)}\n\nAPI Credit Codex Review: ${result.blocking.length} actionable P0–P2 finding(s).\n\nReviewed head: \`${snapshot.head}\`\nComparison base: \`${snapshot.base}\`\nNon-blocking P3 findings: ${result.findings.length - result.blocking.length}.`;
  // Do not put model-authored explanation into the summary: only the publisher
  // writes the clean signal, and P3 never opens a blocking thread.
  return {
    commit_id: snapshot.head, event: "COMMENT", body,
    comments: result.blocking.map((f) => ({ path: f.path, line: f.line, side: f.side, body: `${f.title}\n\n${f.body}` })),
  };
}

export function nativeEvidence(records, events, options) {
  const sessions = [];
  for (const record of records) {
    if (record.type === "session_meta") sessions.push({ meta: record.payload, records: [] });
    else if (sessions.length) sessions.at(-1).records.push(record);
    else fail("Native records lack session metadata");
  }
  const rootId = events.find((e) => e.type === "thread.started")?.thread_id;
  if (!text(rootId)) fail("Missing native root thread ID");
  const roots = sessions.filter((s) => s.meta.source === "exec" && s.meta.id === rootId);
  const children = sessions.filter((s) => s.meta.source?.subagent === "review" && s.meta.parent_thread_id === rootId);
  if (sessions.length !== 2 || roots.length !== 1 || children.length !== 1) fail("Missing unique native review session lineage");
  const root = roots[0], child = children[0];
  for (const s of [root, child]) {
    if (s.meta.cli_version !== "0.169.0" || s.meta.cwd !== options.checkout || s.meta.git?.commit_hash !== options.head) fail("Native session snapshot/version mismatch");
  }
  const contexts = child.records.filter((r) => r.type === "turn_context");
  if (!contexts.length || contexts.some((r) => r.payload.model !== "gpt-6.1-sol" || r.payload.effort !== "high" || r.payload.approval_policy !== "never")) fail("Unexpected native review model/effort/approval policy");
  const usage = child.records.filter((r) => r.type === "event_msg" && r.payload.type === "token_count").at(-1)?.payload.info?.total_token_usage;
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens <= 0 ||
      !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens <= 0 ||
      !Number.isSafeInteger(usage.cached_input_tokens) || usage.cached_input_tokens < 0 || usage.cached_input_tokens > usage.input_tokens ||
      usage.total_tokens !== usage.input_tokens + usage.output_tokens) fail("Missing valid native review usage");
  return { root, child, usage, rootId };
}

export function parseNativeResult(records, events, exitCode, options) {
  if (exitCode !== 0 || events.at(-1)?.type !== "turn.completed" ||
      events.some((e) => ["error", "turn.failed"].includes(e.type) || e.item?.type === "error" ||
        ["mcp_tool_call", "web_search", "collab_tool_call", "collab_agent_tool_call", "file_change"].includes(e.item?.type))) fail("Native review did not complete without runtime errors");
  const { root, child } = nativeEvidence(records, events, options);
  const completions = (session) => session.records.filter((r) => r.type === "event_msg" && r.payload?.type === "task_complete");
  const rootDone = completions(root), childDone = completions(child);
  if (rootDone.length !== 1 || childDone.length !== 1 ||
      !text(rootDone[0].payload.root_turn_id) ||
      rootDone[0].payload.root_turn_id !== childDone[0].payload.root_turn_id ||
      typeof childDone[0].payload.last_agent_message !== "string") fail("Missing unique completed native review output");
  const commands = events.filter((e) => e.type === "item.completed" && e.item?.type === "command_execution" && e.item.exit_code === 0);
  // Reject the known zero-tool-output failure, not a particular spelling of
  // source inspection. `git show`, Python readers, etc. are equally legitimate;
  // command-name heuristics are not a semantic review-completeness guarantee.
  if (!commands.some((e) => typeof e.item.aggregated_output === "string" && e.item.aggregated_output.trim())) fail("Missing successful inspection output");
  // Exec's public event stream renders review output and omits child usage.
  // Consume the review delegate's original strict JSON, not the parent's prose
  // or core parser fallback. Keep the original wrapper ledger unchanged.
  return validateReview(JSON.parse(childDone[0].payload.last_agent_message), options);
}
