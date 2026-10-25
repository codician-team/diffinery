// End-to-end container registry: a real `wrangler dev` Worker, raw OCI distribution API
// calls, the docker CLI (when Docker is available) and workflows whose GITHUB_TOKEN
// pushes and pulls, run by the real runner agent.
//
//   pnpm --filter @diffinery/runner build && pnpm --filter @diffinery/app e2e
//
// Covers: monolithic, chunked and streamed blob uploads, digest and range checks,
// manifests by tag and digest, indexes, referrers, tag listing, cross-repository mounts,
// token scopes, the packages REST API, the job token's `packages` permission, linking
// packages to repositories, and docker login/push/pull.
import "./fresh-connections.mjs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENT = resolve(APP, "../../containers/runner/dist/agent.mjs");
const work = mkdtempSync(join(tmpdir(), "diffinery-registry-"));
let base;
let host;
let dev;
let devLog = "";
let token;
let owner;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  assert.fail(`timed out waiting for ${what}\n--- wrangler log tail ---\n${devLog.slice(-4000)}`);
}

const sha = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const hex = (s) => createHash("sha256").update(s).digest("hex");
/** Tokens of the seeded "crew" organization's owner and members, and of an outside collaborator. */
const CREW = Object.fromEntries(["olga", "mira", "nils", "otto"].map((n) => [n, `dfy_${n}_${randomBytes(12).toString("hex")}`]));
const auth = (tok = token) => ({ authorization: `Basic ${Buffer.from(`anyone:${tok}`).toString("base64")}` });

