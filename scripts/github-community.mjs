#!/usr/bin/env node
// Sets up the community side of the GitHub mirror (github.com/codician-team/diffinery) as the
// account that owns MIRROR_TOKEN, so posts show Codician rather than a person:
//
// - the labels `roadmap`, `help wanted` and `good first issue`
// - Discussions turned on, and the welcome post (github-community/welcome-discussion.md) in Announcements
// - the roadmap issue (github-community/roadmap-issue.md), labelled and pinned
// - replies to issues and discussions, read from the `community-replies` branch (see replies() below)
//
// Every step looks first and only creates what is missing, so running it again changes nothing.
// A step the token isn't allowed to do is reported with the permission it needs, and the others
// still run. Run by the "GitHub community setup" workflow; by hand:
//
//   MIRROR_TOKEN=github_pat_... node scripts/github-community.mjs [--dry-run]
//
// GitHub has no API to pin a discussion or to edit discussion categories, so those stay as they are.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.MIRROR_REPO || "codician-team/diffinery";
const TOKEN = process.env.MIRROR_TOKEN;
const DRY = process.argv.includes("--dry-run");
const REPLIES_BRANCH = process.env.REPLIES_BRANCH || "community-replies";
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "github-community");

const WELCOME_TITLE = "Welcome to Diffinery";
const ROADMAP_TITLE = "Roadmap: what Diffinery doesn't do yet";
const LABELS = [
  { name: "roadmap", color: "f08a45", description: "Known gaps and planned work" },
  { name: "help wanted", color: "008672", description: "Extra attention is needed" },
  { name: "good first issue", color: "7057ff", description: "Good for newcomers" },
];

