import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptAndReseal, decryptSecret, encryptSecret, keyId, masterKeys, matchesAnyKey, openSecret, resealSecret } from "../../src/lib/crypto.js";
import { signBlobUrl, signRuntimeToken, verifyBlobUrl, verifyRuntimeToken } from "../../src/lib/runtime-auth.js";
import { inviteProof, validInviteProof } from "../../src/auth/invite-proof.js";
import { readUnsubToken, unsubToken } from "../../src/mail/unsubscribe.js";
import { readVerifyToken, verifyToken } from "../../src/mail/suppression.js";
import { codeHash, codeMatches } from "../../src/auth/signup.js";
import { ImportService } from "../../src/imports/service.js";
import type { Env } from "../../src/env.js";

const OLD = Buffer.alloc(32, 1).toString("base64");
const NEW = Buffer.alloc(32, 2).toString("base64");
const OTHER = Buffer.alloc(32, 3).toString("base64");
const PUB = "https://diffinery.example";
/** Before the rotation, during it (old key kept as MASTER_KEY_PREV), after it, and an unrelated instance. */
const before = { MASTER_KEY: OLD, PUBLIC_URL: PUB } as unknown as Env;
const during = { MASTER_KEY: NEW, MASTER_KEY_PREV: OLD, PUBLIC_URL: PUB } as unknown as Env;
const after = { MASTER_KEY: NEW, PUBLIC_URL: PUB } as unknown as Env;
const other = { MASTER_KEY: OTHER, PUBLIC_URL: PUB } as unknown as Env;

const kidOf = (k: string) => createHash("sha256").update(Buffer.from(k, "base64")).digest("hex").slice(0, 8);
const hmacB64url = (key: string, data: string) => createHmac("sha256", key).update(data).digest("base64url");

describe("master keys", () => {
  it("are the current key first, then the previous one while rotating", () => {
    expect(masterKeys(before)).toEqual([OLD]);
    expect(masterKeys(during)).toEqual([NEW, OLD]);
    // The same value twice, or an empty one, counts once; MASTER_KEY_PREV alone is no key at all.
    expect(masterKeys({ MASTER_KEY: OLD, MASTER_KEY_PREV: OLD })).toEqual([OLD]);
    expect(masterKeys({ MASTER_KEY: OLD, MASTER_KEY_PREV: "" })).toEqual([OLD]);
    expect(masterKeys({ MASTER_KEY_PREV: OLD })).toEqual([]);
  });

  it("are named in envelopes by the first 8 hex characters of SHA-256 over their bytes", async () => {
    expect(await keyId(OLD)).toBe(kidOf(OLD));
    expect(await keyId(NEW)).not.toBe(await keyId(OLD));
  });

  it("a malformed previous key never breaks a check under the current one", async () => {
    const mac = async (k: string) => Buffer.from(k, "base64").toString("hex");
    expect(await matchesAnyKey([NEW, "!!"], await mac(NEW), mac)).toBe(true);
    await expect(matchesAnyKey(["!!", NEW], "x", async () => Promise.reject(new Error("bad key")))).rejects.toThrow("bad key");
  });
});