/** A registry call: path is below /v2/. */
async function reg(method, path, { body, headers = {}, tok } = {}) {
  const res = await fetch(`${base}/v2/${path}`, { method, body, headers: { ...auth(tok), ...headers }, redirect: "manual", duplex: body instanceof ReadableStream ? "half" : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = buf.length ? JSON.parse(buf.toString("utf8")) : null;
  } catch {}
  return { status: res.status, headers: res.headers, body: buf, json };
}

async function api(method, path, body, tok = token) {
  const res = await fetch(`${base}/api/v3${path}`, { method, headers: { ...(tok === null ? {} : { authorization: `Bearer ${tok}` }), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/**
 * Claim a waiting self-hosted job as a registered runner offering `labels`, the way `diffinery runner`
 * does (personal tokens can't claim jobs): one runner per repository and set of labels.
 */
const e2eRunners = new Map();
async function runnerClaim(repoPath, labels = ["linux"]) {
  const key = `${repoPath} ${labels.join(",")}`;
  if (!e2eRunners.has(key)) {
    const reg = await api("POST", `${repoPath}/actions/runners/registration-token`);
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const runner = await api("POST", `${repoPath}/actions/runners/register`, { registration_token: reg.json.token, name: `e2e-runner-${e2eRunners.size + 1}`, labels });
    assert.equal(runner.status, 201, JSON.stringify(runner.json));
    e2eRunners.set(key, runner.json.token);
  }
  const r = await api("POST", `${repoPath}/actions/runners/claim`, {}, e2eRunners.get(key));
  // A repository deleted and created again under the same name needs a new runner.
  if (r.status !== 401) return r;
  e2eRunners.delete(key);
  return runnerClaim(repoPath, labels);
}
async function ok(method, path, body, tok) {
  const r = await api(method, path, body, tok);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** Uploads a blob in one POST. */
async function pushBlob(name, bytes, tok) {
  const r = await reg("POST", `${name}/blobs/uploads/?digest=${sha(bytes)}`, { body: bytes, headers: { "content-type": "application/octet-stream" }, tok });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { digest: sha(bytes), size: bytes.length };
}

/** Pushes a small single-layer image and returns its manifest digest. */
async function pushImage(name, tag, { layer = randomBytes(2048), labels = {}, tok } = {}) {
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Labels: labels }, rootfs: { type: "layers", diff_ids: [sha(layer)] } }));
  const c = await pushBlob(name, config, tok);
  const l = await pushBlob(name, layer, tok);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", ...c },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", ...l }],
    }),
  );
  const r = await reg("PUT", `${name}/manifests/${tag}`, { body: manifest, headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" }, tok });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.headers.get("docker-content-digest"), sha(manifest));
  return { digest: sha(manifest), manifest, layer, size: manifest.length };
}

before(async () => {
  assert.ok(existsSync(AGENT), `build the runner first: pnpm --filter @diffinery/runner build (missing ${AGENT})`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  host = `127.0.0.1:${port}`;
  const persist = join(work, "state");
  migratedState(APP, persist);
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  const seed = [
    `INSERT INTO accounts (id, login, kind, name, status, created_at) VALUES ('o-crew', 'crew', 'org', 'crew', 'active', '${at}')`,
    ...Object.entries(CREW).flatMap(([n, t]) => [
      `INSERT INTO accounts (id, login, kind, name, status, created_at) VALUES ('u-${n}', '${n}', 'user', '${n}', 'active', '${at}')`,
      `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('t-${n}', 'u-${n}', 'e2e', '${hex(t)}', '${t.slice(0, 10)}', '["admin"]', '${later}', '${at}')`,
    ]),
    `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('o-crew', 'u-olga', 'owner', '${at}'), ('o-crew', 'u-mira', 'member', '${at}'), ('o-crew', 'u-nils', 'member', '${at}')`,
  ];
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command", seed.join("; ")], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  dev = spawn("pnpm", ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", `MASTER_KEY:${randomBytes(32).toString("base64")}`, "--show-interactive-dev-session=false"], {
    cwd: APP,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));
  await until("wrangler dev", async () => {
    try {
      return (await fetch(`${base}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 120_000);
  const res = await fetch(`${base}/api/v3/diffinery/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "registry-e2e", scopes: ["admin"] }) });
  assert.equal(res.status, 201, await res.clone().text());
  token = (await res.json()).token;
  owner = (await ok("GET", "/user")).login;
});

after(() => {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  }
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

test("registry: the OCI distribution API", async () => {
  const v2 = await reg("GET", "");
  assert.equal(v2.status, 200);
  assert.equal(v2.headers.get("docker-distribution-api-version"), "registry/2.0");
  // Unknown tokens are refused with a Basic challenge so `docker login` reports it.
  const bad = await fetch(`${base}/v2/`, { headers: auth("dfy_nope") });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate") ?? "", /^Basic realm=/);

  const name = `${owner}/tools/api`;
  assert.equal((await reg("GET", `${owner}/bad..name/blobs/${sha("x")}`)).json.errors[0].code, "NAME_INVALID");
  assert.equal((await reg("GET", `${name}/manifests/latest`)).status, 404);

  // Monolithic upload, then HEAD and ranged GET.
  const blob = randomBytes(5000);
  const { digest } = await pushBlob(name, blob);
  const head = await reg("HEAD", `${name}/blobs/${digest}`);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "5000");
  assert.equal(head.headers.get("docker-content-digest"), digest);
  const part = await reg("GET", `${name}/blobs/${digest}`, { headers: { range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.deepEqual(part.body, blob.subarray(100, 200));
  assert.equal(part.headers.get("content-range"), "bytes 100-199/5000");

  // Chunked upload: three PATCHes with Content-Range, then PUT with the last bytes.
  const big = randomBytes(23 * 1024 * 1024 + 123);
  const start = await reg("POST", `${name}/blobs/uploads/`);
  assert.equal(start.status, 202);
  let loc = start.headers.get("location");
  assert.match(loc, /\/blobs\/uploads\/[0-9a-f]{32}$/);
  const cuts = [0, 9 * 1024 * 1024, 11 * 1024 * 1024, 22 * 1024 * 1024, big.length];
  for (let i = 0; i < 3; i++) {
    const chunk = big.subarray(cuts[i], cuts[i + 1]);
    const r = await fetch(`${base}${loc}`, { method: "PATCH", body: chunk, headers: { ...auth(), "content-type": "application/octet-stream", "content-range": `${cuts[i]}-${cuts[i + 1] - 1}` } });
    assert.equal(r.status, 202, await r.text());
    assert.equal(r.headers.get("range"), `0-${cuts[i + 1] - 1}`);
    loc = r.headers.get("location");
  }
  // A chunk that doesn't start where the upload is gets 416 and the current range.
  const wrong = await fetch(`${base}${loc}`, { method: "PATCH", body: Buffer.from("zz"), headers: { ...auth(), "content-range": "5-6" } });
  assert.equal(wrong.status, 416);
  assert.equal(wrong.headers.get("range"), `0-${cuts[3] - 1}`);
  const status = await fetch(`${base}${loc}`, { headers: auth() });
  assert.equal(status.status, 204);
  assert.equal(status.headers.get("diffinery-upload-size"), String(cuts[3]));
  const done = await fetch(`${base}${loc}?digest=${sha(big)}`, { method: "PUT", body: big.subarray(cuts[3]), headers: { ...auth(), "content-type": "application/octet-stream", "content-range": `${cuts[3]}-${big.length - 1}` } });
  assert.equal(done.status, 201, await done.text());
  const back = await reg("GET", `${name}/blobs/${sha(big)}`);
  assert.equal(back.body.length, big.length);
  assert.ok(back.body.equals(big), "the chunked blob comes back intact");

  // A streamed single PATCH (how docker sends layers), larger than one R2 part.
  const streamed = randomBytes(12 * 1024 * 1024 + 7);
  const s2 = await reg("POST", `${name}/blobs/uploads/`);
  const pieces = [streamed.subarray(0, 1_000_000), streamed.subarray(1_000_000)];
  const stream = new ReadableStream({ pull(ctl) { const p = pieces.shift(); p ? ctl.enqueue(p) : ctl.close(); } });
  const p2 = await fetch(`${base}${s2.headers.get("location")}`, { method: "PATCH", body: stream, duplex: "half", headers: auth() });
  assert.equal(p2.status, 202);
  assert.equal((await fetch(`${base}${p2.headers.get("location")}?digest=${sha(streamed)}`, { method: "PUT", headers: auth() })).status, 201);
  assert.ok((await reg("GET", `${name}/blobs/${sha(streamed)}`)).body.equals(streamed));

  // A wrong digest is refused and the upload is gone.
  const s3 = await reg("POST", `${name}/blobs/uploads/`);
  const badPut = await fetch(`${base}${s3.headers.get("location")}?digest=${sha("other")}`, { method: "PUT", body: Buffer.from("content"), headers: auth() });
  assert.equal(badPut.status, 400);
  assert.equal((await badPut.json()).errors[0].code, "DIGEST_INVALID");
  assert.equal((await fetch(`${base}${s3.headers.get("location")}`, { headers: auth() })).status, 404);

  // Manifests must only use blobs the package has.
  const orphan = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha("missing"), size: 7 }, layers: [] }));
  const refused = await reg("PUT", `${name}/manifests/broken`, { body: orphan, headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.errors[0].code, "MANIFEST_BLOB_UNKNOWN");

  // Images by tag and digest, with an index on top.
  const amd = await pushImage(name, "amd64");
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: amd.digest, size: amd.size, platform: { os: "linux", architecture: "amd64" } }],
    }),
  );
  assert.equal((await reg("PUT", `${name}/manifests/v1`, { body: index, headers: { "content-type": "application/vnd.oci.image.index.v1+json" } })).status, 201);
  for (const ref of ["v1", sha(index)]) {
    const m = await reg("GET", `${name}/manifests/${ref}`, { headers: { accept: "application/vnd.oci.image.index.v1+json" } });
    assert.equal(m.status, 200);
    assert.equal(m.headers.get("content-type"), "application/vnd.oci.image.index.v1+json");
    assert.equal(m.headers.get("docker-content-digest"), sha(index));
    assert.ok(m.body.equals(index));
  }
  assert.equal((await reg("HEAD", `${name}/manifests/amd64`)).headers.get("docker-content-digest"), amd.digest);
  // Pushing by digest checks the digest.
  assert.equal((await reg("PUT", `${name}/manifests/${sha("nope")}`, { body: index, headers: { "content-type": "application/vnd.oci.image.index.v1+json" } })).json.errors[0].code, "DIGEST_INVALID");

  // Tags, paginated.
  await pushImage(name, "v2");
  assert.deepEqual((await reg("GET", `${name}/tags/list`)).json, { name, tags: ["amd64", "v1", "v2"] });
  const page1 = await reg("GET", `${name}/tags/list?n=2`);
  assert.deepEqual(page1.json.tags, ["amd64", "v1"]);
  assert.match(page1.headers.get("link"), /last=v1>; rel="next"/);
  assert.deepEqual((await reg("GET", `${name}/tags/list?n=2&last=v1`)).json.tags, ["v2"]);

  // Referrers: an artifact whose subject is the amd64 image.
  const empty = await pushBlob(name, Buffer.from("{}"));
  const sig = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: "application/vnd.example.signature",
      config: { mediaType: "application/vnd.oci.empty.v1+json", ...empty },
      layers: [],
      subject: { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: amd.digest, size: amd.size },
      annotations: { "org.example.signed-by": "e2e" },
    }),
  );
  const sigPut = await reg("PUT", `${name}/manifests/${sha(sig)}`, { body: sig, headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } });
  assert.equal(sigPut.status, 201);
  assert.equal(sigPut.headers.get("oci-subject"), amd.digest);
  const refs = await reg("GET", `${name}/referrers/${amd.digest}`);
  assert.equal(refs.json.manifests.length, 1);
  assert.equal(refs.json.manifests[0].artifactType, "application/vnd.example.signature");
  assert.equal((await reg("GET", `${name}/referrers/${amd.digest}?artifactType=other`)).json.manifests.length, 0);

  // Cross-repository mount, and a mount that falls back to a normal upload.
  const other = `${owner}/tools/other`;
  const mounted = await reg("POST", `${other}/blobs/uploads/?mount=${digest}&from=${name}`);
  assert.equal(mounted.status, 201);
  assert.equal((await reg("HEAD", `${other}/blobs/${digest}`)).status, 200);
  assert.equal((await reg("POST", `${other}/blobs/uploads/?mount=${sha("never")}&from=${name}`)).status, 202);
  // The blob isn't readable through a package that doesn't hold it.
  assert.equal((await reg("HEAD", `${other}/blobs/${sha(big)}`)).status, 404);

  // Deleting a tag keeps the manifest; deleting the manifest removes it and its tags.
  assert.equal((await reg("DELETE", `${name}/manifests/v2`)).status, 202);
  assert.equal((await reg("GET", `${name}/manifests/v2`)).status, 404);
  assert.equal((await reg("DELETE", `${name}/manifests/${amd.digest}`)).status, 202);
  assert.equal((await reg("GET", `${name}/manifests/amd64`)).status, 404);

  const catalog = await reg("GET", "_catalog");
  assert.ok(catalog.json.repositories.includes(name) && catalog.json.repositories.includes(other));
});

