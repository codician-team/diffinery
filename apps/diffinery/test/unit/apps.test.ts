import { describe, expect, it } from "vitest";
import { createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import { fingerprintOf, generateAppKey, looksLikeJwt, parsePublicKey, verifyAppJwt } from "../../src/apps/keys.js";
import { intersectPermissions, narrowPermissions, parseEvents, parsePermissions, slugify, toJobPermissions, widens } from "../../src/apps/model.js";
import { Apps } from "../../src/apps/store.js";
import { denied, requestPermission } from "../../src/lib/job-permissions.js";
import type { Account } from "../../src/lib/directory.js";
import type { Env } from "../../src/env.js";
import { testD1 } from "./stubs/d1.js";

const now = Math.floor(Date.now() / 1000);
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function jwt(pem: string, claims: Record<string, unknown>, alg = "RS256"): string {
  const head = `${enc({ alg, typ: "JWT" })}.${enc(claims)}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(pem).toString("base64url")}`;
}

describe("app keys and JWTs", () => {
  it("generates a PKCS#1 key whose JWTs verify, as GitHub Apps' libraries sign them", async () => {
    const k = await generateAppKey();
    expect(createPublicKey(k.privateKeyPem).export({ type: "spki", format: "der" }).toString("base64")).toBe(k.publicKey);
    expect(k.fingerprint).toBe(await fingerprintOf(Buffer.from(k.publicKey, "base64")));
    const token = jwt(k.privateKeyPem, { iat: now - 60, exp: now + 540, iss: 7 });
    expect(looksLikeJwt(token)).toBe(true);
    expect(await verifyAppJwt(token, [{ id: "k1", publicKey: k.publicKey }], now)).toEqual({ keyId: "k1" });
  });

  it("refuses JWTs GitHub refuses", async () => {
    const k = await generateAppKey();
    const keys = [{ id: "k1", publicKey: k.publicKey }];
    const err = async (t: string) => ((await verifyAppJwt(t, keys, now)) as { error: string }).error;
    expect(await err(jwt(k.privateKeyPem, { iat: now - 700, exp: now - 100, iss: 1 }))).toMatch(/Expiration time/);
    expect(await err(jwt(k.privateKeyPem, { iat: now, exp: now + 3600, iss: 1 }))).toMatch(/too far in the future/);
    expect(await err(jwt(k.privateKeyPem, { iat: now + 600, exp: now + 900, iss: 1 }))).toMatch(/Issued at/);
    expect(await err(jwt(k.privateKeyPem, { iat: now, exp: now + 60, iss: 1 }, "HS256"))).toMatch(/RS256/);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    expect(await err(jwt(other, { iat: now, exp: now + 60, iss: 1 }))).toMatch(/could not be decoded/);
    expect(((await verifyAppJwt(jwt(k.privateKeyPem, { iat: now, exp: now + 60, iss: 1 }), [], now)) as { error: string }).error).toMatch(/must generate a public key/);
  });

  it("takes public keys in PEM, never private ones or short ones", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
    const pkcs1 = pair.publicKey.export({ type: "pkcs1", format: "pem" }) as string;
    const a = await parsePublicKey(spki);
    expect((await parsePublicKey(pkcs1)).fingerprint).toBe(a.fingerprint);
    await expect(parsePublicKey(pair.privateKey.export({ type: "pkcs1", format: "pem" }) as string)).rejects.toThrow(/private key/);
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }) as string;
    await expect(parsePublicKey(small)).rejects.toThrow(/2048/);
    await expect(parsePublicKey("not a key")).rejects.toThrow(/PEM/);
  });
});