describe("secret envelopes", () => {
  // Written by the v1 code (before keys could be rotated) with OLD, scope repo:r1.
  const V1 = "v1.u9iC/IUkKT+24mVm.pCaoBWOPvxHGC6vK6GkimNm7zhfgouc=";

  it("written before rotation existed still decrypt, before and during a rotation", async () => {
    expect(await decryptSecret(before, "repo:r1", V1)).toBe("hunter2");
    expect(await openSecret(during, "repo:r1", V1)).toEqual({ plaintext: "hunter2", current: false });
    expect(await openSecret(before, "repo:r1", V1)).toEqual({ plaintext: "hunter2", current: false });
  });

  it("are v2 with the key id now, and round-trip", async () => {
    const e = await encryptSecret(before, "repo:r1", "hunter2");
    expect(e).toMatch(new RegExp(`^v2\\.${kidOf(OLD)}\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+$`));
    expect(e).not.toContain("hunter2");
    expect(await openSecret(before, "repo:r1", e)).toEqual({ plaintext: "hunter2", current: true });
    // The same AES-GCM ciphertext as v1 would carry: dropping the key id gives a valid v1 envelope.
    const [, , iv, ct] = e.split(".");
    expect(await decryptSecret(before, "repo:r1", `v1.${iv}.${ct}`)).toBe("hunter2");
  });

  it("sealed with the old key decrypt with MASTER_KEY_PREV, and new ones use the new key", async () => {
    const old = await encryptSecret(before, "org:o1", "s3cret");
    expect(await openSecret(during, "org:o1", old)).toEqual({ plaintext: "s3cret", current: false });
    const fresh = await encryptSecret(during, "org:o1", "s3cret");
    expect(fresh.split(".")[1]).toBe(kidOf(NEW));
    expect(await openSecret(during, "org:o1", fresh)).toEqual({ plaintext: "s3cret", current: true });
    expect(await decryptSecret(after, "org:o1", fresh)).toBe("s3cret");
    // Once MASTER_KEY_PREV is gone, what only the old key opens doesn't decrypt.
    await expect(decryptSecret(after, "org:o1", old)).rejects.toThrow(/doesn't decrypt with MASTER_KEY$/);
    await expect(decryptSecret(after, "repo:r1", V1)).rejects.toThrow();
  });

  it("are tried with every key when the key id names none of them", async () => {
    const e = await encryptSecret(before, "repo:r1", "x");
    const [v, , iv, ct] = e.split(".");
    expect(await openSecret(during, "repo:r1", `${v}.00000000.${iv}.${ct}`)).toEqual({ plaintext: "x", current: false });
  });

  it("don't decrypt with a wrong key, in another scope, or when damaged", async () => {
    const e = await encryptSecret(before, "repo:r1", "hunter2");
    await expect(decryptSecret(other, "repo:r1", e)).rejects.toThrow(/doesn't decrypt/);
    await expect(decryptSecret({ MASTER_KEY: OTHER, MASTER_KEY_PREV: NEW }, "repo:r1", e)).rejects.toThrow(/MASTER_KEY or MASTER_KEY_PREV/);
    await expect(decryptSecret(before, "repo:r2", e)).rejects.toThrow(/doesn't decrypt/);
    await expect(decryptSecret(before, "repo:r1", V1.replace("pCa", "pCb"))).rejects.toThrow(/doesn't decrypt/);
    for (const bad of ["v3.a.b", "v1.a", "v2.zzzzzzzz.a.b", "v2.a.b", "plain"]) await expect(decryptSecret(before, "repo:r1", bad), bad).rejects.toThrow(/bad secret envelope/);
    await expect(encryptSecret({ MASTER_KEY_PREV: OLD }, "repo:r1", "x")).rejects.toThrow(/MASTER_KEY is not configured/);
    await expect(decryptSecret({}, "repo:r1", V1)).rejects.toThrow(/MASTER_KEY is not configured/);
  });

  it("are sealed again only when that is worth it, and never lost", async () => {
    const current = await encryptSecret(during, "repo:r1", "hunter2");
    expect(await resealSecret(during, "repo:r1", current)).toBe(current);
    for (const stale of [V1, await encryptSecret(before, "repo:r1", "hunter2")]) {
      const resealed = await resealSecret(during, "repo:r1", stale);
      expect(resealed.split(".").slice(0, 2)).toEqual(["v2", kidOf(NEW)]);
      expect(await decryptSecret(after, "repo:r1", resealed)).toBe("hunter2");
    }
    // One that doesn't decrypt is kept as it was.
    expect(await resealSecret(other, "repo:r1", V1)).toBe(V1);
  });

  it("in use are stored again under the current key, and using them never depends on that", async () => {
    const current = await encryptSecret(during, "repo:r1", "hunter2");
    const stored: string[] = [];
    expect(await decryptAndReseal(during, "repo:r1", current, (s) => stored.push(s))).toBe("hunter2");
    expect(stored).toEqual([]);
    for (const stale of [V1, await encryptSecret(before, "repo:r1", "hunter2")]) {
      stored.length = 0;
      expect(await decryptAndReseal(during, "repo:r1", stale, (s) => stored.push(s))).toBe("hunter2");
      expect(stored).toHaveLength(1);
      expect(stored[0]!.split(".").slice(0, 2)).toEqual(["v2", kidOf(NEW)]);
      expect(await decryptSecret(after, "repo:r1", stored[0]!)).toBe("hunter2");
    }
    // A store that fails (or rejects) is logged, and the secret is still returned.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await decryptAndReseal(during, "repo:r1", V1, () => Promise.reject(new Error("D1 down")))).toBe("hunter2");
    expect(await decryptAndReseal(during, "repo:r1", V1, () => { throw new Error("sql busy"); })).toBe("hunter2");
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
    // One that doesn't decrypt still throws, as decryptSecret does, and stores nothing.
    await expect(decryptAndReseal(other, "repo:r1", V1, (s) => stored.push(s))).rejects.toThrow(/decrypt/);
  });
});

describe("signatures made with MASTER_KEY", () => {
  it("runtime tokens: old ones verify while rotating, new ones use the new key", async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const claims = { repo: "r1", run: "run1", job: "job1", exp };
    const old = await signRuntimeToken(before, "x", claims, ["refs/heads/main"]);
    expect(await verifyRuntimeToken(during, old)).toMatchObject({ repo: "r1", job: "job1" });
    expect(await verifyRuntimeToken(after, old)).toBeNull();
    const fresh = await signRuntimeToken(during, "x", claims, ["refs/heads/main"]);
    expect(await verifyRuntimeToken(after, fresh)).toMatchObject({ repo: "r1" });
    expect(await verifyRuntimeToken(before, fresh)).toBeNull();
    expect(await verifyRuntimeToken(other, old)).toBeNull();
    expect(await verifyRuntimeToken({}, old)).toBeNull();
  });

  it("blob URLs: signed exactly as before, accepted with MASTER_KEY_PREV, new ones under the new key", async () => {
    const ref = { repo: "r1", kind: "artifact" as const, id: 42 };
    const old = new URL(await signBlobUrl(before, "https://d.example", ref, "r", 4102444800));
    // Signed by the code before rotation existed, with OLD.
    expect(old.searchParams.get("sig")).toBe("1I0_HL80HFt73S7qB9xv13q82j8Y8OvdubCBDKmlufM");
    expect(await verifyBlobUrl(during, ref, "r", old.searchParams)).toBe(true);
    expect(await verifyBlobUrl(after, ref, "r", old.searchParams)).toBe(false);
    const fresh = new URL(await signBlobUrl(during, "https://d.example", ref, "r", 4102444800));
    expect(fresh.searchParams.get("sig")).not.toBe(old.searchParams.get("sig"));
    expect(await verifyBlobUrl(after, ref, "r", fresh.searchParams)).toBe(true);
    expect(await verifyBlobUrl(other, ref, "r", old.searchParams)).toBe(false);
  });

  it("invitation proofs", async () => {
    const old = await inviteProof(before, "hash1");
    expect(old).toBe(hmacB64url(`diffinery-invite-proof-v1:${OLD}`, "hash1"));
    expect(await validInviteProof(during, "hash1", old)).toBe(true);
    expect(await validInviteProof(during, "hash2", old)).toBe(false);
    expect(await validInviteProof(after, "hash1", old)).toBe(false);
    const fresh = await inviteProof(during, "hash1");
    expect(fresh).toBe(hmacB64url(`diffinery-invite-proof-v1:${NEW}`, "hash1"));
    expect(await validInviteProof(after, "hash1", fresh)).toBe(true);
    expect(await validInviteProof(other, "hash1", old)).toBe(false);
  });

  it("unsubscribe links", async () => {
    const t = { accountId: "acc1", scope: { t: "category" as const, category: "watching" as const } };
    const old = await unsubToken(before, t);
    const [payload, sig] = old.split(".");
    expect(sig).toBe(hmacB64url(`diffinery-unsubscribe-v1:${OLD}`, payload!));
    expect(await readUnsubToken(during, old)).toEqual(t);
    expect(await readUnsubToken(after, old)).toBeNull();
    const fresh = await unsubToken(during, t);
    expect(fresh.split(".")[1]).toBe(hmacB64url(`diffinery-unsubscribe-v1:${NEW}`, fresh.split(".")[0]!));
    expect(await readUnsubToken(after, fresh)).toEqual(t);
    expect(await readUnsubToken(other, old)).toBeNull();
  });

  it("email verification links", async () => {
    const t = { accountId: "ann", email: "ann@example.com", expiresAt: Date.now() + 60_000 };
    const old = await verifyToken(before, t);
    expect(old.split(".")[1]).toBe(hmacB64url(`diffinery-verify-email-v1:${OLD}`, old.split(".")[0]!));
    expect(await readVerifyToken(during, old)).toMatchObject({ accountId: "ann" });
    expect(await readVerifyToken(after, old)).toBeNull();
    const fresh = await verifyToken(during, t);
    expect(await readVerifyToken(after, fresh)).toMatchObject({ accountId: "ann" });
    expect(await readVerifyToken(other, old)).toBeNull();
  });

  it("sign-up code hashes", async () => {
    const stored = await codeHash(before, "row1", "123456");
    expect(stored).toBe(hmacB64url(`diffinery-signup-code-v1:${OLD}`, "row1:123456"));
    expect(await codeMatches(before, "row1", "123456", stored)).toBe(true);
    expect(await codeMatches(during, "row1", "123456", stored)).toBe(true);
    expect(await codeMatches(during, "row1", "654321", stored)).toBe(false);
    expect(await codeMatches(after, "row1", "123456", stored)).toBe(false);
    expect(await codeHash(during, "row1", "123456")).toBe(hmacB64url(`diffinery-signup-code-v1:${NEW}`, "row1:123456"));
    expect(await codeMatches(other, "row1", "123456", stored)).toBe(false);
  });

  describe("GitHub account links", () => {
    afterEach(() => vi.unstubAllGlobals());
    const hex16 = (key: string, data: string) => createHmac("sha256", key).update(data).digest("hex").slice(0, 32);
    const svc = (env: Env) => new ImportService({ ...env, DB: {}, GITHUB_OAUTH_CLIENT_ID: "id", GITHUB_OAUTH_CLIENT_SECRET: "s" } as unknown as Env);
    const person = { id: "u1", kind: "user", login: "ann" } as never;

    it("show the gist nonce under MASTER_KEY, and also take the one under MASTER_KEY_PREV", async () => {
      const api = "https://api.github.com";
      const { nonce } = await svc(before).linkChallenge(person, null);
      expect(nonce).toBe(`diffinery-link-${hex16(OLD, `github-link:u1:${api}`)}`);
      const nonces = await (svc(during) as unknown as { linkNonces(a: string, b: string): Promise<string[]> }).linkNonces("u1", api);
      expect(nonces).toEqual([`diffinery-link-${hex16(NEW, `github-link:u1:${api}`)}`, nonce]);
      expect((await svc(during).linkChallenge(person, null)).nonce).toBe(nonces[0]);
    });

    it("accept an OAuth state made with MASTER_KEY_PREV", async () => {
      const state = new URL(await svc(before).oauthStart(person)).searchParams.get("state")!;
      expect(state).toBe(`u1.${hex16(OLD, "github-oauth:u1")}`);
      // Past the state check, GitHub is asked for a token (and here returns none).
      vi.stubGlobal("fetch", async () => new Response("{}"));
      await expect(svc(during).oauthCallback(person, "code", state)).rejects.toMatchObject({ status: 422, detail: expect.stringMatching(/access token/) });
      await expect(svc(after).oauthCallback(person, "code", state)).rejects.toMatchObject({ status: 422, detail: expect.stringMatching(/OAuth state/) });
      await expect(svc(during).oauthCallback(person, "code", `u1.${hex16(OTHER, "github-oauth:u1")}`)).rejects.toMatchObject({ status: 422, detail: expect.stringMatching(/OAuth state/) });
    });
  });
});

describe("sealing again with the current key", () => {
  const person = { id: "u1", kind: "user", login: "ann" } as never;

  it("a retried import seals the token it keeps with the new key", async () => {
    const token = await encryptSecret(before, "import:imp-1", "ghp_x");
    const row = { id: "imp-1", parent_id: null, kind: "repo", status: "failed", created_by: "u1", target_owner_id: "u1", repo_id: null, attempt: 1, token_ciphertext: token, source: "octo/app" };
    const writes: unknown[][] = [];
    const db = { prepare: () => ({ bind: (...a: unknown[]) => ({ run: async () => void writes.push(a), first: async () => ({ n: 0 }) }) }) };
    const s = new ImportService({ ...during, DB: db, IMPORT_WORKFLOW: { create: async () => ({}) } } as unknown as Env);
    Object.assign(s, { row: async () => row, audit: async () => undefined, canImportInto: async () => true });
    Object.assign(s.dir, { account: async () => ({ id: "u1", kind: "user", login: "ann" }) });
    await s.retry("imp-1", person, null);
    const stored = writes.map((w) => w[1]).find((v) => typeof v === "string" && v.startsWith("v2.")) as string;
    expect(stored.split(".")[1]).toBe(kidOf(NEW));
    expect(await decryptSecret(after, "import:imp-1", stored)).toBe("ghp_x");
  });
});
