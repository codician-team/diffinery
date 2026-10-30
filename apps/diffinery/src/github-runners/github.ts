import type { Env } from "../env.js";
import { b64url, fromB64, hmacSha256Hex, safeEqual } from "../lib/util.js";

/**
 * The instance's GitHub App, which lets GitHub repositories run jobs on Diffinery runners
 * (docs/actions/github-runners.md). It needs these repository permissions: Administration (read and
 * write), to register a just-in-time runner for one job; Actions (read); Metadata (read). It subscribes
 * to the Workflow job event; GitHub sends installation events to every app.
 */
export interface GitHubAppConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
  /** https://github.com, or a GitHub Enterprise Server origin. */
  webUrl: string;
  /** https://api.github.com, or <webUrl>/api/v3 on GitHub Enterprise Server. */
  apiUrl: string;
}

/** The app's settings, or null when this Diffinery has no GitHub App (the feature is then off). */
export function githubApp(env: Env): GitHubAppConfig | null {
  const { GITHUB_APP_ID: appId, GITHUB_APP_SLUG: slug, GITHUB_APP_CLIENT_ID: clientId, GITHUB_APP_CLIENT_SECRET: clientSecret, GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_WEBHOOK_SECRET: webhookSecret } = env;
  if (!appId || !slug || !clientId || !clientSecret || !privateKey || !webhookSecret) return null;
  const webUrl = (env.GITHUB_APP_URL || "https://github.com").replace(/\/+$/, "");
  const apiUrl = webUrl === "https://github.com" ? "https://api.github.com" : `${webUrl}/api/v3`;
  return { appId, slug, clientId, clientSecret, privateKey, webhookSecret, webUrl, apiUrl };
}

/** Whether a webhook body carries GitHub's signature (X-Hub-Signature-256) made with the app's webhook secret. */
export async function webhookSigned(secret: string, header: string | undefined, body: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(header.slice(7).toLowerCase(), await hmacSha256Hex(secret, body));
}

// ---------------------------------------------------------------- the app's JWT

/** DER length bytes. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

function der(tag: number, body: Uint8Array): Uint8Array {
  const len = derLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

/** rsaEncryption's AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }. */
const RSA_ALGORITHM = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/**
 * A PEM private key as PKCS#8 DER. GitHub gives an app's key as PKCS#1 ("BEGIN RSA PRIVATE KEY"), which
 * Web Crypto doesn't read, so that one is wrapped: SEQUENCE { INTEGER 0, rsaEncryption, OCTET STRING key }.
 * Escaped newlines (a key pasted into one line of a secret) are accepted.
 */
export function pkcs8FromPem(pem: string): Uint8Array {
  const text = pem.replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(text);
  if (!m) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const body = fromB64(m[2]!.replace(/\s+/g, ""));
  if (!m[1]) return body;
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const key = der(0x04, body);
  const inner = new Uint8Array(version.length + RSA_ALGORITHM.length + key.length);
  inner.set(version, 0);
  inner.set(RSA_ALGORITHM, version.length);
  inner.set(key, version.length + RSA_ALGORITHM.length);
  return der(0x30, inner);
}

/** The app's JWT (RS256), valid for 9 minutes; issued a minute in the past for clock drift, as GitHub suggests. */
export async function appJwt(app: Pick<GitHubAppConfig, "appId" | "privateKey">, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8FromPem(app.privateKey) as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "RS256", typ: "JWT" });
  const body = enc({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: app.appId });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- API calls

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface JitRunner {
  runnerId: number;
  /** The runner's whole configuration and credentials: never logged or stored. */
  encodedJitConfig: string;
}

export interface GitHubInstallation {
  id: number;
  login: string;
  type: string;
}

export interface GitHubRunnerState {
  busy: boolean;
  status: string;
}

/** The calls Diffinery makes to GitHub for runners. One per Durable Object, which keeps installation tokens for their hour. */
export class GitHubAppClient {
  private tokens = new Map<number, { token: string; expires: number }>();

  constructor(
    readonly app: GitHubAppConfig,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${this.app.apiUrl}/${path.replace(/^\//, "")}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: auth,
        "x-github-api-version": "2022-11-28",
        "user-agent": "Diffinery",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        /* not JSON */
      }
      throw new GitHubApiError(res.status, `GitHub answered ${res.status} to ${method} ${path.split("?")[0]}: ${message}`);
    }
    return JSON.parse(text) as T;
  }

