// A stand-in for GitHub (or GitHub Enterprise) for the import end-to-end test:
// the REST API under /api/v3 with Link pagination, real Git over smart HTTP
// (`git http-backend`) and a Git LFS batch endpoint. Everything requires the
// token it was created with, like a private repository would.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

/**
 * @param {object} o
 * @param {string} o.root     directory holding <owner>/<name>.git bare repositories
 * @param {string} o.token    the token every request must carry
 * @param {Record<string, unknown>} o.routes  "GET /repos/o/r/labels" → JSON (arrays are paginated)
 * @param {Map<string, Buffer>} o.lfs  LFS objects by oid
 * @param {string[]} [o.anonymous]  repositories ("owner/name") anyone may read without a token, like public
 *   ones on GitHub; their admin endpoints (Actions variables and secrets, environments, branch protection)
 *   still answer 401 "Requires authentication" without one
 */
export function fakeGitHub({ root, token, routes, lfs, anonymous = [] }) {
  const requests = [];
  let base;
  const authorized = (req) => {
    const h = req.headers.authorization ?? "";
    if (h === `Bearer ${token}` || h === `token ${token}`) return true;
    const basic = /^Basic (.+)$/.exec(h);
    return !!basic && Buffer.from(basic[1], "base64").toString().split(":").slice(1).join(":") === token;
  };
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, path: url.pathname, query: url.search });
    // Public, unauthenticated GitHub endpoints: a user profile and their public gists (used by gist-proof account linking).
    const publicGet = req.method === "GET" && /^\/api\/v3\/(users\/[^/]+(?:\/gists)?|gists\/[^/]+)$/.test(url.pathname);
    const repoOf = /^\/(?:api\/v3\/repos\/)?([^/]+\/[^/]+?)(?:\.git)?(?:\/|$)/.exec(url.pathname)?.[1];
    const anonymousRead = !req.headers.authorization && anonymous.includes(repoOf) && (req.method === "GET" || /\/git-upload-pack$/.test(url.pathname));
    if (anonymousRead && /\/(actions|environments)(\/|$)|\/protection$/.test(url.pathname)) return json(res, 401, { message: "Requires authentication" });
    if (!publicGet && !anonymousRead && !authorized(req)) return json(res, 401, { message: "Bad credentials" }, { "www-authenticate": 'Basic realm="GitHub"' });

    // ---------------------------------------------------------------- Git LFS
    const lfsBatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/info\/lfs\/objects\/batch$/.exec(url.pathname);
    if (lfsBatch && req.method === "POST") {
      const q = JSON.parse(body.toString());
      const objects = q.objects.map((o) =>
        lfs.has(o.oid)
          ? { oid: o.oid, size: o.size, authenticated: true, actions: { download: { href: `${base}/lfs-objects/${o.oid}`, header: { Authorization: req.headers.authorization } } } }
          : { oid: o.oid, size: o.size, error: { code: 404, message: "not found" } },
      );
      res.writeHead(200, { "content-type": "application/vnd.git-lfs+json" });
      return res.end(JSON.stringify({ transfer: "basic", objects }));
    }
    const lfsGet = /^\/lfs-objects\/([0-9a-f]{64})$/.exec(url.pathname);
    if (lfsGet) {
      const data = lfs.get(lfsGet[1]);
      if (!data) return json(res, 404, { message: "Not Found" });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
      return res.end(data);
    }

    // ---------------------------------------------------------------- Git smart HTTP
    if (/^\/[^/]+\/[^/]+\.git\/(info\/refs|git-upload-pack)$/.test(url.pathname)) {
      return cgi(req, res, url, body, root);
    }

    // ---------------------------------------------------------------- REST
    if (!url.pathname.startsWith("/api/v3/")) return json(res, 404, { message: "Not Found" });
    const path = url.pathname.slice("/api/v3".length);
    const key = `${req.method} ${path}`;
    const query = Object.fromEntries(url.searchParams);
    const route = routes[key];
    if (route === undefined) return json(res, 404, { message: "Not Found" });
    const value = typeof route === "function" ? route(query) : route;
    // Lists are paginated two items at a time to exercise Link headers.
    const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray(value.variables ?? value.secrets) ? (value.variables ?? value.secrets) : null;
    if (!list) return json(res, 200, value);
    const per = Math.min(Number(query.per_page ?? 30), 2);
    const page = Number(query.page ?? 1);
    const items = list.slice((page - 1) * per, page * per);
    const headers = {};
    if (page * per < list.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next}>; rel="next"`;
    }
    const out = Array.isArray(value) ? items : { total_count: list.length, [value.variables ? "variables" : "secrets"]: items };
    return json(res, 200, out, headers);
  });
  return {
    requests,
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      server.unref();
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

function cgi(req, res, url, body, root) {
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname,
    REQUEST_METHOD: req.method,
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    CONTENT_LENGTH: String(body.length),
    HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
    GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
    REMOTE_USER: "importer",
    REMOTE_ADDR: "127.0.0.1",
  };
  const child = spawn("git", ["http-backend"], { env });
  const out = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", () => {});
  // git http-backend may close stdin before reading the whole body (e.g. GET info/refs); ignore the broken pipe.
  child.stdin.on("error", () => {});
  child.on("error", () => {});
  child.stdin.end(body);
  child.on("close", () => {
    if (res.writableEnded) return;
    const buf = Buffer.concat(out);
    const sep = buf.indexOf("\r\n\r\n");
    const head = buf.subarray(0, sep).toString();
    const headers = {};
    let status = 200;
    for (const line of head.split("\r\n")) {
      const i = line.indexOf(":");
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(buf.subarray(sep + 4));
  });
}

/** An LFS pointer file and the object it points to. */
export function lfsObject(content) {
  const data = Buffer.from(content);
  const oid = createHash("sha256").update(data).digest("hex");
  return { oid, data, pointer: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${data.length}\n` };
}