const results = [];
const report = (step, outcome, detail = "") => {
  results.push({ step, outcome, detail });
  const line = `${step}: ${outcome}${detail ? ` (${detail})` : ""}`;
  console.log(outcome === "failed" ? `::warning::${line}` : line);
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function rest(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "diffinery-github-community",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${method} ${url}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function graphql(query, variables) {
  const data = await rest("POST", "/graphql", { query, variables });
  if (data.errors?.length) throw new HttpError(403, data.errors.map((e) => e.message).join("; "));
  return data.data;
}

/** Why a step failed, in words that name the token permission to add. */
const why = (e, permission) => (e instanceof HttpError && (e.status === 403 || e.status === 404) ? `the token needs ${permission}: ${e.message}` : e.message);

async function labels() {
  for (const label of LABELS) {
    try {
      await rest("GET", `/repos/${REPO}/labels/${encodeURIComponent(label.name)}`);
      report(`Label "${label.name}"`, "already there");
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) {
        report(`Label "${label.name}"`, "failed", why(e, "Issues: Read and write"));
        continue;
      }
      if (DRY) {
        report(`Label "${label.name}"`, "would create");
        continue;
      }
      try {
        await rest("POST", `/repos/${REPO}/labels`, label);
        report(`Label "${label.name}"`, "created");
      } catch (e2) {
        report(`Label "${label.name}"`, "failed", why(e2, "Issues: Read and write"));
      }
    }
  }
}

async function discussions() {
  const [owner, name] = REPO.split("/");
  let repo = await rest("GET", `/repos/${REPO}`);
  if (!repo.has_discussions) {
    if (DRY) {
      report("Discussions", "would turn on");
      return;
    }
    try {
      repo = await rest("PATCH", `/repos/${REPO}`, { has_discussions: true });
      report("Discussions", "turned on");
    } catch (e) {
      report("Discussions", "failed", why(e, "Administration: Read and write (or turn Discussions on in Settings → General → Features)"));
      return;
    }
  } else report("Discussions", "already on");

  try {
    const q = await graphql(
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          id
          discussionCategories(first: 25) { nodes { id name } }
          discussions(first: 100) { nodes { title url } }
        }
      }`,
      { owner, name },
    );
    const existing = q.repository.discussions.nodes.find((d) => d.title === WELCOME_TITLE);
    if (existing) {
      report("Welcome discussion", "already there", existing.url);
      return;
    }
    const category = q.repository.discussionCategories.nodes.find((c) => c.name === "Announcements") ?? q.repository.discussionCategories.nodes.find((c) => c.name === "General");
    if (!category) {
      report("Welcome discussion", "failed", "no Announcements or General category");
      return;
    }
    if (DRY) {
      report("Welcome discussion", "would post", `in ${category.name}`);
      return;
    }
    const body = await readFile(path.join(DIR, "welcome-discussion.md"), "utf8");
    const created = await graphql(
      `mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
        createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) { discussion { url } }
      }`,
      { repositoryId: q.repository.id, categoryId: category.id, title: WELCOME_TITLE, body },
    );
    report("Welcome discussion", "posted", `${created.createDiscussion.discussion.url} in ${category.name}`);
  } catch (e) {
    report("Welcome discussion", "failed", why(e, "Discussions: Read and write"));
  }
}

async function roadmap() {
  let issue;
  try {
    // Pull requests come back from this endpoint too; they have a pull_request field.
    for (let page = 1; page <= 10 && !issue; page++) {
      const list = await rest("GET", `/repos/${REPO}/issues?state=all&per_page=100&page=${page}`);
      issue = list.find((i) => !i.pull_request && i.title === ROADMAP_TITLE);
      if (list.length < 100) break;
    }
  } catch (e) {
    report("Roadmap issue", "failed", why(e, "Issues: Read and write"));
    return;
  }
  if (issue) {
    report("Roadmap issue", "already there", issue.html_url);
    // GitHub drops labels from a new issue when the token may not label, so add them later.
    const missing = ["roadmap", "help wanted"].filter((l) => !issue.labels.some((x) => (x.name ?? x) === l));
    if (missing.length && DRY) report("Roadmap issue labels", "would add", missing.join(", "));
    else if (missing.length) {
      try {
        await rest("POST", `/repos/${REPO}/issues/${issue.number}/labels`, { labels: missing });
        report("Roadmap issue labels", "added", missing.join(", "));
      } catch (e) {
        report("Roadmap issue labels", "failed", why(e, "Issues: Read and write"));
      }
    }
  } else if (DRY) {
    report("Roadmap issue", "would open");
    return;
  } else {
    try {
      const body = await readFile(path.join(DIR, "roadmap-issue.md"), "utf8");
      issue = await rest("POST", `/repos/${REPO}/issues`, { title: ROADMAP_TITLE, body, labels: ["roadmap", "help wanted"] });
      report("Roadmap issue", "opened", issue.html_url);
    } catch (e) {
      report("Roadmap issue", "failed", why(e, "Issues: Read and write"));
      return;
    }
  }

  try {
    const q = await graphql(`query($id: ID!) { node(id: $id) { ... on Issue { isPinned } } }`, { id: issue.node_id });
    if (q.node.isPinned) {
      report("Pin roadmap issue", "already pinned");
      return;
    }
    if (DRY) {
      report("Pin roadmap issue", "would pin");
      return;
    }
    await graphql(`mutation($id: ID!) { pinIssue(input: { issueId: $id }) { issue { isPinned } } }`, { id: issue.node_id });
    report("Pin roadmap issue", "pinned");
  } catch (e) {
    report("Pin roadmap issue", "failed", why(e, "Issues: Read and write"));
  }
}

// Replies to issues and discussions on the mirror, posted as the token's account. They wait on
// the `community-replies` branch of this repository (never merged, never mirrored) as
// replies/<id>.md, so posting one needs a push to that branch and a run of this workflow, not a
// pull request. Each file starts with a header:
//
//   ---
//   target: issue 4            (or: discussion 2)
//   labels: bug, gh            (optional, added to an issue)
//   close: completed           (optional: completed or not_planned, closes an issue)
//   ---
//   The reply, in Markdown.
//
// The posted comment ends with <!-- diffinery-reply: <id> -->, and a reply whose marker is
// already on its target is skipped, so running again posts nothing twice.
function replyFiles() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("fetch", "--quiet", "--depth=1", "origin", `+refs/heads/${REPLIES_BRANCH}:refs/remotes/origin/${REPLIES_BRANCH}`);
  } catch {
    return null;
  }
  const ref = `origin/${REPLIES_BRANCH}`;
  const names = git("ls-tree", "--name-only", ref, "replies/").split("\n").filter((n) => n.endsWith(".md")).map((n) => n.slice("replies/".length));
  return names.sort().map((name) => ({ id: name.slice(0, -3), text: git("show", `${ref}:replies/${name}`) }));
}

function parseReply(id, text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("no --- header");
  const head = Object.fromEntries(
    m[1].split("\n").filter((l) => l.trim()).map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  const t = /^(issue|discussion) (\d+)$/.exec(head.target ?? "");
  if (!t) throw new Error(`target must be "issue N" or "discussion N", not "${head.target ?? ""}"`);
  if (head.close && !["completed", "not_planned"].includes(head.close)) throw new Error(`close must be completed or not_planned`);
  const body = m[2].trim();
  if (!body) throw new Error("empty reply");
  return {
    id,
    kind: t[1],
    number: Number(t[2]),
    labels: (head.labels ?? "").split(",").map((l) => l.trim()).filter(Boolean),
    close: head.close || null,
    marker: `<!-- diffinery-reply: ${id} -->`,
    body,
  };
}

async function issueReply(r, step) {
  let posted = false;
  for (let page = 1; page <= 20 && !posted; page++) {
    const list = await rest("GET", `/repos/${REPO}/issues/${r.number}/comments?per_page=100&page=${page}`);
    posted = list.some((c) => c.body?.includes(r.marker));
    if (list.length < 100) break;
  }
  if (posted) report(step, "already posted");
  else if (DRY) report(step, "would post");
  else {
    const c = await rest("POST", `/repos/${REPO}/issues/${r.number}/comments`, { body: `${r.body}\n\n${r.marker}\n` });
    report(step, "posted", c.html_url);
  }
  const issue = await rest("GET", `/repos/${REPO}/issues/${r.number}`);
  const missing = r.labels.filter((l) => !issue.labels.some((x) => (x.name ?? x) === l));
  if (missing.length) {
    if (DRY) report(`${step} labels`, "would add", missing.join(", "));
    else {
      await rest("POST", `/repos/${REPO}/issues/${r.number}/labels`, { labels: missing });
      report(`${step} labels`, "added", missing.join(", "));
    }
  }
  // Close only alongside the first posting, so an issue someone reopened stays open.
  if (r.close && !posted && issue.state === "open") {
    if (DRY) report(`${step} close`, "would close", r.close);
    else {
      await rest("PATCH", `/repos/${REPO}/issues/${r.number}`, { state: "closed", state_reason: r.close });
      report(`${step} close`, "closed", r.close);
    }
  }
}

async function discussionReply(r, step) {
  const [owner, name] = REPO.split("/");
  const q = await graphql(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        discussion(number: $number) { id comments(last: 100) { nodes { body replies(last: 50) { nodes { body } } } } }
      }
    }`,
    { owner, name, number: r.number },
  );
  const d = q.repository.discussion;
  if (!d) throw new HttpError(404, `discussion ${r.number} not found`);
  const bodies = d.comments.nodes.flatMap((c) => [c.body, ...c.replies.nodes.map((x) => x.body)]);
  if (bodies.some((b) => b?.includes(r.marker))) report(step, "already posted");
  else if (DRY) report(step, "would post");
  else {
    const c = await graphql(
      `mutation($id: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { url } } }`,
      { id: d.id, body: `${r.body}\n\n${r.marker}\n` },
    );
    report(step, "posted", c.addDiscussionComment.comment.url);
  }
}

