import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { authorizeUrl, clientId, editorRedirect, installHintPath, normalizeServer, pkce, readCallback, readInstallHint, serverInputError, serverLabel } from "../src/util";

const S = "https://diffinery.com";

describe("server and OAuth", () => {
  it("normalizes the server setting", () => {
    expect(normalizeServer(undefined)).toBe(S);
    expect(normalizeServer(" https://diffinery.com/ ")).toBe(S);
    expect(normalizeServer("diffinery.example.org")).toBe("https://diffinery.example.org");
    expect(normalizeServer("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => normalizeServer("http://diffinery.com")).toThrow(/https/);
    expect(() => normalizeServer("https://")).toThrow(/valid URL/);
  });

  it("checks a server address someone types, and shows it by its host", () => {
    expect(serverInputError("git.example.com")).toBeNull();
    expect(serverInputError(" https://git.example.com/ ")).toBeNull();
    expect(serverInputError("http://localhost:8787")).toBeNull();
    expect(serverInputError("")).toMatch(/Enter/);
    expect(serverInputError("git example")).toMatch(/spaces/);
    expect(serverInputError("http://git.example.com")).toMatch(/https/);
    expect(serverInputError("https://")).toMatch(/valid/);
    expect(serverLabel(S)).toBe("diffinery.com");
    expect(serverLabel("https://git.example.com:8443")).toBe("git.example.com:8443");
  });

  it("reads the server the installer left, where the installers write it", () => {
    expect(installHintPath({ HOME: "/home/ada" }, "/ignored")).toBe(path.join("/home/ada", ".config", "diffinery", "editor-server"));
    expect(installHintPath({ HOME: "/home/ada", XDG_CONFIG_HOME: "/cfg" }, "/ignored")).toBe(path.join("/cfg", "diffinery", "editor-server"));
    expect(installHintPath({ XDG_CONFIG_HOME: "relative" }, "/home/bo")).toBe(path.join("/home/bo", ".config", "diffinery", "editor-server"));
    expect(readInstallHint("https://git.example.com/\n")).toBe("https://git.example.com");
    expect(readInstallHint("git.example.com\r\n")).toBe("https://git.example.com");
    expect(readInstallHint("http://git.example.com\n")).toBeNull();
    expect(readInstallHint("")).toBeNull();
    expect(readInstallHint("{\"server\": 1}")).toBeNull();
    const sh = readFileSync(path.join(__dirname, "../install/install.sh"), "utf8");
    const ps1 = readFileSync(path.join(__dirname, "../install/install.ps1"), "utf8");
    expect(sh).toContain('"$conf/diffinery/editor-server"');
    expect(ps1).toContain('"diffinery\\editor-server"');
  });

  it("registers every command it contributes", () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8"));
    const src = readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
    for (const c of pkg.contributes.commands as { command: string }[]) expect(src).toContain(`"${c.command}"`);
  });

  it("returns to the editor by its own scheme when the server knows it", () => {
    expect(editorRedirect("vscode")).toBe("vscode://codician.diffinery/oauth");
    expect(editorRedirect("cursor")).toBe("cursor://codician.diffinery/oauth");
    expect(editorRedirect("some-fork")).toBeNull();
    expect(clientId(S)).toBe("https://diffinery.com/oauth/clients/editor.json");
  });

  it("makes a PKCE pair and an authorization URL", () => {
    const p = pkce();
    expect(p.challenge).toBe(createHash("sha256").update(p.verifier).digest("base64url"));
    const u = new URL(authorizeUrl(S, "cursor://codician.diffinery/oauth", p.challenge, p.state));
    expect(u.origin + u.pathname).toBe(`${S}/oauth/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: "code", client_id: clientId(S), redirect_uri: "cursor://codician.diffinery/oauth", code_challenge: p.challenge, code_challenge_method: "S256", state: p.state, scope: "write" });
  });

  it("accepts only the callback of this sign-in, from this server", () => {
    const expect_ = { state: "st", server: S };
    expect(readCallback(`code=dfa_1&state=st&iss=${encodeURIComponent(S)}`, expect_)).toEqual({ code: "dfa_1" });
    expect(readCallback("code=dfa_1&state=other", expect_)).toHaveProperty("error");
    expect(readCallback("code=dfa_1&state=st&iss=https%3A%2F%2Fevil.example", expect_)).toEqual({ error: expect.stringMatching(/evil\.example/) });
    expect(readCallback("error=access_denied&state=st", expect_)).toEqual({ error: "Sign-in was cancelled in the browser." });
    expect(readCallback("state=st", expect_)).toHaveProperty("error");
  });
});