  private async asApp<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.call<T>(method, path, `Bearer ${await appJwt(this.app)}`, body);
  }

  /** An installation token, reused until 5 minutes before it expires. */
  private async installationToken(installationId: number): Promise<string> {
    const kept = this.tokens.get(installationId);
    if (kept && kept.expires - Date.now() > 5 * 60_000) return kept.token;
    const r = await this.asApp<{ token: string; expires_at: string }>("POST", `app/installations/${installationId}/access_tokens`, {});
    this.tokens.set(installationId, { token: r.token, expires: Date.parse(r.expires_at) || Date.now() + 50 * 60_000 });
    return r.token;
  }

  private async asInstallation<T>(installationId: number, method: string, path: string, body?: unknown): Promise<T> {
    return this.call<T>(method, path, `Bearer ${await this.installationToken(installationId)}`, body);
  }

  /** The GitHub account an installation is on. */
  async installation(installationId: number): Promise<GitHubInstallation> {
    const r = await this.asApp<{ id: number; account: { login: string; type: string } | null }>("GET", `app/installations/${installationId}`);
    return { id: r.id, login: r.account?.login ?? "", type: r.account?.type ?? "User" };
  }

  /**
   * Registers a just-in-time runner in the repository for one job: GitHub gives it to a queued job whose
   * labels it has, and removes it once that job ends. Runner group 1 is a repository's default group.
   */
  async jitRunner(installationId: number, repo: string, name: string, labels: string[]): Promise<JitRunner> {
    const r = await this.asInstallation<{ runner: { id: number }; encoded_jit_config: string }>(installationId, "POST", `repos/${repo}/actions/runners/generate-jitconfig`, { name, runner_group_id: 1, labels });
    return { runnerId: r.runner.id, encodedJitConfig: r.encoded_jit_config };
  }

  /** Whether a registered runner is running a job; null once GitHub no longer has it. */
  async runner(installationId: number, repo: string, runnerId: number): Promise<GitHubRunnerState | null> {
    try {
      return await this.asInstallation<GitHubRunnerState>(installationId, "GET", `repos/${repo}/actions/runners/${runnerId}`);
    } catch (e) {
      if (e instanceof GitHubApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** Removes a runner that never took a job (one that did removes itself). */
  async removeRunner(installationId: number, repo: string, runnerId: number): Promise<void> {
    try {
      await this.asInstallation<void>(installationId, "DELETE", `repos/${repo}/actions/runners/${runnerId}`);
    } catch (e) {
      if (!(e instanceof GitHubApiError && e.status === 404)) throw e;
    }
  }

  // ---------------------------------------------------------------- a person's GitHub sign-in, to link an installation

  /** Where a person authorizes the app, which proves which installations they can manage. */
  authorizeUrl(redirectUri: string, state: string): string {
    const u = new URL(`${this.app.webUrl}/login/oauth/authorize`);
    u.searchParams.set("client_id", this.app.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("allow_signup", "false");
    return u.toString();
  }

  /** Where a person installs the app; GitHub passes `state` on to the app's setup URL. */
  installUrl(state: string): string {
    return `${this.app.webUrl}/apps/${encodeURIComponent(this.app.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** Trades the code GitHub sent back for the person's user token (used at once, never kept). */
  async userToken(code: string, redirectUri: string): Promise<string> {
    const res = await this.fetcher(`${this.app.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "Diffinery" },
      body: JSON.stringify({ client_id: this.app.clientId, client_secret: this.app.clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(30_000),
    });
    const r = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!r.access_token) throw new GitHubApiError(422, `GitHub did not sign you in: ${r.error_description ?? "no access token"}`);
    return r.access_token;
  }

  /** The app's installations the signed-in GitHub user can manage (at most 500). */
  async userInstallations(userToken: string): Promise<GitHubInstallation[]> {
    const out: GitHubInstallation[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = await this.call<{ installations: Array<{ id: number; account: { login: string; type: string } | null }> }>("GET", `user/installations?per_page=100&page=${page}`, `Bearer ${userToken}`);
      out.push(...r.installations.map((i) => ({ id: i.id, login: i.account?.login ?? "", type: i.account?.type ?? "User" })));
      if (r.installations.length < 100) break;
    }
    return out;
  }
}
