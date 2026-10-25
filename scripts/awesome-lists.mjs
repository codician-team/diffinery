#!/usr/bin/env node
// Suggests Diffinery to curated "awesome" lists on GitHub (awesome-lists/lists.mjs), one pull
// request per list, as the account that owns OUTREACH_TOKEN, so they show Codician rather than
// a person. For each list it forks the repository, adds one line to the right section on a
// branch in the fork, and opens the pull request.
//
// A list where Diffinery is already listed, or where the pull request is already open or was
// closed, is left alone, so running it again changes nothing. A list whose rules don't allow
// the suggestion yet (notBefore) is skipped until that day. Run by the "Suggest Diffinery to
// awesome lists" workflow; by hand:
//
//   OUTREACH_TOKEN=ghp_... node scripts/awesome-lists.mjs [--dry-run] [--lists=id,id]
//
// OUTREACH_TOKEN must be a classic personal access token with the public_repo scope: GitHub's
// fine-grained tokens can't contribute to public repositories the account isn't a member of.
import { LISTS, FOOTER } from "./awesome-lists/lists.mjs";

const TOKEN = process.env.OUTREACH_TOKEN;
const DRY = process.argv.includes("--dry-run");
const pick = (process.argv.find((a) => a.startsWith("--lists="))?.slice(8) || "due").trim();
const today = (process.env.TODAY || new Date().toISOString()).slice(0, 10);
const API = process.env.GITHUB_API_URL_OVERRIDE || "https://api.github.com";
const BRANCH = "add-diffinery";

const results = [];
const report = (list, outcome, detail = "") => {
  results.push({ list, outcome, detail });
  const line = `${list}: ${outcome}${detail ? ` (${detail})` : ""}`;
  console.log(outcome === "failed" ? `::warning::${line}` : line);
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function rest(method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "diffinery-awesome-lists",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `${method} ${url}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** A file's text. The raw media type also works for files over 1 MB, where `content` comes back empty. */
async function fileText(repo, file, ref) {
  const res = await fetch(`${API}/repos/${repo}/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github.raw+json", "x-github-api-version": "2022-11-28", "user-agent": "diffinery-awesome-lists" },
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `GET ${repo}/${file}: ${res.status} ${text.slice(0, 300)}`);
  return text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The file with `entry.line` added to `entry.section`, or an error message. The section runs
 * from its heading to the next heading of the same or a higher level.
 */
export function addLine(text, entry) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const start = lines.findIndex((l) => l.trim() === entry.section);
  if (start < 0) return { error: `no section "${entry.section}"` };
  const level = entry.section.match(/^#+/)?.[0].length ?? 6;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s/);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
  }
  const items = [];
  for (let i = start + 1; i < end; i++) if (entry.item.test(lines[i])) items.push(i);
  if (!items.length) return { error: `no entries in "${entry.section}"` };
  let at;
  if (entry.place === "alpha") {
    const ours = entry.key(entry.line);
    const before = items.filter((i) => entry.key(lines[i]) < ours);
    // Sorts first: goes above the first entry.
    at = before.length ? before[before.length - 1] + 1 : items[0];
    // An entry's indented sub-items stay with it.
    while (before.length && at < end && /^\s+\S/.test(lines[at]) && !entry.item.test(lines[at])) at++;
  } else {
    at = items[items.length - 1] + 1;
    while (at < end && /^\s+[*-] /.test(lines[at])) at++;
  }
  lines.splice(at, 0, entry.line);
  return { text: lines.join(eol), at: at + 1 };
}

