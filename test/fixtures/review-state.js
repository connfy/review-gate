export const reviewBot = { login: "chatgpt-codex-connector[bot]", type: "Bot", id: 199175422 };

export function reviewStateComment(sha, completedAt, overrides = {}) {
  return {
    id: 9000, user: reviewBot, created_at: completedAt, updated_at: completedAt,
    html_url: "https://github.com/example/project/pull/123#issuecomment-9000",
    body: '<!-- codex-pull-request-review-summary -->\n' +
      `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: {
        commit_sha: sha, has_any_findings: false, has_unresolved_findings: false,
        status: "completed",
      }, security_review: { status: null } })} -->\n\n` +
      `| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${completedAt}">${completedAt}</relative-time> | \`${sha.slice(0, 7)}\` | Manual request |`,
    ...overrides,
  };
}