describe("app permissions", () => {
  it("parses GitHub's names, always with metadata read", () => {
    expect(parsePermissions({ contents: "write", issues: "none" })).toEqual({ contents: "write", metadata: "read" });
    expect(() => parsePermissions({ administration: "write" })).toThrow(/unsupported permission/);
    expect(() => parsePermissions({ workflows: "write" })).toThrow(/unsupported permission/);
    expect(() => parsePermissions({ metadata: "write" })).toThrow(/must be read/);
    expect(parseEvents(["push", "push"], { contents: "read" })).toEqual(["push"]);
    expect(() => parseEvents(["issues"], { contents: "read" })).toThrow(/issues permission/);
  });

  it("narrows, intersects and notices more", () => {
    const granted = { metadata: "read", contents: "write", checks: "write" } as const;
    expect(narrowPermissions(granted, { contents: "read" })).toEqual({ contents: "read", metadata: "read" });
    expect(() => narrowPermissions(granted, { issues: "read" })).toThrow(/not granted/);
    expect(intersectPermissions(granted, { metadata: "read", contents: "read" })).toEqual({ metadata: "read", contents: "read" });
    expect(widens(granted, { ...granted, issues: "read" })).toBe(true);
    expect(widens(granted, { metadata: "read", contents: "read" })).toBe(false);
    expect(slugify("Cloud Builds!")).toBe("cloud-builds");
  });

  it("checks installation tokens per endpoint, as workflow tokens are", () => {
    const p = toJobPermissions({ metadata: "read", contents: "write", pull_requests: "read" });
    expect(p["pull-requests"]).toBe("read");
    expect(p.packages).toBe("none");
    expect(denied(p, requestPermission("PUT", "/api/v3/repos/a/b/contents/x", "write"), "app")).toBeNull();
    expect(denied(p, requestPermission("POST", "/api/v3/repos/a/b/issues", "write"), "app")).toMatch(/the app needs the issues permission: write/);
    expect(denied(p, requestPermission("POST", "/api/v3/repos/a/b/hooks", "admin"), "app")).toMatch(/apps can't use this endpoint/);
  });
});

describe("app store", () => {
  const at = new Date().toISOString();
  function setup() {
    const db = testD1();
    db.sqlite.exec(`
      INSERT INTO accounts (id, login, kind, status, created_at) VALUES ('ada', 'ada', 'user', 'active', '${at}'), ('bob', 'bob', 'user', 'active', '${at}');
      INSERT INTO repos (id, owner_id, name, visibility, default_branch, created_at, updated_at) VALUES ('r1', 'ada', 'site', 'private', 'main', '${at}', '${at}'), ('r2', 'ada', 'docs', 'private', 'main', '${at}', '${at}'), ('r3', 'bob', 'own', 'private', 'main', '${at}', '${at}');
    `);
    const env = { DB: db, PUBLIC_URL: "https://diffinery.example" } as unknown as Env;
    const account = (id: string) => db.sqlite.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as Account;
    return { apps: new Apps(env), ada: account("ada"), bob: account("bob") };
  }

  it("installs, mints narrowed tokens and stops them when the app asks for less or is suspended", async () => {
    const { apps, ada, bob } = setup();
    const { app } = await apps.create(ada, ada, { name: "Builds", homepage_url: "https://b.example", default_permissions: { contents: "write", checks: "write" } });
    await expect(apps.install(app, bob, bob, "all")).rejects.toThrow(/private/);
    await expect(apps.install(app, ada, ada, "selected", ["r3"])).rejects.toThrow(/doesn't belong/);
    const { installation } = await apps.install(app, ada, ada, "selected", ["r1"]);
    expect(await apps.covers(installation, { id: "r1", owner_id: "ada" })).toBe(true);
    expect(await apps.covers(installation, { id: "r2", owner_id: "ada" })).toBe(false);
    await expect(apps.mintToken(app, installation, { repositories: ["docs"] }, () => 0)).rejects.toThrow(/not accessible/);
    const t = await apps.mintToken(app, installation, { repositories: ["site"], permissions: { contents: "read" } }, () => 0);
    const auth = (await apps.verifyToken(t.token))!;
    expect(auth.repoIds).toEqual(["r1"]);
    expect(auth.permissions).toEqual({ contents: "read", metadata: "read" });
    const full = await apps.mintToken(app, installation, {}, () => 0);
    await apps.update(app, { default_permissions: { contents: "read" } });
    expect((await apps.verifyToken(full.token))!.permissions).toEqual({ contents: "read", metadata: "read" });
    await apps.suspend(installation, ada, true);
    expect(await apps.verifyToken(full.token)).toBeNull();
    await expect(apps.mintToken(app, (await apps.installation(installation.id))!, {}, () => 0)).rejects.toThrow(/suspended/);
  });

  it("deletes an account's apps and installations with it", async () => {
    const { apps, ada } = setup();
    const { app } = await apps.create(ada, ada, { name: "Gone", homepage_url: "https://g.example" });
    await apps.install(app, ada, ada, "all");
    for (const s of apps.accountDeletes(["ada"])) await s.run();
    expect(await apps.byId(app.id)).toBeNull();
    expect(await apps.installationsOf(app.id)).toEqual([]);
  });
});