test("registry: token scopes, the packages API and repository links", async () => {
  const read = (await ok("POST", "/diffinery/tokens", { name: "pull only", scopes: ["read"] }, null)).token;
  const name = `${owner}/scoped`;
  const img = await pushImage(name, "latest");
  assert.equal((await reg("GET", `${name}/manifests/latest`, { tok: read })).status, 200);
  const denied = await reg("POST", `${name}/blobs/uploads/`, { tok: read });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.errors[0].code, "DENIED");
  assert.equal((await reg("DELETE", `${name}/manifests/latest`, { tok: read })).status, 403);

  // GitHub-shaped packages API.
  const list = await ok("GET", "/user/packages?package_type=container");
  const pkg = list.find((p) => p.name === "scoped");
  assert.ok(pkg, JSON.stringify(list));
  assert.equal(pkg.visibility, "private");
  assert.equal(pkg.image, `${host}/${owner}/scoped`);
  const versions = await ok("GET", "/user/packages/container/scoped/versions");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].name, img.digest);
  assert.deepEqual(versions[0].metadata.container.tags, ["latest"]);
  assert.equal((await ok("PATCH", "/user/packages/container/scoped", { visibility: "public" })).visibility, "public");
  assert.equal((await api("PATCH", "/user/packages/container/scoped", { visibility: "secret" })).status, 422);
  assert.equal((await api("DELETE", `/user/packages/container/scoped/versions/${versions[0].id}`)).status, 204);
  assert.equal((await reg("GET", `${name}/manifests/latest`)).status, 404);
  assert.equal((await api("DELETE", "/user/packages/container/scoped")).status, 204);
  assert.equal((await api("GET", "/user/packages/container/scoped")).status, 404);

  // diffinery.com/<owner>/<repo>/... is linked to the repository when the pusher can write to it.
  await ok("POST", "/user/repos", { name: "linked" });
  await pushImage(`${owner}/linked/api`, "v1");
  assert.equal((await ok("GET", "/user/packages/container/linked%2Fapi")).repository.full_name, `${owner}/linked`);
  const repoPkgs = await ok("GET", `/repos/${owner}/linked/packages`);
  assert.deepEqual(repoPkgs.map((p) => p.name), ["linked/api"]);
  // ...and so is an image whose org.opencontainers.image.source label names one.
  await ok("POST", "/user/repos", { name: "labelled" });
  await pushImage(`${owner}/some-image`, "v1", { labels: { "org.opencontainers.image.source": `${base}/${owner}/labelled` } });
  assert.equal((await ok("GET", "/user/packages/container/some-image")).repository.full_name, `${owner}/labelled`);
  // The web pages render.
  for (const path of [`/${owner}/-/packages`, `/${owner}/-/packages/container/linked/api`, `/${owner}/linked/packages`]) {
    const page = await fetch(`${base}${path}`);
    assert.equal(page.status, 200, path);
    assert.match(await page.text(), /linked\/api|some-image/);
  }
});

