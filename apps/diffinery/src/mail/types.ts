/**
 * Email jobs: what goes on the `diffinery-mail` queue. Every job names one
 * recipient and carries everything its template needs, so a retry renders the
 * same email. Rendering and the settings check happen when the job is sent.
 */

/** Why someone gets an email (shown in the footer and the X-Diffinery-Reason header, like GitHub's X-GitHub-Reason). */
export type Reason =
  | "author"
  | "comment"
  | "mention"
  | "assign"
  | "review_requested"
  | "manual"
  | "state_change"
  | "subscribed"
  | "ci_activity"
  | "security_alert"
  | "your_activity"
  | "invitation"
  | "admin"
  | "account"
  | "signup"
  | "early_access"
  | "contact"
  | "digest";

/**
 * Settings groups. `security` and `account` always send: they protect the
 * account or are the only way to reach someone (invites, sign-in links).
 */
export type Category = "security" | "account" | "participating" | "watching" | "actions" | "repos" | "orgs" | "digest";

export type Recipient = { accountId: string } | { email: string; name?: string };

export interface ThreadData {
  repo: string;
  repoId: string;
  number: number;
  kind: "issue" | "pull";
  title: string;
  event: "opened" | "comment" | "review" | "closed" | "reopened" | "merged" | "assigned" | "review_requested" | "pushed";
  actor: string;
  /** Markdown: the issue or pull request description, the comment or the review body. */
  body?: string;
  /** Review state: APPROVED, CHANGES_REQUESTED or COMMENTED. */
  state?: string;
  stateReason?: string | null;
  /** Link to exactly what happened (a comment anchor, the files tab…). */
  url: string;
  base?: string;
  head?: string;
  intent?: string | null;
  commits?: Array<{ sha: string; message: string }>;
  assignees?: string[];
  reviewers?: string[];
  labels?: string[];
}

export interface RunData {
  repo: string;
  repoId: string;
  runId: string;
  runNumber: number;
  workflow: string;
  title: string;
  conclusion: string;
  event: string;
  branch: string;
  sha: string;
  actor: string;
  url: string;
  jobs: Array<{ name: string; conclusion: string | null; url: string; failure?: string | null }>;
}

/** One line of the morning digest: what it is, where, and a short note (state, who, when). */
export interface DigestItem {
  title: string;
  url: string;
  /** e.g. "acme/website#42". */
  where: string;
  note: string;
  mark: "ok" | "fail" | "dot";
}

export interface DigestSection {
  id: "needs_you" | "deployments" | "agents" | "tasks" | "failures" | "landed" | "releases";
  title: string;
  /** How many there are; `items` holds at most DIGEST_MAX_ITEMS of them. */
  total: number;
  items: DigestItem[];
}

export interface DigestSummary {
  /** The person's local date, e.g. "Wednesday, October 14". */
  date: string;
  counts: { needsYou: number; agents: number; merged: number; failed: number };
  sections: DigestSection[];
  repositories: number;
  incomplete: boolean;
}

export interface DigestData {
  /** "Since the last digest" starts here. */
  since: string;
  /** Today, gathered when the email is sent (deliver in send.ts); a scheduled job carries only `since`. */
  summary?: DigestSummary;
  /** Asked for on Settings → Notifications: sent even when there is nothing to report. */
  now?: boolean;
}

