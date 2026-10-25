import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bwrapArgs, JAIL_HOSTS, jailAllows, MODEL_URL, parseJailArgs, REGISTRY_HOSTS, SHARED_ENV, startJailProxy, startModelProxy } from "../src/jail.js";
import { tmp } from "./helpers.js";

describe("a terminal task's jail", () => {
  it("takes only task directories beside the checkout", () => {
    const a = parseJailArgs(["--root", "/w", "agent", "--dir", "../task-1-1", "--out", "../task-1-1.out", "--cli", "claude-code", "--", "claude", "-p", "x"], "/w/repo");
    expect(a).toEqual({ mode: "agent", root: "/w", dir: "/w/task-1-1", out: "/w/task-1-1.out", cli: "claude-code", egress: "cli", cmd: ["claude", "-p", "x"] });
    const bad = (dir: string, out = "../o") => () => parseJailArgs(["--root", "/w", "agent", "--dir", dir, "--out", out, "--", "true"], "/w/repo");
    expect(bad(".")).toThrow(/isn't a task directory/); // the person's checkout
    expect(bad("../repo")).toThrow(/isn't a task directory/);
    expect(bad("../.jail")).toThrow(/isn't a task directory/);
    expect(bad("/etc")).toThrow(/isn't a task directory/);
    expect(bad("../a/b")).toThrow(/isn't a task directory/);
    expect(bad("../a", "../a")).toThrow(/must differ/);
    expect(() => parseJailArgs(["--root", "/w", "agent", "--dir", "../a", "--out", "../b"])).toThrow(/usage/);
    expect(() => parseJailArgs(["--root", "/w", "agent", "--dir", "../a", "--out", "../b", "--cli", "gemini", "--", "x"], "/w/repo")).toThrow(/unknown --cli/);
  });

  it("reaches the providers' sign-in and API hosts and download hosts of package registries, by name", () => {
    expect(jailAllows("claude.ai", 443)).toBe(false);
    for (const h of ["api.anthropic.com", "chatgpt.com", "auth.openai.com", "registry.npmjs.org", "files.pythonhosted.org", "index.crates.io", "API.Anthropic.com."]) expect(jailAllows(h, 443), h).toBe(true);
    // Upload hosts, fetch-for-you proxies, arbitrary sites, and other ports are not.
    for (const h of ["upload.pypi.org", "crates.io", "proxy.golang.org", "api.openai.com", "example.com", "github.com", "evil.anthropic.com.example.com"]) expect(jailAllows(h, 443), h).toBe(false);
    expect(jailAllows("api.anthropic.com", 80)).toBe(false);
    expect(jailAllows("api.anthropic.com", 22)).toBe(false);
    expect(jailAllows("archive.ubuntu.com", 80)).toBe(true);
    expect(jailAllows("registry.npmjs.org", 80)).toBe(false);
    expect(JAIL_HOSTS).not.toContain("*");
  });

  it("hides the home directory, the work root and /tmp, and shows only the task's clone, its output, the checkout's objects and the CLI's sign-in", () => {
    const a = parseJailArgs(["--root", "/w", "agent", "--dir", "../t", "--out", "../t.out", "--cli", "claude-code", "--", "claude"], "/w/repo");
    const tools = tmp("jail-tools-");
    mkdirSync(path.join(tools, "home"));
    writeFileSync(path.join(tools, "home", ".claude_.credentials.json"), "{}");
    const args = bwrapArgs(a, { home: "/home/p", tools, env: { PATH: "/home/p/bin:/usr/bin", NODE_EXTRA_CA_CERTS: "/etc/ca.crt", DIFFINERY_JOB_TOKEN: "secret", GIT_AUTHOR_NAME: "bot" }, cliPath: "/usr/lib/claude/cli.js", nodePath: "/usr/bin/node" });
    const s = args.join(" ");
    for (const f of ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]) expect(args).toContain(f);
    expect(s).toContain("--cap-drop ALL");
    expect(args).not.toContain("--share-net");
    // /run too: the Docker daemon's and BuildKit's sockets live there, and a socket file reaches across network namespaces.
    for (const h of ["/tmp", "/run", "/home/p", "/w"]) expect(s).toContain(`--tmpfs ${h}`);
    expect(s).toContain("--bind /w/t /w/t");
    expect(s).toContain("--bind /w/t.out /w/t.out");
    expect(s).toContain("--ro-bind /w/repo/.git/objects /w/repo/.git/objects");
    expect(s).not.toMatch(/\/w\/repo(\/\.git)?(\/config)? /);
    expect(s).not.toContain("--bind /w/repo/.git ");
    // The environment is cleared, then given only what it needs: no sandbox secrets.
    expect(s).not.toContain("secret");
    expect(s).toContain("--setenv GIT_AUTHOR_NAME bot");
    expect(s).toContain("--setenv HTTPS_PROXY http://127.0.0.1:3128");
    expect(s).toContain(`--setenv PATH ${tools}/bin:/usr/bin`);
    // The sign-in is a private copy, and the jail's tools are read-only.
    expect(s).toContain(`--bind ${tools}/home/.claude_.credentials.json /home/p/.claude/.credentials.json`);
    expect(s).not.toContain("--bind /home/p/.claude/.credentials.json");
    expect(s).toContain(`--ro-bind ${tools} ${tools}`);
    expect(s).not.toContain(".claude.json"); // not copied here, so not bound
    expect(s).toContain("--chdir /w/t");
    // A finish jail has no way out and no sign-in.
    const f = bwrapArgs({ ...a, mode: "finish", cli: undefined }, { home: "/home/p", tools, env: {}, nodePath: "/usr/bin/node" }).join(" ");
    expect(f).not.toContain("HTTPS_PROXY");
    expect(f).not.toContain(".claude");
  });

  describe("its proxy", () => {
    let dir: string;
    let sock: string;
    let close: () => void;
    const logs: string[] = [];
    beforeAll(async () => {
      dir = tmp("jail-");
      sock = path.join(dir, "p.sock");
      const server = await startJailProxy(sock, (l) => logs.push(l));
      close = () => server.close();
    });
    afterAll(() => close());

    const connect = (target: string) =>
      new Promise<string>((resolve) => {
        const c = net.connect(sock, () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        let got = "";
        c.on("data", (d) => {
          got += d;
          if (got.includes("\r\n\r\n")) {
            c.destroy();
            resolve(got.split("\r\n")[0]!);
          }
        });
        c.on("end", () => resolve(got.split("\r\n")[0]!));
        c.on("error", () => resolve(got.split("\r\n")[0] ?? ""));
      });

    it("refuses tunnels anywhere else, and to the allowed hosts on other ports or by address", async () => {
      expect(await connect("example.com:443")).toBe("HTTP/1.1 403 Forbidden");
      expect(await connect("api.anthropic.com:80")).toBe("HTTP/1.1 403 Forbidden");
      expect(await connect("1.1.1.1:443")).toBe("HTTP/1.1 403 Forbidden");
      expect(await connect("api.anthropic.com.evil.test:443")).toBe("HTTP/1.1 403 Forbidden");
      expect(logs.some((l) => l.includes("refused a connection to example.com:443"))).toBe(true);
    });

    it("serves plain HTTP only to package mirrors, and only downloads", async () => {
      const send = (method: string, url: string) =>
        new Promise<number>((resolve) => {
          const r = request({ socketPath: sock, method, path: url, headers: { host: new URL(url).host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          r.on("error", () => resolve(0));
          r.end();
        });
      expect(await send("GET", "http://example.com/")).toBe(403);
      expect(await send("POST", "http://archive.ubuntu.com/ubuntu/")).toBe(403);
      expect(await send("GET", "http://registry.npmjs.org/left-pad")).toBe(403);
    });
  });
});

describe("a headless run's jail (phase 5d)", () => {
  const args = (...extra: string[]) => ["--root", "/w", "agent", "--dir", "../task-2-1", "--out", "../task-2-1.out", ...extra, "--", "claude", "-p", "x"];
  it("takes --egress model, for agent jails without a sign-in", () => {
    expect(parseJailArgs(args("--egress", "model"), "/w/repo").egress).toBe("model");
    expect(() => parseJailArgs(args("--egress", "model", "--cli", "claude-code"), "/w/repo")).toThrow(/without --cli/);
    expect(() => parseJailArgs(["--root", "/w", "finish", "--dir", "../a", "--out", "../b", "--egress", "model", "--", "true"], "/w/repo")).toThrow(/for agent jails/);
    expect(() => parseJailArgs(args("--egress", "web"), "/w/repo")).toThrow(/unknown --egress/);
  });

  it("reaches the package registries only: no CLI vendor, and never Diffinery's host", () => {
    for (const h of ["api.anthropic.com", "console.anthropic.com", "chatgpt.com", "auth.openai.com", "diffinery.example"]) expect(jailAllows(h, 443, "model"), h).toBe(false);
    for (const h of REGISTRY_HOSTS) expect(jailAllows(h, 443, "model"), h).toBe(true);
    expect(jailAllows("archive.ubuntu.com", 80, "model")).toBe(true);
  });

  it("keeps the model variables, never the run's token, and sends model requests around the CONNECT proxy", () => {
    const a = parseJailArgs(args("--egress", "model"), "/w/repo");
    const tools = tmp("jail-tools-");
    const env = { PATH: "/usr/bin", ANTHROPIC_BASE_URL: `${MODEL_URL}/-/model/anthropic`, ANTHROPIC_API_KEY: "diffinery-jail", DIFFINERY_MODEL_TOKEN: "dmt_repo_secret", DIFFINERY_MODEL_ORIGIN: "https://d.example", OPENAI_API_KEY: "diffinery-jail" };
    const s = bwrapArgs(a, { home: "/home/p", tools, env, nodePath: "/usr/bin/node" }).join(" ");
    expect(s).toContain(`--setenv ANTHROPIC_BASE_URL ${MODEL_URL}/-/model/anthropic`);
    expect(s).toContain("--setenv ANTHROPIC_API_KEY diffinery-jail");
    expect(s).toContain("--setenv OPENAI_API_KEY diffinery-jail");
    expect(s).not.toContain("dmt_repo_secret");
    expect(s).not.toContain("d.example");
    expect(s).toContain("--setenv NO_PROXY 127.0.0.1,localhost");
    // A terminal task's jail keeps none of them.
    const t = bwrapArgs({ ...a, egress: "cli", cli: "claude-code" }, { home: "/home/p", tools, env, nodePath: "/usr/bin/node" }).join(" ");
    expect(t).not.toContain("ANTHROPIC_BASE_URL");
    expect(t).not.toContain("NO_PROXY");
  });

  it("shares a test pool's directories, and refuses one that would undo what the jail hides", () => {
    const e2e = tmp("jail-e2e-");
    mkdirSync(path.join(e2e, "pool", "s1", "repo"), { recursive: true });
    mkdirSync(path.join(e2e, "work"));
    const root = path.join(e2e, "pool", "s1");
    const home = path.join(e2e, "home");
    mkdirSync(path.join(home, "sub"), { recursive: true });
    const work = path.join(e2e, "work");
    const a = parseJailArgs(["--root", root, "agent", "--dir", "../t", "--out", "../t.out", "--egress", "model", "--", "true"], path.join(root, "repo"));
    const args = (shared?: string) => bwrapArgs(a, { home, tools: tmp("jail-tools-"), env: shared === undefined ? {} : { [SHARED_ENV]: shared }, nodePath: "/usr/bin/node" }).join(" ");
    const s = args(work);
    expect(s.indexOf(`--bind ${work} ${work} `)).toBeGreaterThan(s.indexOf("--tmpfs /tmp "));
    expect(args()).not.toContain(`--bind ${work} `);
    // `/`, the work root (with the checkout and its git credential), the home directory, /tmp, anything holding them
    // or inside the work root or home: shared, they would undo the jail's isolation, so the jail doesn't start.
    for (const bad of ["/", e2e, path.join(e2e, "pool"), root, path.join(root, "repo"), home, path.join(home, "sub"), "/tmp", `${work}:/`]) expect(() => args(bad), bad).toThrow(/is, holds or is inside a directory the jail hides/);
    for (const bad of ["relative", "/nonexistent"]) expect(() => args(bad), bad).toThrow(/isn't an existing absolute directory/);
  });

  describe("its model proxy", () => {
    let sock: string;
    let upstream: Server;
    let close: () => void;
    const seen: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }> = [];
    const logs: string[] = [];
    let slowOpen = 0;
    let slowClosed = 0;
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(ok()).toBe(true);
    };
    beforeAll(async () => {
      upstream = createServer((req, res) => {
        // A slow answer: it streams until whoever asked goes away.
        if (req.headers["content-length"] === "4") {
          slowOpen++;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: thinking\n\n");
          res.on("close", () => slowClosed++);
          return;
        }
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
          res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "s=1" });
          res.write("data: one\n\n");
          setTimeout(() => res.end("data: two\n\n"), 20);
        });
      });
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
      const origin = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
      sock = path.join(tmp("jail-model-"), "m.sock");
      const server = await startModelProxy(sock, origin, "dmt_repo_runtoken", (l) => logs.push(l));
      close = () => {
        server.close();
        upstream.close();
      };
    });
    afterAll(() => close());

    const send = (method: string, url: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve) => {
        const r = request({ socketPath: sock, method, path: url, headers: { host: "127.0.0.1:3129", ...headers } }, (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
        });
        r.on("error", () => resolve({ status: 0, body: "", headers: {} }));
        r.end(body);
      });

    it("forwards model requests with the run's token in place of whatever the agent sent, and streams the answer", async () => {
      const r = await send("POST", "/-/model/anthropic/v1/messages?beta=true", { "x-api-key": "diffinery-jail", authorization: "Bearer planted-diffinery-token", cookie: "dfy_session=x", "content-type": "application/json", "anthropic-version": "2023-06-01" }, '{"max_tokens":5}');
      expect(r.status).toBe(200);
      expect(r.body).toBe("data: one\n\ndata: two\n\n");
      expect(r.headers["set-cookie"]).toBeUndefined();
      const got = seen.at(-1)!;
      expect(got.url).toBe("/-/model/anthropic/v1/messages?beta=true");
      expect(got.body).toBe('{"max_tokens":5}');
      expect(got.headers.authorization).toBe("Bearer dmt_repo_runtoken");
      expect(got.headers["x-api-key"]).toBeUndefined();
      expect(got.headers.cookie).toBeUndefined();
      expect(got.headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("cancels the request to Diffinery when the agent hangs up", async () => {
      const r = request({ socketPath: sock, method: "POST", path: "/-/model/anthropic/v1/messages", headers: { host: "127.0.0.1:3129" } });
      r.on("error", () => {});
      r.end("slow");
      await until(() => slowOpen === 1);
      r.destroy();
      await until(() => slowClosed === 1);
    });

    it("refuses everything else on Diffinery, however the path is spelled", async () => {
      const before = seen.length;
      for (const url of ["/api/v3/user", "/owner/repo.git/info/refs?service=git-receive-pack", "/-/model/../api/v3/user", "/-/model/%2e%2e/api/v3/user", "/-/model/anthropic/%2E%2E/%2E%2E/api", "/-/model%2fanthropic", "/-/model/a\\..\\..\\api", "//evil.example/-/model/x", "http://evil.example/-/model/anthropic/v1/messages", "/-/modelx/anthropic"]) {
        expect((await send("GET", url)).status, url).toBe(403);
      }
      expect(seen.length).toBe(before);
      expect(logs.some((l) => l.includes("refused GET /api/v3/user"))).toBe(true);
    });
  });
});