async function replies() {
  let files;
  try {
    files = replyFiles();
  } catch (e) {
    report("Replies", "failed", e.message);
    return;
  }
  if (!files?.length) {
    report("Replies", "none waiting", `no replies/ on the ${REPLIES_BRANCH} branch`);
    return;
  }
  for (const f of files) {
    let r;
    try {
      r = parseReply(f.id, f.text);
    } catch (e) {
      report(`Reply ${f.id}`, "failed", e.message);
      continue;
    }
    const step = `Reply ${r.id} on ${r.kind} ${r.number}`;
    try {
      await (r.kind === "issue" ? issueReply(r, step) : discussionReply(r, step));
    } catch (e) {
      report(step, "failed", why(e, r.kind === "issue" ? "Issues: Read and write" : "Discussions: Read and write"));
    }
  }
}

async function summary() {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const { appendFile } = await import("node:fs/promises");
  const rows = results.map((r) => `| ${r.step} | ${r.outcome} | ${r.detail.replace(/\|/g, "\\|")} |`).join("\n");
  await appendFile(file, `## GitHub community setup${DRY ? " (dry run)" : ""}\n\n| Step | Outcome | Detail |\n| --- | --- | --- |\n${rows}\n`);
}

if (!TOKEN) {
  console.log("::notice::MIRROR_TOKEN is not set, so nothing was changed.");
  process.exit(0);
}
try {
  const me = await rest("GET", "/user");
  console.log(`Acting as ${me.login} on ${REPO}${DRY ? " (dry run)" : ""}`);
} catch {
  console.log(`Acting on ${REPO} with a token that can't read /user${DRY ? " (dry run)" : ""}`);
}
await labels();
await discussions();
await roadmap();
await replies();
await summary();
process.exitCode = results.some((r) => r.outcome === "failed") ? 1 : 0;
