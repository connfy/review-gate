// Cloudflare Worker entrypoint for the review gate.
//
// A single GitHub App delivers webhooks for every installed repository to this
// Worker. For each pull-request event we recompute the gate and report the
// configured commit status on the head SHA. No polling, no cron.

import { evaluateGate, resolveConfig } from "./gate.js";
import { getCachedInstallationToken, RepoClient } from "./github.js";
import {
  fastFailureResultFromEvent,
  pullRequestRefFromEvent,
  shouldIgnoreEvent,
  verifySignature,
} from "./webhook.js";

function configFromEnv(env) {
  const botLogins = env.REVIEW_BOT_LOGINS
    ? env.REVIEW_BOT_LOGINS.split(",").map((value) => value.trim()).filter(Boolean)
    : undefined;
  return resolveConfig({
    cleanText: env.CLEAN_REVIEW_TEXT,
    statusContext: env.STATUS_CONTEXT,
    botLogins,
  });
}

async function evaluateAndReport(env, ref, config) {
  const token = await getCachedInstallationToken(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    ref.installationId,
  );
  const client = new RepoClient(token, ref.owner, ref.repo, config.statusContext);

  const result = ref.fastResult
    ? ref.fastResult
    : await evaluateFromGitHub(client, ref, config);

  await client.setStatus(result.sha, {
    state: result.state,
    description: result.description,
    targetUrl: undefined,
  });

  return result;
}

async function evaluateFromGitHub(client, ref, config) {
  const pr = await client.pullRequest(ref.prNumber);
  const [issueComments, reviews, reviewThreads, timelineEvents] =
    await Promise.all([
      client.issueComments(ref.prNumber),
      client.reviews(ref.prNumber),
      client.reviewThreads(ref.prNumber),
      client.timelineEvents(ref.prNumber),
    ]);

  return evaluateGate({
    pr,
    issueComments,
    reviews,
    reviewThreads,
    timelineEvents,
    config,
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    const verified = await verifySignature(
      env.GITHUB_WEBHOOK_SECRET,
      rawBody,
      signature,
    );
    if (!verified) {
      return new Response("Invalid signature", { status: 401 });
    }

    const eventName = request.headers.get("x-github-event") ?? "";
    if (eventName === "ping") {
      return new Response("pong", { status: 200 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const ref = pullRequestRefFromEvent(eventName, payload);
    if (!ref) {
      return new Response("Ignored", { status: 202 });
    }

    const config = configFromEnv(env);
    if (shouldIgnoreEvent(eventName, payload, config)) {
      return new Response("Ignored", { status: 202 });
    }

    ref.fastResult = fastFailureResultFromEvent(eventName, payload);

    // Do the GitHub round-trips after responding so the webhook delivery is
    // acknowledged promptly even if the API calls take a moment.
    ctx.waitUntil(
      evaluateAndReport(env, ref, config).catch((error) => {
        console.error(
          `gate evaluation failed for ${ref.owner}/${ref.repo}#${ref.prNumber}:`,
          error,
        );
      }),
    );

    return new Response("Accepted", { status: 202 });
  },
};