test("registry: organization packages follow ghcr.io's permissions", async () => {
  // A member creates a package and administers it, since it isn't linked to a repository.
  const img = await pushImage("crew/mira-tool", "v1", { tok: CREW.mira });
  assert.equal((await ok("PATCH", "/orgs/crew/packages/container/mira-tool", { visibility: "private" }, CREW.mira)).visibility, "private");
  // Another member pulls it but can't push to it, delete it or change it.
  assert.equal((await reg("GET", "crew/mira-tool/manifests/v1", { tok: CREW.nils })).status, 200);
  const push = await reg("POST", "crew/mira-tool/blobs/uploads/", { tok: CREW.nils });
  assert.equal(push.status, 403, JSON.stringify(push.json));
  assert.equal((await reg("DELETE", `crew/mira-tool/manifests/${img.digest}`, { tok: CREW.nils })).status, 403);
  assert.equal((await api("PATCH", "/orgs/crew/packages/container/mira-tool", { visibility: "public" }, CREW.nils)).status, 403);
  assert.equal((await api("DELETE", "/orgs/crew/packages/container/mira-tool", undefined, CREW.nils)).status, 403);
  // Members still create their own packages, and the organization's owner administers them all.
  await pushImage("crew/nils-tool", "v1", { tok: CREW.nils });
  await pushImage("crew/mira-tool", "v2", { tok: CREW.olga });
  assert.deepEqual((await reg("GET", "crew/mira-tool/tags/list", { tok: CREW.mira })).json.tags, ["v1", "v2"]);

  // A linked package follows its repository: an outside collaborator with read pulls, with write pushes.
  await ok("POST", "/orgs/crew/repos", { name: "app" }, CREW.olga);
  await pushImage("crew/app", "v1", { tok: CREW.olga });
  assert.equal((await ok("GET", "/orgs/crew/packages/container/app", undefined, CREW.olga)).repository.full_name, "crew/app");
  assert.equal((await reg("GET", "crew/app/manifests/v1", { tok: CREW.otto })).status, 404);
  // An outside collaborator is invited, and has access once he accepts (a member like mira is added at once).
  const invitation = await ok("PUT", "/repos/crew/app/collaborators/otto", { permission: "read" }, CREW.olga);
  assert.equal((await reg("GET", "crew/app/manifests/v1", { tok: CREW.otto })).status, 404);
  await ok("PATCH", `/user/repository_invitations/${invitation.id}`, undefined, CREW.otto);
  assert.equal((await reg("GET", "crew/app/manifests/v1", { tok: CREW.otto })).status, 200);
  assert.equal((await reg("POST", "crew/app/blobs/uploads/", { tok: CREW.otto })).status, 403);
  await ok("PUT", "/repos/crew/app/collaborators/otto", { permission: "write" }, CREW.olga);
  await pushImage("crew/app", "v2", { tok: CREW.otto });
  // ...but not to the members' unlinked packages, which he can't see.
  assert.equal((await reg("GET", "crew/mira-tool/manifests/v1", { tok: CREW.otto })).status, 404);
  assert.deepEqual((await ok("GET", "/orgs/crew/packages", undefined, CREW.otto)).map((p) => p.name), ["app"]);

  // The organization's packages pages keep its header and tab bar, with Packages selected.
  for (const path of ["/crew/-/packages", "/crew/-/packages/container/mira-tool"]) {
    const page = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${CREW.mira}` } });
    const html = await page.text();
    assert.equal(page.status, 200, path);
    assert.match(html, /Organization · crew · you are a member/, path);
    assert.match(html, /<a href="\/crew\/-\/packages" class="on">/, path);
    assert.match(html, /href="\/crew\?tab=people"/, path);
  }
});

test("registry: an organization's package linked to a private repository follows that repository's access", async () => {
  // With the base permission at none, members only reach the repositories they're given, and so their images.
  await ok("PATCH", "/orgs/crew", { default_repository_permission: "none" }, CREW.olga);
  await ok("POST", "/orgs/crew/repos", { name: "secret", private: true }, CREW.olga);
  await pushImage("crew/secret", "v1", { tok: CREW.olga });
  assert.equal((await ok("GET", "/orgs/crew/packages/container/secret", undefined, CREW.olga)).repository.full_name, "crew/secret");
  assert.equal((await reg("GET", "crew/secret/manifests/v1", { tok: CREW.mira })).status, 404);
  assert.ok(!(await reg("GET", "_catalog", { tok: CREW.mira })).json.repositories.includes("crew/secret"));
  assert.ok(!(await ok("GET", "/orgs/crew/packages", undefined, CREW.mira)).some((p) => p.name === "secret"));
  // Unlinked packages are still the members' to pull, and a grant on the repository opens its image.
  assert.equal((await reg("GET", "crew/nils-tool/manifests/v1", { tok: CREW.mira })).status, 200);
  await ok("PUT", "/repos/crew/secret/collaborators/mira", { permission: "read" }, CREW.olga);
  assert.equal((await reg("GET", "crew/secret/manifests/v1", { tok: CREW.mira })).status, 200);
  assert.ok((await reg("GET", "_catalog", { tok: CREW.mira })).json.repositories.includes("crew/secret"));
  await ok("PATCH", "/orgs/crew", { default_repository_permission: "read" }, CREW.olga);
});

function git(cwd, args) {
  const a = Buffer.from(`x-token:${token}`).toString("base64");
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: Basic ${a}`, "-c", "protocol.version=2", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@example.com" },
  });
}