async function suggest(entry, me) {
  if (entry.notBefore && today < entry.notBefore) {
    report(entry.id, "not yet", `its rules allow it from ${entry.notBefore}`);
    return;
  }
  const upstream = await rest("GET", `/repos/${entry.repo}`);
  const base = upstream.default_branch;

  // A pull request from our fork, in any state: open means done, closed means the maintainers said no.
  const prs = await rest("GET", `/repos/${entry.repo}/pulls?state=all&per_page=100&head=${me}:${BRANCH}`);
  if (prs.length) {
    const pr = prs[0];
    report(entry.id, pr.merged_at ? "merged" : pr.state === "open" ? "already open" : "closed before, left alone", pr.html_url);
    return;
  }

  const text = await fileText(entry.repo, entry.file, base);
  if (/codician-team\/diffinery|diffinery\.com/i.test(text)) {
    report(entry.id, "already listed");
    return;
  }
  const preview = addLine(text, entry);
  if (preview.error) {
    report(entry.id, "failed", `${entry.file}: ${preview.error}; the list changed, so update awesome-lists/lists.mjs`);
    return;
  }
  if (DRY) {
    report(entry.id, "would open", `${entry.file} line ${preview.at}: ${entry.line}`);
    return;
  }

  // Named after the owner too: two lists can share a repository name (and a fork that already
  // exists comes back under its own name).
  const fork = await rest("POST", `/repos/${entry.repo}/forks`, { name: entry.repo.replace("/", "-"), default_branch_only: true });
  const forkBase = fork.default_branch || base;
  // Forking is asynchronous; wait until the fork answers.
  for (let i = 0; i < 20; i++) {
    try {
      await rest("GET", `/repos/${fork.full_name}/branches/${encodeURIComponent(forkBase)}`);
      break;
    } catch (e) {
      if (i === 19) throw e;
      await sleep(3000);
    }
  }
  // A fork left from an earlier run may be behind; bring it up to date where it can be.
  await rest("POST", `/repos/${fork.full_name}/merge-upstream`, { branch: forkBase }).catch(() => {});
  const head = (await rest("GET", `/repos/${fork.full_name}/git/ref/heads/${encodeURIComponent(forkBase)}`)).object.sha;
  const tree = (await rest("GET", `/repos/${fork.full_name}/git/commits/${head}`)).tree.sha;
  const changed = addLine(await fileText(fork.full_name, entry.file, head), entry);
  if (changed.error) {
    report(entry.id, "failed", `${entry.file} in ${fork.full_name}: ${changed.error}`);
    return;
  }
  // Through git objects rather than the contents API, which can't write files over 1 MB.
  const blob = await rest("POST", `/repos/${fork.full_name}/git/blobs`, { content: Buffer.from(changed.text, "utf8").toString("base64"), encoding: "base64" });
  const newTree = await rest("POST", `/repos/${fork.full_name}/git/trees`, { base_tree: tree, tree: [{ path: entry.file, mode: "100644", type: "blob", sha: blob.sha }] });
  const commit = await rest("POST", `/repos/${fork.full_name}/git/commits`, { message: entry.title.replace(/\s*🤖+$/u, ""), tree: newTree.sha, parents: [head] });
  try {
    await rest("POST", `/repos/${fork.full_name}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 422) throw e;
    // Left from an earlier run that stopped before opening the pull request.
    await rest("PATCH", `/repos/${fork.full_name}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
  }
  const pr = await rest("POST", `/repos/${entry.repo}/pulls`, {
    title: entry.title,
    head: `${me}:${BRANCH}`,
    base,
    body: entry.body + FOOTER,
    maintainer_can_modify: true,
  });
  report(entry.id, "opened", pr.html_url);
}

async function summary() {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const { appendFile } = await import("node:fs/promises");
  const rows = results.map((r) => `| ${r.list} | ${r.outcome} | ${r.detail.replace(/\|/g, "\\|")} |`).join("\n");
  await appendFile(file, `## Suggest Diffinery to awesome lists${DRY ? " (dry run)" : ""}\n\n| List | Outcome | Detail |\n| --- | --- | --- |\n${rows}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const chosen = pick === "due" ? LISTS : LISTS.filter((l) => pick.split(",").map((s) => s.trim()).includes(l.id));
  if (!chosen.length) {
    console.log(`::error::No list matches "${pick}". Lists: ${LISTS.map((l) => l.id).join(", ")}`);
    process.exit(1);
  }
  if (!TOKEN) {
    console.log("::notice::OUTREACH_TOKEN is not set, so nothing was changed.");
    process.exit(0);
  }
  let me;
  try {
    me = (await rest("GET", "/user")).login;
  } catch (e) {
    console.log(`::error::OUTREACH_TOKEN can't read /user: ${e.message}`);
    process.exit(1);
  }
  console.log(`Acting as ${me}${DRY ? " (dry run)" : ""}`);
  for (const entry of chosen) {
    try {
      await suggest(entry, me);
    } catch (e) {
      const hint = e instanceof HttpError && (e.status === 403 || e.status === 404) ? "the token needs the classic public_repo scope: " : "";
      report(entry.id, "failed", hint + e.message);
    }
  }
  await summary();
  process.exitCode = results.some((r) => r.outcome === "failed") ? 1 : 0;
}
