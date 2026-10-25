import type { Env } from "../env.js";
import { decryptAndReseal, encryptSecret } from "../lib/crypto.js";
import { HttpError, now } from "../lib/util.js";
import { enqueueMail } from "../mail/send.js";

/**
 * People's own model API keys for agent tasks. Diffinery only provides the
 * ability: each person brings their own key, under their own account with the
 * provider and the provider's terms, after opting in per provider.
 *
 * Keys are write-only. Nothing returns one; the model proxy (proxy.ts)
 * decrypts a key only to forward a request of that person's running task, so a
 * key never reaches a sandbox.
 */

export type Provider = "anthropic" | "openai" | "openrouter";

export interface ProviderInfo {
  id: Provider;
  name: string;
  /** Where people create a key. */
  keysUrl: string;
  terms: Array<{ label: string; url: string }>;
  /** A loose shape check, to catch pasting the wrong thing. */
  pattern: RegExp;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    keysUrl: "https://console.anthropic.com/settings/keys",
    terms: [
      { label: "Anthropic Commercial Terms of Service", url: "https://www.anthropic.com/legal/commercial-terms" },
      { label: "Anthropic Usage Policy", url: "https://www.anthropic.com/legal/aup" },
    ],
    pattern: /^sk-ant-[A-Za-z0-9_-]{20,400}$/,
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    keysUrl: "https://platform.openai.com/api-keys",
    terms: [
      { label: "OpenAI Terms and Policies", url: "https://openai.com/policies/" },
      { label: "OpenAI Usage Policies", url: "https://openai.com/policies/usage-policies/" },
    ],
    pattern: /^sk-[A-Za-z0-9_-]{20,400}$/,
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    keysUrl: "https://openrouter.ai/settings/keys",
    terms: [
      { label: "OpenRouter Terms of Service", url: "https://openrouter.ai/terms" },
      { label: "OpenRouter Privacy Policy", url: "https://openrouter.ai/privacy" },
    ],
    pattern: /^sk-or-[A-Za-z0-9_-]{20,400}$/,
  },
};

export const isProvider = (p: string): p is Provider => p === "anthropic" || p === "openai" || p === "openrouter";

export interface ModelKeyInfo {
  provider: Provider;
  /** The key's last four characters. */
  hint: string;
  optedInAt: string;
  /** An organization's key (phase 5b): the owner who accepted the provider's terms for it. */
  optedInBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const scope = (accountId: string, provider: Provider) => `model-key:${accountId}:${provider}`;

export class ModelKeys {
  constructor(private env: Env) {}

  async list(accountId: string): Promise<ModelKeyInfo[]> {
    const r = await this.env.DB.prepare("SELECT k.provider, k.hint, k.opted_in_at, a.login AS opted_in_by, k.created_at, k.updated_at FROM model_keys k LEFT JOIN accounts a ON a.id = k.opted_in_by WHERE k.account_id = ? ORDER BY k.provider")
      .bind(accountId)
      .all<{ provider: Provider; hint: string; opted_in_at: string; opted_in_by: string | null; created_at: string; updated_at: string }>();
    return r.results.map((k) => ({ provider: k.provider, hint: k.hint, optedInAt: k.opted_in_at, optedInBy: k.opted_in_by, createdAt: k.created_at, updatedAt: k.updated_at }));
  }

  async providers(accountId: string): Promise<Set<Provider>> {
    return new Set((await this.list(accountId)).map((k) => k.provider));
  }

  /**
   * Save (or replace) a key. The caller has checked that this is the person
   * themselves in a browser session; `optIn` is their acceptance of the notice.
   * For an organization's key (phase 5b), `account` is the organization and `by`
   * the owner accepting the provider's terms for it; every owner is emailed.
   */
  async set(account: { id: string; kind?: string; login?: string }, provider: Provider, key: string, optIn: boolean, by?: { id: string; login: string }): Promise<ModelKeyInfo> {
    const org = account.kind === "org";
    if (!optIn) throw new HttpError(422, org ? `confirm that ${account.login} uses ${PROVIDERS[provider].name} under its own account and its terms` : `confirm that you use ${PROVIDERS[provider].name} under your own account and its terms`);
    const k = key.trim();
    if (!PROVIDERS[provider].pattern.test(k)) throw new HttpError(422, `that doesn't look like an ${PROVIDERS[provider].name} API key`);
    const at = now();
    const ciphertext = await encryptSecret(this.env, scope(account.id, provider), k);
    const hint = k.slice(-4);
    await this.env.DB.prepare(
      "INSERT INTO model_keys (account_id, provider, ciphertext, hint, opted_in_at, opted_in_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, hint = excluded.hint, opted_in_at = excluded.opted_in_at, opted_in_by = excluded.opted_in_by, updated_at = excluded.updated_at",
    )
      .bind(account.id, provider, ciphertext, hint, at, org ? (by?.id ?? null) : null, at, at)
      .run();
    const data = { provider: PROVIDERS[provider].name, hint, ...(org ? { org: account.login, by: by?.login } : {}) };
    const to = org ? (await this.env.DB.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role = 'owner'").bind(account.id).all<{ user_id: string }>()).results.map((r) => r.user_id) : [account.id];
    if (to.length) await enqueueMail(this.env, to.map((accountId) => ({ kind: "model_key_added" as const, data, to: { accountId }, reason: "security_alert" as const, at })));
    return { provider, hint, optedInAt: at, optedInBy: org ? (by?.login ?? null) : null, createdAt: at, updatedAt: at };
  }

  async delete(accountId: string, provider: Provider): Promise<boolean> {
    const r = await this.env.DB.prepare("DELETE FROM model_keys WHERE account_id = ? AND provider = ?").bind(accountId, provider).run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** The key itself: only for the model proxy, inside the request it forwards, while a task this account pays for runs. */
  async reveal(accountId: string, provider: Provider): Promise<string | null> {
    const row = await this.env.DB.prepare("SELECT ciphertext FROM model_keys WHERE account_id = ? AND provider = ?").bind(accountId, provider).first<{ ciphertext: string }>();
    if (!row) return null;
    return decryptAndReseal(this.env, scope(accountId, provider), row.ciphertext, (sealed) =>
      this.env.DB.prepare("UPDATE model_keys SET ciphertext = ? WHERE account_id = ? AND provider = ? AND ciphertext = ?").bind(sealed, accountId, provider, row.ciphertext).run(),
    );
  }
}
