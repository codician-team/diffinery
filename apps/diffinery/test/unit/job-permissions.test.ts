import { describe, expect, it } from "vitest";
import { parseWorkflow, type Workflow } from "@diffinery/workflow-yaml";
import {
  PERMISSIVE_DEFAULT,
  READ_ALL,
  RESTRICTED_DEFAULT,
  denied,
  permissionsForJob,
  readOnly,
  requestPermission,
  resolvePermissions,
  roleForPermissions,
  type JobPermissions,
} from "../../src/lib/job-permissions.js";
import { expandReusable, type Loader } from "../../src/repo/reusable.js";

const wf = (yaml: string): Workflow => {
  const { workflow, errors } = parseWorkflow(yaml, ".github/workflows/x.yml");
  if (!workflow) throw new Error(errors.map((e) => e.message).join("; "));
  return workflow;
};
const job = (perms?: string) => `    runs-on: ubuntu-latest\n${perms ? `    permissions: ${perms}\n` : ""}    steps: [{ run: echo }]\n`;
const expand = async (root: Workflow, lib?: Workflow) => {
  const load: Loader = async (_uses, from) => ({ workflow: lib!, source: from });
  return expandReusable(root, { repoId: null, sha: "abc" }, load);
};
const writes = (p: JobPermissions) => Object.entries(p).filter(([, v]) => v === "write").map(([k]) => k).sort();

describe("permissions: as written", () => {
  it("resolves read-all, write-all, {} and mappings like GitHub", () => {
    expect(resolvePermissions("read-all")).toEqual(READ_ALL);
    expect(resolvePermissions("write-all")["id-token"]).toBe("write");
    expect(resolvePermissions("write-all").models).toBe("read");
    expect(Object.values(resolvePermissions({})).every((v) => v === "none")).toBe(true);
    const p = resolvePermissions({ contents: "read", issues: "write", "id-token": "read" });
    expect(p).toMatchObject({ contents: "read", issues: "write", "id-token": "none", statuses: "none" });
    expect(PERMISSIVE_DEFAULT).toMatchObject({ contents: "write", issues: "write", packages: "write", "id-token": "none" });
    expect(roleForPermissions(resolvePermissions({ issues: "write" }))).toBe("write");
    expect(roleForPermissions(resolvePermissions({ "id-token": "write", contents: "read" }))).toBe("read");
  });
});

describe("effective permissions of a job", () => {
  it("uses the job's, else the workflow's, else the permissive default", async () => {
    const exp = await expand(
      wf(`on: push
permissions: { contents: read, issues: write }
jobs:
  inherits:
${job()}  own:
${job("{ statuses: write }")}`),
    );
    expect(writes(permissionsForJob(exp, "inherits"))).toEqual(["issues"]);
    expect(permissionsForJob(exp, "inherits").contents).toBe("read");
    // Job level replaces the workflow level entirely.
    expect(writes(permissionsForJob(exp, "own"))).toEqual(["statuses"]);
    expect(permissionsForJob(exp, "own").contents).toBe("none");
    const open = await expand(wf(`on: push\njobs:\n  a:\n${job()}`));
    expect(permissionsForJob(open, "a")).toEqual(PERMISSIVE_DEFAULT);
  });

  it("defaults to the repository's setting: read-only contents and packages, or everything", async () => {
    const open = await expand(wf(`on: push\njobs:\n  a:\n${job()}`));
    expect(permissionsForJob(open, "a", { repoDefault: "read" })).toEqual(RESTRICTED_DEFAULT);
    expect(writes(RESTRICTED_DEFAULT)).toEqual([]);
    expect(RESTRICTED_DEFAULT).toMatchObject({ contents: "read", packages: "read", issues: "none", "pull-requests": "none" });
    expect(permissionsForJob(open, "a", { repoDefault: "write" })).toEqual(PERMISSIVE_DEFAULT);
    // what a workflow asks for is not limited by the default
    const asks = await expand(wf(`on: push\npermissions: { issues: write }\njobs:\n  a:\n${job()}`));
    expect(writes(permissionsForJob(asks, "a", { repoDefault: "read" }))).toEqual(["issues"]);
  });

  it("never gives a fork's pull request write", async () => {
    const exp = await expand(wf(`on: pull_request\npermissions: write-all\njobs:\n  a:\n${job()}`));
    expect(writes(permissionsForJob(exp, "a", { untrusted: true }))).toEqual([]);
    expect(permissionsForJob(exp, "a", { untrusted: true }).contents).toBe("read");
  });

  it("caps a reusable workflow by the calling job", async () => {
    const lib = wf(`on: workflow_call
jobs:
  plain:
${job()}  greedy:
${job("write-all")}`);
    const exp = await expand(
      wf(`on: push
permissions: read-all
jobs:
  call:
    permissions: { contents: read, issues: write }
    uses: ./.github/workflows/lib.yml
`),
      lib,
    );
    expect(writes(permissionsForJob(exp, "call/plain"))).toEqual(["issues"]);
    expect(writes(permissionsForJob(exp, "call/greedy"))).toEqual(["issues"]);
    expect(permissionsForJob(exp, "call/greedy")["id-token"]).toBe("none");
  });
});

