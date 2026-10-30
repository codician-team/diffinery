import type { DiffineryEvent } from "@diffinery/shared";
import type { RepoDO } from "./repo/RepoDO.js";
import type { SchedulerDO } from "./scheduler.js";
import type { ComposeDO } from "./compose.js";
import type { ImportContainer } from "./imports/container.js";
import type { RunnerContainer, SandboxContainer } from "./runner/containers.js";
import type { MailJob } from "./mail/types.js";
import type { ProjectDO } from "./agentic/ProjectDO.js";
import type { ExportJob } from "./accounts/export.js";
import type { DeletionCleanup } from "./accounts/lifecycle.js";
import type { GitHubRunnersDO } from "./github-runners/GitHubRunnersDO.js";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  EVENTS: Queue<DiffineryEvent>;
  REPO: DurableObjectNamespace<RepoDO>;
  /** Fires workflow schedules (src/scheduler.ts). */
  SCHEDULER: DurableObjectNamespace<SchedulerDO>;
  /** Joins the blocks of large artifact and cache uploads, a step per object (src/compose.ts); without it RepoDO does. */
  COMPOSE?: DurableObjectNamespace<ComposeDO>;
  /** Minutes between scheduler ticks, 1 to 60 (default 5, GitHub's shortest schedule interval). */
  SCHEDULE_TICK_MINUTES?: string;
  /** End-to-end tests only: how long one minute of an environment's wait timer lasts, in ms (default 60000). */
  WAIT_TIMER_MINUTE_MS?: string;
  /** End-to-end tests only: how often a running agent task is polled, in ms (default 3000, at least 200). */
  AGENT_POLL_MS?: string;
  /** End-to-end tests only: how often open web terminals are checked, in ms (default 60000, at least 2000). */
  TERMINAL_POLL_MS?: string;
  RUNNER: DurableObjectNamespace<RunnerContainer>;
  /** Smaller hosted runners (runner/sizes.ts); a deployment without one runs those jobs on RUNNER. */
  RUNNER_MEDIUM?: DurableObjectNamespace<RunnerContainer>;
  RUNNER_SMALL?: DurableObjectNamespace<RunnerContainer>;
  RUNNER_TINY?: DurableObjectNamespace<RunnerContainer>;
  SANDBOX: DurableObjectNamespace<SandboxContainer>;
  /** GitHub jobs on Diffinery runners, one per paying account (github-runners/GitHubRunnersDO.ts). */
  GITHUB_RUNNERS?: DurableObjectNamespace<GitHubRunnersDO>;
  /** One per repository: its agent tasks (agentic/ProjectDO.ts). */
  PROJECT: DurableObjectNamespace<ProjectDO>;
  /**
   * Local development and end-to-end tests only: sandboxes run in one `agent.mjs --sandbox-pool`
   * process at this URL instead of Cloudflare Containers (which don't run under `wrangler dev`).
   */
  SANDBOX_POOL_URL?: string;
  SANDBOX_POOL_SECRET?: string;
  /** `off` switches web terminals (agentic/terminals.ts) off for the whole instance; on by default. */
  TERMINALS?: string;
  /** Local development and end-to-end tests only: where the model proxy forwards instead of the providers' APIs. */
  MODEL_UPSTREAM_ANTHROPIC?: string;
  MODEL_UPSTREAM_OPENAI?: string;
  MODEL_UPSTREAM_OPENROUTER?: string;
  RUN_WORKFLOW: Workflow<{ repoId: string; runId: string }>;
  /** Cloudflare Email Sending. Missing when sending isn't set up; emails are then logged as skipped. */
  EMAIL?: SendEmail;
  /** Request rate limits (lib/rate-limit.ts); none in local development. */
  RL_AUTH?: RateLimit;
  RL_ANON?: RateLimit;
  RL_ACCOUNT?: RateLimit;
  RL_CREATE?: RateLimit;
  /** Model requests through the proxy, per paying person (agentic/proxy.ts). */
  RL_MODEL?: RateLimit;
  /** Email jobs, sent by the queue consumer in mail/send.ts. */
  MAIL?: Queue<MailJob>;
  IMPORT_WORKFLOW: Workflow<{ importId: string }>;
  /** Account exports and the background part of deleting an account (accounts/workflow.ts). Missing in unit tests, which run the work at once. */
  ACCOUNT_WORKFLOW?: Workflow<ExportJob | DeletionCleanup>;
  /** GitHub imports copy Git data in this container (absent under `wrangler dev`). */
  IMPORTER?: DurableObjectNamespace<ImportContainer>;
  /** "external": an import agent started outside the Worker claims the Git transfer (local development and tests). */
  IMPORT_GIT_AGENT?: string;
  /** Default per-account quotas (lib/quotas.ts); -1 is unlimited. Site administrators override them per account. */
  QUOTA_HOSTED_MINUTES?: string;
  QUOTA_HOSTED_JOBS?: string;
  QUOTA_SANDBOXES?: string;
  QUOTA_REPOSITORIES?: string;
  QUOTA_STORAGE_BYTES?: string;
  /** Hosted Actions jobs the whole instance runs at once (lib/quotas.ts fleetLimits); keep it under the runner classes' max_instances. */
  HOSTED_JOBS_LIMIT?: string;
  /** "web": hosted jobs and sandboxes reach only HTTP, HTTPS and DNS (lib/egress.ts). Anything else, or unset, is open. */
  EGRESS?: string;
  /** Largest source repository an import will take, in KB (GitHub `size`); default 10 GB. */
  IMPORT_MAX_REPO_KB?: string;
  /** Optional GitHub OAuth app, for linking an account through the web flow instead of a gist. */
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /**
   * The GitHub App that lets GitHub repositories run jobs on this Diffinery's hosted runners
   * (github-runners/github.ts, docs/actions/github-runners.md). The feature is off until all of
   * GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID and the secrets GITHUB_APP_CLIENT_SECRET,
   * GITHUB_APP_PRIVATE_KEY and GITHUB_APP_WEBHOOK_SECRET are set.
   */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  /** A GitHub Enterprise Server origin for the app; default https://github.com. */
  GITHUB_APP_URL?: string;

  /** Canonical origin, e.g. https://diffinery.com */
  PUBLIC_URL: string;
  /** Sender address for every email, e.g. notifications@diffinery.com. */
  MAIL_FROM?: string;
  /**
   * More places security researchers can report vulnerabilities, served in /.well-known/security.txt
   * after the instance's own report form (/security/report): an email address or an https URL, several
   * separated by commas.
   */
  SECURITY_CONTACT?: string;
  /**
   * The proof record served at /.well-known/mcp-registry-auth (`v=MCPv1; k=ed25519; p=...`), so the
   * instance's MCP server can be published to the official MCP registry under its own domain.
   */
  MCP_REGISTRY_AUTH?: string;
  /** Comma-separated emails that become site admins on first sign-in (logins are ignored). Deployed by scripts/bootstrap-admins.sh. */
  BOOTSTRAP_ADMINS: string;
  /** e.g. example.cloudflareaccess.com — empty disables Access verification. */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application audience tag. */
  ACCESS_AUD: string;
  /** Artifact storage per repository in bytes (live artifacts plus uploads in progress); default 10 GiB. */
  ARTIFACT_QUOTA_BYTES?: string;
  /** The runner image the deploy pointed containers at, as jobs report it (scripts/render-config.mjs). */
  RUNNER_IMAGE?: string;
  /**
   * "off" stops telling search engines about new and changed public pages through IndexNow (web/indexnow.ts).
   * Unset, it is on whenever PUBLIC_URL is a public https origin and MASTER_KEY is set.
   */
  INDEXNOW?: string;
  /** The deployed version (wrangler.jsonc version_metadata): IndexNow checks the site's pages once per new version. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** Local development only: act as this email when Access is not configured. */
  DEV_AUTH?: string;
  /**
   * "open": anyone can create an account at /signup by confirming an emailed code (auth/signup.ts).
   * Anything else, or unset, keeps the instance invite-only.
   */
  SIGNUP?: string;
  /**
   * Cloudflare Turnstile widget on the sign-up page and the security report form; open sign-up and
   * reports from people who aren't signed in need it and TURNSTILE_SECRET outside local development.
   */
  TURNSTILE_SITE_KEY?: string;

  /** Secret: base64 32 bytes; root key for envelope encryption of secrets and for the links and tokens Diffinery signs. */
  MASTER_KEY?: string;
  /**
   * Secret, set only while rotating MASTER_KEY: the key it replaced. Secrets sealed and links or tokens
   * signed with it keep working; everything new uses MASTER_KEY (lib/crypto.ts).
   */
  MASTER_KEY_PREV?: string;
  /** Secret: ES256 private JWK (JSON) used to sign OIDC tokens for jobs. */
  OIDC_PRIVATE_KEY?: string;
  /** Secret: signs bounce and complaint events posted to /-/email/events (mail/events.ts); unset, that endpoint is off. */
  MAIL_EVENTS_SECRET?: string;
  /** Secret: Cloudflare Turnstile secret key, to check the widget on the sign-up page and the security report form (siteverify). */
  TURNSTILE_SECRET?: string;
  /** Secret: the GitHub App's client secret, to check who links an installation. */
  GITHUB_APP_CLIENT_SECRET?: string;
  /** Secret: the GitHub App's private key (PEM, as GitHub gives it). */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Secret: the GitHub App's webhook secret, which signs deliveries to /-/github/webhook. */
  GITHUB_APP_WEBHOOK_SECRET?: string;
  /** Optional GitHub Enterprise host (e.g. github.example.com) the importer may download release assets from. */
  IMPORT_GHE_HOST?: string;
}

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/**
 * Bindings celld (the open-source Workers runtime, docs/self-hosting/celld.md) has no equivalent for:
 * scripts/celld-config.mjs leaves them out, so each must stay optional here and the Worker must run
 * without it. The celld unit test checks this list against what the script leaves out.
 */
export const CELLD_ABSENT_BINDINGS = ["EMAIL", "RL_AUTH", "RL_ANON", "RL_ACCOUNT", "RL_CREATE", "RL_MODEL", "CF_VERSION_METADATA"] as const satisfies ReadonlyArray<OptionalKeys<Env>>;
