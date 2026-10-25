import type { Json } from "./runner.js";
/** Events flowing through the `events` queue. Payload shapes follow GitHub webhooks where practical. */
export type DiffineryEvent =
  | { type: "push"; repoId: string; owner: string; repo: string; ref: string; before: string; after: string; actor: Actor; forced: boolean; created: boolean; deleted: boolean; at: string }
  | { type: "pull_request"; action: "opened" | "synchronize" | "closed" | "reopened" | "edited" | "merged" | "enqueued" | "dequeued" | "assigned" | "review_requested" | "ready_for_review" | "converted_to_draft" | "auto_merge_enabled" | "auto_merge_disabled"; repoId: string; owner: string; repo: string; number: number; headRef: string; headSha: string; baseRef: string; actor: Actor; at: string; /** Logins newly assigned (assigned). */ assignees?: string[]; /** Logins newly asked to review (review_requested). */ reviewers?: string[] }
  | { type: "issues"; action: "opened" | "closed" | "reopened" | "edited" | "assigned"; repoId: string; owner: string; repo: string; number: number; actor: Actor; at: string; /** Logins newly assigned (assigned). */ assignees?: string[] }
  | { type: "issue_comment"; action: "created"; repoId: string; owner: string; repo: string; number: number; commentId: string; actor: Actor; at: string }
  | { type: "pull_request_review"; action: "submitted"; repoId: string; owner: string; repo: string; number: number; state: string; actor: Actor; at: string }
  | { type: "workflow_run"; action: "requested" | "completed"; repoId: string; owner: string; repo: string; runId: string; conclusion?: string; actor: Actor; at: string }
  | { type: "workflow_dispatch"; repoId: string; owner: string; repo: string; ref: string; workflow: string; inputs: Record<string, Json>; actor: Actor; at: string }
  /** GitHub-shaped events whose webhook payload is built where they happen (`payload` is merged into the body). */
  | { type: "release" | "status" | "deployment" | "deployment_status" | "deployment_review" | "repository_dispatch"; action?: string; repoId: string; owner: string; repo: string; payload: Record<string, Json>; actor: Actor; at: string }
  | { type: "audit"; action: string; actor: Actor; target?: string; detail?: Record<string, Json>; at: string };

export interface Actor {
  id: string;
  login: string;
  kind: "user" | "agent" | "system";
  /** For agents: the human or team that owns the agent. */
  onBehalfOf?: string;
}