describe("what each request needs", () => {
  const p = resolvePermissions({ contents: "read", issues: "write" });
  const check = (method: string, path: string, min: "read" | "write" = "read") => denied(p, requestPermission(method, path, min));

  it("maps endpoints to permission scopes", () => {
    expect(check("POST", "/api/v3/repos/o/r/issues")).toBeNull();
    expect(check("POST", "/api/v3/repos/o/r/issues/3/comments")).toBeNull();
    expect(check("POST", "/api/v3/repos/o/r/labels")).toBeNull();
    expect(check("GET", "/api/v3/repos/o/r/contents/README.md")).toBeNull();
    expect(check("GET", "/api/v3/repos/o/r")).toBeNull();
    expect(check("PUT", "/api/v3/repos/o/r/contents/x")).toMatch(/contents: write/);
    expect(check("POST", "/api/v3/repos/o/r/statuses/abc")).toMatch(/statuses: write/);
    expect(check("POST", "/api/v3/repos/o/r/check-runs")).toMatch(/checks: write/);
    expect(check("POST", "/api/v3/repos/o/r/pulls")).toMatch(/pull-requests: write/);
    expect(check("PUT", "/api/v3/repos/o/r/pulls/1/merge")).toMatch(/contents: write/);
    expect(check("PUT", "/api/v3/repos/o/r/pulls/1/auto-merge")).toMatch(/contents: write/);
    expect(check("DELETE", "/api/v3/repos/o/r/pulls/1/auto-merge")).toMatch(/contents: write/);
    expect(check("GET", "/api/v3/repos/o/r/actions/runs")).toMatch(/actions: read/);
    expect(check("POST", "/api/v3/repos/o/r/releases")).toMatch(/contents: write/);
    expect(check("POST", "/api/uploads/repos/o/r/releases/1/assets")).toMatch(/contents: write/);
    expect(check("POST", "/api/v3/repos/o/r/commits/abc/comments")).toMatch(/contents: write/);
    expect(check("PATCH", "/api/v3/repos/o/r/comments/7")).toMatch(/contents: write/);
    expect(check("PATCH", "/api/v3/repos/o/r/issues/comments/7")).toBeNull();
    // git: fetches are POSTs that read; pushes need contents: write
    expect(check("POST", "/o/r.git/git-upload-pack")).toBeNull();
    expect(check("GET", "/o/r.git/info/refs", "write")).toMatch(/contents: write/);
    expect(check("POST", "/o/r.git/info/lfs/objects/batch")).toBeNull();
    // web pages: the code, a commit, the editor, and pull requests by their web path
    expect(check("GET", "/o/r")).toBeNull();
    expect(requestPermission("GET", "/o/r", "read")).toEqual({ scopes: ["contents"], access: "read" });
    expect(requestPermission("GET", "/o/r/commit/abc", "read")).toEqual({ scopes: ["contents"], access: "read" });
    expect(check("POST", "/o/r/edit/main/README.md")).toMatch(/contents: write/);
    expect(check("POST", "/o/r/new/main")).toMatch(/contents: write/);
    expect(check("POST", "/o/r/pull/1/merge")).toMatch(/pull-requests: write/);
    expect(requestPermission("GET", "/o/r/pull/1", "read")).toEqual({ scopes: ["pull-requests"], access: "read" });
  });

  it("lets anyone's reads of a public repository through, never its writes", () => {
    expect(readOnly(requestPermission("GET", "/api/v3/repos/o/r", "read"))).toBe(true);
    expect(readOnly(requestPermission("GET", "/api/v3/repos/o/r/contents/x", "read"))).toBe(true);
    expect(readOnly(requestPermission("POST", "/o/r.git/git-upload-pack", "read"))).toBe(true);
    expect(readOnly(requestPermission("PUT", "/api/v3/repos/o/r/contents/x", "write"))).toBe(false);
    expect(readOnly(requestPermission("GET", "/o/r.git/info/refs", "write"))).toBe(false);
    expect(readOnly(requestPermission("GET", "/api/v3/repos/o/r/actions/secrets", "read"))).toBe(false);
    // contents: none still blocks the code (of a private repository; loadRepo lets public reads through)
    const none = resolvePermissions({ contents: "none" });
    expect(denied(none, requestPermission("GET", "/api/v3/repos/o/r/contents/x", "read"))).toMatch(/contents: read/);
  });

  it("keeps repository administration away from job tokens", () => {
    const all = resolvePermissions("write-all");
    const admin = (method: string, path: string) => denied(all, requestPermission(method, path, "read"));
    expect(admin("PATCH", "/api/v3/repos/o/r")).toMatch(/not available|cannot/);
    expect(admin("PUT", "/api/v3/repos/o/r/actions/secrets/X")).toMatch(/not available/);
    expect(admin("GET", "/api/v3/repos/o/r/actions/secrets")).toMatch(/not available/);
    expect(admin("PUT", "/api/v3/repos/o/r/branches/main/protection")).toMatch(/not available/);
    expect(admin("POST", "/api/v3/repos/o/r/hooks")).toMatch(/not available/);
    expect(admin("POST", "/api/v3/repos/o/r/actions/runners/claim")).toMatch(/not available/);
    expect(admin("POST", "/mcp")).toMatch(/not available/);
    // a file or branch that happens to be called "settings" or "secrets" is still just contents
    expect(admin("GET", "/api/v3/repos/o/r/contents/settings/secrets.md")).toBeNull();
  });
});