function spawnAsync(cmd, args, env, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => {
      clearTimeout(t);
      done({ status, out });
    });
  });
}

async function runOneJob(repo) {
  const claim = await until("a job to claim", async () => {
    const r = await runnerClaim(`/repos/${owner}/${repo}`, ["linux"]);
    return r.status === 200 ? r.json : null;
  });
  const r = await spawnAsync(process.execPath, [AGENT], { DIFFINERY_API_URL: claim.api_url, DIFFINERY_JOB_ID: claim.job_id, DIFFINERY_JOB_TOKEN: claim.token, DIFFINERY_WORK_ROOT: join(work, `job-${claim.job_id}`) }, 180_000);
  const log = await (await fetch(`${base}/api/v3/repos/${owner}/${repo}/actions/jobs/${claim.job_id}/logs`, { headers: { authorization: `Bearer ${token}` } })).text();
  return { name: claim.name, status: r.status, out: r.out, log };
}

test("registry: a workflow's GITHUB_TOKEN follows the packages permission", async () => {
  await ok("POST", "/user/repos", { name: "shipyard" });
  const src = join(work, "shipyard");
  mkdirSync(join(src, ".github/workflows"), { recursive: true });
  // Push a tiny image with curl, the way any registry client would.
  writeFileSync(
    join(src, "push.sh"),
    [
      'R="$GITHUB_SERVER_URL/v2/$GITHUB_REPOSITORY_OWNER/shipyard"',
      `printf '%s' '{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}' > cfg.json`,
      `d="sha256:$(sha256sum cfg.json | cut -d' ' -f1)"`,
      'curl -sS -o /dev/null -w "blob=%{http_code}\\n" -u "x:$GITHUB_TOKEN" -X POST "$R/blobs/uploads/?digest=$d" --data-binary @cfg.json',
      `printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"%s","size":%s},"layers":[]}' "$d" "$(stat -c %s cfg.json)" > m.json`,
      'curl -sS -o /dev/null -w "$1=%{http_code}\\n" -u "x:$GITHUB_TOKEN" -X PUT "$R/manifests/$1" -H "content-type: application/vnd.oci.image.manifest.v1+json" --data-binary @m.json',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(src, ".github/workflows/images.yml"),
    `on: push
env:
  GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
jobs:
  publish:
    runs-on: [self-hosted, linux]
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - run: bash push.sh ci
      - run: |
          curl -sS -o /dev/null -w "public=%{http_code}\\n" -X PATCH "$GITHUB_SERVER_URL/api/v3/users/$GITHUB_REPOSITORY_OWNER/packages/container/shipyard" -H "authorization: Bearer $GITHUB_TOKEN" -H "content-type: application/json" -d '{"visibility":"public"}'
          curl -sS -o /dev/null -w "gone=%{http_code}\\n" -X DELETE "$GITHUB_SERVER_URL/api/v3/users/$GITHUB_REPOSITORY_OWNER/packages/container/shipyard" -H "authorization: Bearer $GITHUB_TOKEN"
  reader:
    needs: publish
    runs-on: [self-hosted, linux]
    permissions:
      contents: read
      packages: read
    steps:
      - uses: actions/checkout@v4
      - run: |
          curl -sS -o /dev/null -w "pull=%{http_code}\\n" -u "x:$GITHUB_TOKEN" "$GITHUB_SERVER_URL/v2/$GITHUB_REPOSITORY_OWNER/shipyard/manifests/ci" -H "accept: application/vnd.oci.image.manifest.v1+json"
          bash push.sh nope
  outsider:
    needs: reader
    runs-on: [self-hosted, linux]
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - run: bash push.sh nope
`,
  );
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "images"]);
  git(src, ["remote", "add", "origin", `${base}/${owner}/shipyard.git`]);
  git(src, ["push", "-q", "origin", "main"]);

  const publish = await runOneJob("shipyard");
  assert.equal(publish.name, "publish");
  assert.match(publish.log, /blob=201/, publish.log);
  assert.match(publish.log, /ci=201/, publish.log);
  // Created by the workflow, so linked to its repository.
  const pkg = await ok("GET", "/user/packages/container/shipyard");
  assert.equal(pkg.repository.full_name, `${owner}/shipyard`);
  assert.equal((await ok("GET", "/user/packages/container/shipyard/versions"))[0].pushed_by, "diffinery-actions[bot]");
  // It can't make the package public or delete it: that takes someone with admin access.
  assert.match(publish.log, /public=403/, publish.log);
  assert.match(publish.log, /gone=403/, publish.log);
  assert.equal((await ok("GET", "/user/packages/container/shipyard")).visibility, "private");

  const reader = await runOneJob("shipyard");
  assert.equal(reader.name, "reader");
  assert.match(reader.log, /pull=200/, reader.log);
  assert.match(reader.log, /blob=403/, reader.log);
  assert.match(reader.log, /nope=403/, reader.log);

  const outsider = await runOneJob("shipyard");
  assert.equal(outsider.name, "outsider");
  assert.match(outsider.log, /blob=404/, outsider.log);
  assert.deepEqual((await reg("GET", `${owner}/shipyard/tags/list`)).json.tags, ["ci"]);
});

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;