export type MailBody =
  | { kind: "signin_new"; data: { method: "passkey" | "access" | "link"; device: string; ip?: string; location?: string; passkey?: string } }
  | { kind: "passkey_added"; data: { name: string; via?: "settings" | "signin-link" | "invite" } }
  | { kind: "passkey_removed"; data: { name: string } }
  | { kind: "token_created"; data: { name: string; scopes: string[]; agent?: string } }
  | { kind: "token_expiring"; data: { name: string; prefix: string; expiresAt: string; agent?: string } }
  | { kind: "agent_created"; data: { agent: string } }
  | { kind: "model_key_added"; data: { provider: string; hint: string; /** An organization's key (phase 5b), and the owner who saved it. */ org?: string; by?: string } }
  | { kind: "review_limit_reached"; data: { repo: string; limit: number; pr: number } }
  | { kind: "deployment_review_requested"; data: { repo: string; environment: string; workflow: string; runNumber: number; title: string; branch: string; sha: string; requestor: string; url: string } }
  | { kind: "push_bypassed"; data: { repo: string; pusher: string; kinds: string[]; reason: string; refs?: string[] } }
  | { kind: "push_blocked"; data: { repo: string; kinds: string[]; refs?: string[]; paths?: string[] } }
  | { kind: "account_status"; data: { status: "disabled" | "active" | "suspended" | "unsuspended"; reason?: string } }
  | { kind: "account_deleted"; data: { login: string; by?: string; cooldownDays: number } }
  | { kind: "site_admin"; data: { granted: boolean; by: string } }
  | { kind: "export_ready"; data: { url: string; size: number; expiresAt: string } }
  | { kind: "invite"; data: { inviter: string; url: string; org?: string; repo?: string; role: string; expiresAt: string; existing?: boolean } }
  | { kind: "invite_accepted"; data: { login: string; email: string; org?: string; repo?: string } }
  | { kind: "welcome"; data: { login: string } }
  | { kind: "signin_link"; data: { url: string; admin: string; expiresAt: string } }
  | { kind: "signup_code"; data: { code: string; expiresAt: string } }
  | { kind: "signup_attempt"; data: { email: string } }
  | { kind: "email_verify"; data: { email: string; url: string; expiresAt: string } }
  | { kind: "access_request"; data: { email: string; login: string; note: string } }
  /** The double opt-in link for a request at /early-access (lib/early-access.ts). */
  | { kind: "early_access_confirm"; data: { url: string; expiresAt: string } }
  /** Asked again: the request is already confirmed or declined ("waiting"), invited, or the address has an account. */
  /** A one-time link that deletes the address's own request. */
  | { kind: "early_access_remove"; data: { url: string; expiresAt: string } }
  | { kind: "early_access_known"; data: { variant: "waiting" | "invited" | "account"; since: string } }
  | { kind: "security_report"; data: { id: string; summary: string } }
  /**
   * The link that confirms a message sent at /contact by someone who isn't signed in (lib/contact.ts). Never carries
   * what they typed. `topic` is the topic's label, from the form's fixed list.
   */
  | { kind: "contact_confirm"; data: { url: string; expiresAt: string; topic: string } }
  /** A signed-in person's copy of the message they sent at /contact. */
  | { kind: "contact_received"; data: { id: string; topic: string; message: string } }
  /** A confirmed contact message, for each site administrator, with the sender as Reply-To. */
  | { kind: "contact_message"; data: { id: string; name: string; email: string; login: string | null; topic: string; message: string } }
  | { kind: "org_membership"; data: { org: string; role: string | null; previous: string | null; by?: string } }
  | { kind: "repo_access"; data: { repo: string; role: string | null; previous: string | null } }
  | { kind: "repo_created"; data: { repo: string; creator: string; visibility: string; defaultBranch: string; description: string } }
  | { kind: "repo_deleted"; data: { repo: string; actor: string } }
  | { kind: "repo_transferred"; data: { from: string; to: string; actor: string } }
  | { kind: "thread"; data: ThreadData }
  | { kind: "run"; data: RunData }
  | { kind: "test"; data: { by: string } }
  | { kind: "digest"; data: DigestData };

export type MailKind = MailBody["kind"];

export type MailJob = MailBody & {
  to: Recipient;
  reason: Reason;
  /** When the thing happened (ISO). */
  at: string;
  /** Send even when the recipient turned this group off (template samples an admin asked for). */
  force?: boolean;
};

/** Which settings group each kind belongs to (threads depend on the reason). */
export function categoryOf(job: Pick<MailJob, "kind" | "reason">): Category {
  switch (job.kind) {
    case "signin_new":
    case "passkey_added":
    case "passkey_removed":
    case "token_created":
    case "token_expiring":
    case "agent_created":
    case "model_key_added":
    case "push_bypassed":
    case "push_blocked":
    case "account_status":
    case "site_admin":
    // A vulnerability report for the site administrators (lib/security-reports.ts).
    case "security_report":
      return "security";
    case "account_deleted":
    case "export_ready":
    case "invite":
    case "welcome":
    case "signin_link":
    case "signup_code":
    case "signup_attempt":
    case "email_verify":
    // Sent only to the address that was typed, about its own request.
    case "early_access_confirm":
    case "early_access_known":
    case "early_access_remove":
    // The sender's own confirmation link or copy of their message.
    case "contact_confirm":
    case "contact_received":
    // It is about the payer's own model spend, so it always sends.
    case "review_limit_reached":
    case "test":
      return "account";
    case "invite_accepted":
    case "access_request":
    case "contact_message":
    case "org_membership":
      return "orgs";
    case "repo_access":
    case "repo_created":
    case "repo_deleted":
    case "repo_transferred":
      return "repos";
    case "run":
    case "deployment_review_requested":
      return "actions";
    case "thread":
      return job.reason === "subscribed" ? "watching" : "participating";
    case "digest":
      return "digest";
  }
}

/** Kinds that always send, whatever the person's settings. */
export const isMandatory = (c: Category): boolean => c === "security" || c === "account";
