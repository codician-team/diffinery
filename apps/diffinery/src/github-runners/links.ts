import type { Env } from "../env.js";
import { hmacSha256, matchesAnyKey, signingSecrets } from "../lib/crypto.js";
import type { Account, Directory } from "../lib/directory.js";
import { HttpError, b64url, fromB64url, now } from "../lib/util.js";
import { GitHubApiError, GitHubAppClient, githubApp, type GitHubInstallation } from "./github.js";
import type { RunnerJobRow } from "./service.js";

/**
 * Linking a GitHub App installation to the Diffinery account that pays for its jobs. Whoever links one
 * must manage that account (themselves, or an organization they own or administer) and, as GitHub
 * tells the app when they authorize it, be able to manage the installation on GitHub: anyone else could
 * otherwise spend their own minutes on another's jobs, read which jobs a private repository runs, or
 * unlink them.
 *
 * The flow (web/github-runners.tsx): Install on GitHub carries a signed `state` naming the person and the
 * paying account; GitHub returns to the setup URL with the installation id, the state and, with "Request
 * user authorization (OAuth) during installation" on, a code. Without a code the person is sent to authorize
 * the app first. The code becomes a user token, used once to list the installations they can manage. Link
 * existing installations authorizes the app and lists those installations; the person picks one and who pays.
 */

/** Where GitHub sends people back to: the app's setup URL and its callback URL. */
export const SETUP_PATH = "/settings/github-runners/setup";
/** How long a state or a proof is good for. */
const TTL_SECONDS = 3600;

/** What a state or proof says: who started, which account pays, and (once known) the installation. */
interface Claims {
  /** "state" for a flow under way, "proof" once GitHub said the person manages installation i. */
  k: "state" | "proof";
  u: string;
  /** The paying account a state was started for. */
  a?: string;
  i?: number;
  login?: string;
  type?: string;
  x: number;
}

export interface LinkedInstallation {
  id: number;
  account_id: string;
  github_login: string;
  github_type: string;
  linked_by: string;
  linked_at: string;
  suspended_at: string | null;
}

export type SetupResult = { linked: LinkedInstallation } | { redirect: string } | { choose: Array<GitHubInstallation & { proof: string; linkedTo: string | null }>; payer: Account };

export class GitHubRunnerLinks {
  readonly client: GitHubAppClient | null;

  constructor(
    private readonly env: Env,
    private readonly dir: Directory,
    fetcher?: typeof fetch,
  ) {
    const app = githubApp(env);
    this.client = app ? new GitHubAppClient(app, fetcher) : null;
  }

  get enabled(): boolean {
    return !!this.client && !!this.env.GITHUB_RUNNERS;
  }

  private gh(): GitHubAppClient {
    if (!this.enabled) throw new HttpError(404, "GitHub runners are off: this Diffinery has no GitHub App");
    return this.client!;
  }

  private get redirectUri(): string {
    return `${this.env.PUBLIC_URL}${SETUP_PATH}`;
  }

  private secrets(): string[] {
    return signingSecrets(this.env, this.env.DEV_AUTH ? "dev" : null, "MASTER_KEY is not set");
  }

  private async mac(secret: string, payload: string): Promise<string> {
    return b64url(await hmacSha256(secret, `github-runners:${payload}`));
  }

  private async sign(c: Omit<Claims, "x">): Promise<string> {
    const payload = b64url(new TextEncoder().encode(JSON.stringify({ ...c, x: Math.floor(Date.now() / 1000) + TTL_SECONDS })));
    return `${payload}.${await this.mac(this.secrets()[0]!, payload)}`;
  }

  private async open(token: string, kind: Claims["k"], me: Account): Promise<Claims> {
    const [payload, tag] = token.split(".");
    if (!payload || !tag || !(await matchesAnyKey(this.secrets(), tag, (s) => this.mac(s, payload)))) throw new HttpError(422, "this link to GitHub is not valid; start again from Settings → GitHub runners");
    const c = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Claims;
    if (c.k !== kind || c.u !== me.id) throw new HttpError(422, "this link to GitHub was made for someone else; start again from Settings → GitHub runners");
    if (c.x < Date.now() / 1000) throw new HttpError(422, "this link to GitHub has expired; start again from Settings → GitHub runners");
    return c;
  }

  /** The accounts a person may make pay: themselves and the organizations they own or administer. */
  async payers(me: Account): Promise<Account[]> {
    const orgs = (await this.dir.orgsFor(me.id)).filter((o) => o.role === "owner" || o.role === "admin");
    return [me, ...orgs];
  }

  private async payer(me: Account, accountId: string): Promise<Account> {
    const a = (await this.payers(me)).find((p) => p.id === accountId);
    if (!a) throw new HttpError(403, "you can link GitHub runners only to your own account or an organization you own or administer");
    return a;
  }

  /** Install on GitHub: the app's install page, with a state naming who pays. */
  async installUrl(me: Account, accountId: string): Promise<string> {
    const gh = this.gh();
    await this.payer(me, accountId);
    return gh.installUrl(await this.sign({ k: "state", u: me.id, a: accountId }));
  }

  /** Link an installation that already exists: authorize the app, then pick it. */
  async authorizeUrl(me: Account, accountId: string): Promise<string> {
    const gh = this.gh();
    await this.payer(me, accountId);
    return gh.authorizeUrl(this.redirectUri, await this.sign({ k: "state", u: me.id, a: accountId }));
  }