test("registry: docker login, push and pull", { skip: !hasDocker && "Docker is not available" }, async () => {
  const dir = join(work, "image");
  mkdirSync(dir, { recursive: true });
  const payload = randomBytes(6 * 1024 * 1024);
  writeFileSync(join(dir, "payload.bin"), payload);
  writeFileSync(join(dir, "Dockerfile"), 'FROM scratch\nCOPY payload.bin /payload.bin\nLABEL org.opencontainers.image.description="e2e image"\n');
  const image = `${host}/${owner}/dockerized:v1`;
  const config = join(work, "docker-config");
  mkdirSync(config, { recursive: true });
  // Run docker without blocking the event loop: undici would keep sockets the server already closed.
  const docker = async (args, input) => {
    const r = await new Promise((done) => {
      const child = spawn("docker", ["--config", config, ...args], { cwd: dir });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (status) => done({ status, out, err }));
      child.stdin.end(input ?? "");
    });
    assert.equal(r.status, 0, `docker ${args.join(" ")}: ${r.err}${r.out}`);
    return r.out;
  };
  assert.match(await docker(["login", host, "-u", "e2e", "--password-stdin"], token), /Login Succeeded/);
  await docker(["build", "-q", "-t", image, "."]);
  await docker(["push", image]);
  await docker(["rmi", image]);
  await docker(["pull", "-q", image]);
  const id = (await docker(["create", image, "true"])).trim();
  try {
    await docker(["cp", `${id}:/payload.bin`, join(work, "payload.out")]);
  } finally {
    await docker(["rm", id]);
    await docker(["rmi", image]);
  }
  assert.ok(readFileSync(join(work, "payload.out")).equals(payload), "the pulled image holds the same bytes");
  const pkg = await ok("GET", "/user/packages/container/dockerized");
  assert.equal(pkg.description, "e2e image");
});
