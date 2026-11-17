#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checked, checkoutSnapshot, runNative, git } from "./reviewer/engine.mjs";
import { appClient, isPublishedReview, listReviews, reviewCycle } from "./reviewer/github.mjs";
import { freezePullRequest, reviewAndPublish, publicationReceiptKey } from "./reviewer/controller.mjs";
import { assertAllowedRepository } from "./reviewer/config.mjs";

export function parseArgs(args, env = process.env) {
  const [repo, rawNumber, ...rest] = args;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "") || !/^[1-9][0-9]*$/.test(rawNumber ?? "") || !Number.isSafeInteger(Number(rawNumber))) throw new Error("Usage: node scripts/review-pr.mjs OWNER/REPO NUMBER [--publish] [--artifacts DIR]");
  const options = { repo: repo.toLowerCase(), number: Number(rawNumber), publish: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--publish") options.publish = true;
    else if (rest[i] === "--artifacts" && rest[i + 1]) options.artifacts = rest[++i];
    else throw new Error(`Unknown/missing option: ${rest[i]}`);
  }
  assertAllowedRepository(options.repo, env);
  return options;
}

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  const options = parseArgs(args);
  assertAllowedRepository(options.repo);
  const readApi = async (endpoint) => JSON.parse(await checked("gh", ["api", endpoint.replace(/^\//, "")]));
  const api = options.publish ? await appClient() : readApi;
  const pr = await api(`/repos/${options.repo}/pulls/${options.number}`);
  const { boundary } = await reviewCycle(api, options, pr);
  const snapshot = freezePullRequest(pr, options.repo, options.number, { reviewBoundary: boundary });
  const identity = { login: process.env.API_REVIEW_BOT_LOGIN, id: process.env.API_REVIEW_BOT_ID };
  const stateRoot = path.resolve(process.env.API_REVIEW_STATE_DIR ?? path.join(os.homedir(), ".local/state/api-credit-reviewer"));
  const key = `${snapshot.repo.replace("/", "--")}-${snapshot.number}-${snapshot.head}`;
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(stateRoot, `${key}.lock`);
  await mkdir(lock).catch(() => { throw new Error(`Existing review lock: ${lock}; inspect its owner and artifacts before recovery`); });
  let scratch, artifactDir;
  try {
    if (options.artifacts) await mkdir(path.resolve(options.artifacts), { recursive: true });
    artifactDir = await mkdtemp(path.join(path.resolve(options.artifacts ?? stateRoot), `${key}-`));
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, artifactDir, snapshot }, null, 2));
    await writeFile(path.join(artifactDir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
    await writeFile(path.join(artifactDir, "pr.json"), JSON.stringify(pr, null, 2));
    const receiptFile = path.join(stateRoot, `${publicationReceiptKey(snapshot)}.json`);
    if (options.publish) {
      if (pr.state !== "open" || pr.draft) throw new Error("Only open, ready PRs can be published");
      if ((await listReviews(api, snapshot.repo, snapshot.number)).some((r) => isPublishedReview(r, snapshot, identity))) {
        console.log(JSON.stringify({ deduplicated: true, artifactDir })); return;
      }
      const prior = await readFile(receiptFile, "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (prior) throw new Error(`Existing ${prior.status} publication receipt; reconcile before retry: ${receiptFile}`);
    }
    scratch = await mkdtemp(path.join(os.tmpdir(), "api-credit-review-"));
    const prepared = await checkoutSnapshot(snapshot, scratch);
    await writeFile(path.join(artifactDir, "diff.patch"), await readFile(path.join(scratch, "diff.patch")));
    await writeFile(path.join(artifactDir, "input.json"), JSON.stringify({ ...snapshot, mergeBase: prepared.mergeBase, checkout: prepared.checkout }, null, 2));
    const { result, publication } = await reviewAndPublish({
      snapshot, publish: options.publish, api, identity, cleanText: process.env.API_REVIEW_CLEAN_TEXT,
      performReview: () => runNative({ snapshot, scratch, artifactDir, prepared }),
      saveResult: async (result, payload) => {
        await writeFile(path.join(artifactDir, "result.json"), JSON.stringify(result, null, 2));
        await writeFile(path.join(artifactDir, "review-payload.json"), JSON.stringify(payload, null, 2));
      },
      beforePost: () => writeFile(receiptFile, JSON.stringify({ status: "post-intent", artifactDir, snapshot }), { flag: "wx" }),
    });
    if (options.publish) {
      await writeFile(receiptFile, JSON.stringify({ status: "published", artifactDir, snapshot, publication }, null, 2));
    }
    await writeFile(path.join(artifactDir, "completion.json"), JSON.stringify(publication, null, 2));
    console.log(JSON.stringify({ artifactDir, blocking: result.blocking.length, findings: result.findings.length, ...publication }));
  } catch (error) {
    if (artifactDir) await writeFile(path.join(artifactDir, "failure.json"), JSON.stringify({ error: error.message, scratch, retained: true }, null, 2));
    // Preserve all partial output; no clean payload/publication on failure.
    throw error;
  } finally {
    try { if (scratch) {
      // Preserve scratch on failure for diagnosis; only remove a successful,
      // freshly created checkout after its transcript/result have been saved.
      const complete = artifactDir && await readFile(path.join(artifactDir, "completion.json")).then(() => true, () => false);
      if (complete) { await git(path.join(scratch, "objects.git"), ["worktree", "remove", path.join(scratch, "checkout")]); await rm(scratch, { recursive: true }); }
    } } finally { await rm(lock, { recursive: true }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