  /**
   * GitHub sent the person back (after installing, or after authorizing the app). A code is only used with a
   * state this person started here (signed, bound to them): one that came without, or with someone else's,
   * could be another GitHub user's, sent to make this person pay for that user's installation.
   */
  async setup(me: Account, q: { installationId: number | null; code: string | null; state: string | null }): Promise<SetupResult> {
    const gh = this.gh();
    // Installed or configured from GitHub itself: authorize, then pick the installation and who pays.
    if (!q.state) return { redirect: gh.authorizeUrl(this.redirectUri, await this.sign({ k: "state", u: me.id, a: me.id })) };
    const claims = await this.open(q.state, "state", me);
    const payer = await this.payer(me, claims.a ?? me.id);
    const installationId = claims.i ?? q.installationId ?? null;
    if (!q.code) {
      if (!installationId) throw new HttpError(422, "GitHub sent no installation; start again from Settings → GitHub runners");
      return { redirect: gh.authorizeUrl(this.redirectUri, await this.sign({ k: "state", u: me.id, a: payer.id, i: installationId })) };
    }
    let mine: GitHubInstallation[];
    try {
      mine = await gh.userInstallations(await gh.userToken(q.code, this.redirectUri));
    } catch (e) {
      throw new HttpError(e instanceof GitHubApiError && e.status < 500 ? 422 : 502, (e as Error).message);
    }
    if (installationId) {
      const inst = mine.find((i) => i.id === installationId);
      if (!inst) throw new HttpError(403, "your GitHub account can't manage that installation of the app; ask an owner of the GitHub organization to link it");
      return { linked: await this.save(me, payer, inst) };
    }
    const linked = new Map<number, string>();
    if (mine.length) {
      const rows = await this.env.DB.prepare(`SELECT g.id, a.login FROM github_installations g JOIN accounts a ON a.id = g.account_id WHERE g.id IN (${mine.map(() => "?").join(",")})`)
        .bind(...mine.map((i) => i.id))
        .all<{ id: number; login: string }>();
      for (const r of rows.results) linked.set(r.id, r.login);
    }
    const choose = await Promise.all(mine.map(async (i) => ({ ...i, linkedTo: linked.get(i.id) ?? null, proof: await this.sign({ k: "proof", u: me.id, i: i.id, login: i.login, type: i.type }) })));
    return { choose, payer };
  }

  /** Links an installation the person picked (with the proof setup made that they manage it) to an account they pick. */
  async linkWithProof(me: Account, proof: string, accountId: string): Promise<LinkedInstallation> {
    this.gh();
    const c = await this.open(proof, "proof", me);
    return this.save(me, await this.payer(me, accountId), { id: c.i!, login: c.login ?? "", type: c.type ?? "User" });
  }

  private async save(me: Account, payer: Account, inst: GitHubInstallation): Promise<LinkedInstallation> {
    const before = await this.env.DB.prepare("SELECT account_id FROM github_installations WHERE id = ?").bind(inst.id).first<{ account_id: string }>();
    await this.env.DB.prepare(
      "INSERT INTO github_installations (id, account_id, github_login, github_type, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, github_login = excluded.github_login, github_type = excluded.github_type, linked_by = excluded.linked_by, linked_at = excluded.linked_at",
    )
      .bind(inst.id, payer.id, inst.login, inst.type, me.id, now())
      .run();
    await this.dir.audit({ actorId: me.id, actorLogin: me.login, action: "github_runners.link", target: payer.login, detail: { installation: inst.id, github: inst.login, ...(before && before.account_id !== payer.id ? { from: before.account_id } : {}) } });
    return (await this.env.DB.prepare("SELECT * FROM github_installations WHERE id = ?").bind(inst.id).first<LinkedInstallation>())!;
  }

  /** Unlinks an installation: its queued jobs get no runner; runners already started finish their jobs. */
  async unlink(me: Account, installationId: number): Promise<void> {
    const row = await this.env.DB.prepare("SELECT * FROM github_installations WHERE id = ?").bind(installationId).first<LinkedInstallation>();
    if (!row) throw new HttpError(404, "that installation isn't linked");
    const payer = await this.payer(me, row.account_id);
    await this.env.DB.prepare("DELETE FROM github_installations WHERE id = ?").bind(installationId).run();
    await this.env.DB.prepare("UPDATE github_runner_jobs SET status = 'skipped', message = 'The GitHub installation was unlinked', ended_at = ? WHERE installation_id = ? AND status = 'queued'").bind(now(), installationId).run();
    await this.dir.audit({ actorId: me.id, actorLogin: me.login, action: "github_runners.unlink", target: payer.login, detail: { installation: installationId, github: row.github_login } });
  }

  /** The person's paying accounts with their linked installations and recent runner jobs, for the settings page. */
  async overview(me: Account, jobs = 30): Promise<Array<{ account: Account; installations: LinkedInstallation[]; jobs: RunnerJobRow[] }>> {
    const payers = await this.payers(me);
    return Promise.all(
      payers.map(async (account) => {
        const [installations, recent] = await Promise.all([
          this.env.DB.prepare("SELECT * FROM github_installations WHERE account_id = ? ORDER BY github_login").bind(account.id).all<LinkedInstallation>(),
          this.env.DB.prepare("SELECT * FROM github_runner_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?").bind(account.id, jobs).all<RunnerJobRow>(),
        ]);
        return { account, installations: installations.results, jobs: recent.results };
      }),
    );
  }
}
