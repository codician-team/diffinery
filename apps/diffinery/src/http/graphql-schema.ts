/**
 * The part of GitHub's GraphQL schema (https://docs.github.com/graphql) that Diffinery answers at
 * /api/graphql. Names, types and enum values are GitHub's, so the GitHub CLI and tools built on it
 * (Claude Code's pull request badge, `gh pr view`, `gh pr checks`, `gh pr list`, `gh pr status`,
 * `gh pr create`, `gh pr merge`, `gh pr ready`, `gh pr comment`) read and change Diffinery as a
 * GitHub Enterprise Server host, and `gh issue list`, `view`, `create`, `comment`, `close`, `reopen`,
 * `edit` and `status` work on its issues. The mutations are the pull request and issue ones gh uses;
 * everything else changes through the REST API.
 */
export const SCHEMA_SDL = /* GraphQL */ `
"""Ids from the REST API, which can be wider than GraphQL's 32-bit Int (GitHub types these as Int)."""
scalar BigInt
scalar DateTime
scalar URI
scalar GitObjectID
scalar HTML
scalar GitTimestamp

schema { query: Query, mutation: Mutation }

type Mutation {
  addAssigneesToAssignable(input: AddAssigneesToAssignableInput!): AddAssigneesToAssignablePayload
  addComment(input: AddCommentInput!): AddCommentPayload
  addLabelsToLabelable(input: AddLabelsToLabelableInput!): AddLabelsToLabelablePayload
  closePullRequest(input: ClosePullRequestInput!): ClosePullRequestPayload
  closeIssue(input: CloseIssueInput!): CloseIssuePayload
  convertPullRequestToDraft(input: ConvertPullRequestToDraftInput!): ConvertPullRequestToDraftPayload
  createIssue(input: CreateIssueInput!): CreateIssuePayload
  createPullRequest(input: CreatePullRequestInput!): CreatePullRequestPayload
  disablePullRequestAutoMerge(input: DisablePullRequestAutoMergeInput!): DisablePullRequestAutoMergePayload
  enablePullRequestAutoMerge(input: EnablePullRequestAutoMergeInput!): EnablePullRequestAutoMergePayload
  markPullRequestReadyForReview(input: MarkPullRequestReadyForReviewInput!): MarkPullRequestReadyForReviewPayload
  mergePullRequest(input: MergePullRequestInput!): MergePullRequestPayload
  removeAssigneesFromAssignable(input: RemoveAssigneesFromAssignableInput!): RemoveAssigneesFromAssignablePayload
  removeLabelsFromLabelable(input: RemoveLabelsFromLabelableInput!): RemoveLabelsFromLabelablePayload
  reopenIssue(input: ReopenIssueInput!): ReopenIssuePayload
  reopenPullRequest(input: ReopenPullRequestInput!): ReopenPullRequestPayload
  requestReviews(input: RequestReviewsInput!): RequestReviewsPayload
  updateIssue(input: UpdateIssueInput!): UpdateIssuePayload
  updatePullRequest(input: UpdatePullRequestInput!): UpdatePullRequestPayload
}

input CreateIssueInput {
  assigneeIds: [ID!]
  body: String
  clientMutationId: String
  issueTemplate: String
  labelIds: [ID!]
  milestoneId: ID
  projectIds: [ID!]
  repositoryId: ID!
  title: String!
}
type CreateIssuePayload { clientMutationId: String, issue: Issue }

input UpdateIssueInput {
  assigneeIds: [ID!]
  body: String
  clientMutationId: String
  id: ID!
  labelIds: [ID!]
  milestoneId: ID
  projectIds: [ID!]
  state: IssueState
  title: String
}
type UpdateIssuePayload { actor: Actor, clientMutationId: String, issue: Issue }

input CloseIssueInput { clientMutationId: String, duplicateIssueId: ID, issueId: ID!, stateReason: IssueClosedStateReason }
type CloseIssuePayload { clientMutationId: String, issue: Issue }
input ReopenIssueInput { clientMutationId: String, issueId: ID! }
type ReopenIssuePayload { clientMutationId: String, issue: Issue }

input CreatePullRequestInput {
  baseRefName: String!
  body: String
  clientMutationId: String
  draft: Boolean = false
  headRefName: String!
  headRepositoryId: ID
  maintainerCanModify: Boolean = true
  repositoryId: ID!
  title: String!
}
type CreatePullRequestPayload { clientMutationId: String, pullRequest: PullRequest }

input UpdatePullRequestInput {
  assigneeIds: [ID!]
  baseRefName: String
  body: String
  clientMutationId: String
  labelIds: [ID!]
  maintainerCanModify: Boolean
  milestoneId: ID
  projectIds: [ID!]
  pullRequestId: ID!
  state: PullRequestUpdateState
  title: String
}
enum PullRequestUpdateState { OPEN CLOSED }
type UpdatePullRequestPayload { actor: Actor, clientMutationId: String, pullRequest: PullRequest }

input ClosePullRequestInput { clientMutationId: String, pullRequestId: ID! }
type ClosePullRequestPayload { clientMutationId: String, pullRequest: PullRequest }
input ReopenPullRequestInput { clientMutationId: String, pullRequestId: ID! }
type ReopenPullRequestPayload { clientMutationId: String, pullRequest: PullRequest }
input MarkPullRequestReadyForReviewInput { clientMutationId: String, pullRequestId: ID! }
type MarkPullRequestReadyForReviewPayload { clientMutationId: String, pullRequest: PullRequest }
input ConvertPullRequestToDraftInput { clientMutationId: String, pullRequestId: ID! }
type ConvertPullRequestToDraftPayload { clientMutationId: String, pullRequest: PullRequest }

input EnablePullRequestAutoMergeInput {
  authorEmail: String
  clientMutationId: String
  commitBody: String
  commitHeadline: String
  expectedHeadOid: GitObjectID
  mergeMethod: PullRequestMergeMethod = MERGE
  pullRequestId: ID!
}
type EnablePullRequestAutoMergePayload { actor: Actor, clientMutationId: String, pullRequest: PullRequest }
input DisablePullRequestAutoMergeInput { clientMutationId: String, pullRequestId: ID! }
type DisablePullRequestAutoMergePayload { actor: Actor, clientMutationId: String, pullRequest: PullRequest }

input MergePullRequestInput {
  authorEmail: String
  clientMutationId: String
  commitBody: String
  commitHeadline: String
  expectedHeadOid: GitObjectID
  mergeMethod: PullRequestMergeMethod = MERGE
  pullRequestId: ID!
}
type MergePullRequestPayload { actor: Actor, clientMutationId: String, pullRequest: PullRequest }

input AddCommentInput { body: String!, clientMutationId: String, subjectId: ID! }
type IssueCommentEdge { cursor: String!, node: IssueComment }
type AddCommentPayload { clientMutationId: String, commentEdge: IssueCommentEdge, subject: Node }

input AddLabelsToLabelableInput { clientMutationId: String, labelableId: ID!, labelIds: [ID!]! }
type AddLabelsToLabelablePayload { clientMutationId: String, labelable: Labelable }
input RemoveLabelsFromLabelableInput { clientMutationId: String, labelableId: ID!, labelIds: [ID!]! }
type RemoveLabelsFromLabelablePayload { clientMutationId: String, labelable: Labelable }
input AddAssigneesToAssignableInput { clientMutationId: String, assignableId: ID!, assigneeIds: [ID!]! }
type AddAssigneesToAssignablePayload { clientMutationId: String, assignable: Assignable }
input RemoveAssigneesFromAssignableInput { clientMutationId: String, assignableId: ID!, assigneeIds: [ID!]! }
type RemoveAssigneesFromAssignablePayload { clientMutationId: String, assignable: Assignable }

input RequestReviewsInput {
  clientMutationId: String
  pullRequestId: ID!
  teamIds: [ID!]
  union: Boolean = false
  userIds: [ID!]
}
type RequestReviewsPayload { actor: Actor, clientMutationId: String, pullRequest: PullRequest }

type Query {
  "The signed-in account."
  viewer: User!
  "A repository by owner and name."
  repository(owner: String!, name: String!, followRenames: Boolean = true): Repository
  "An account by login."
  user(login: String!): User
  "Request budget, reported as GitHub does. Diffinery limits requests per account rather than by query cost."
  rateLimit(dryRun: Boolean = false): RateLimit
  "A repository, issue or pull request by its global id."
  node(id: ID!): Node
  nodes(ids: [ID!]!): [Node]!
  "Issues or pull requests in one repository (the query needs a repo: qualifier), as \`gh pr status\` and \`gh issue list --search\` ask for them."
  search(query: String!, type: SearchType!, first: Int, last: Int, after: String, before: String): SearchResultItemConnection!
}

enum SearchType { ISSUE ISSUE_ADVANCED REPOSITORY USER DISCUSSION }
union SearchResultItem = Issue | PullRequest
type SearchResultItemEdge { cursor: String!, node: SearchResultItem }
type SearchResultItemConnection {
  edges: [SearchResultItemEdge]
  issueCount: Int!
  nodes: [SearchResultItem]
  pageInfo: PageInfo!
  repositoryCount: Int!
  userCount: Int!
}

enum ReactionContent { THUMBS_UP THUMBS_DOWN LAUGH HOORAY CONFUSED HEART ROCKET EYES }
type ReactingUserConnection { totalCount: Int! }
type ReactionGroup {
  content: ReactionContent!
  users(first: Int, last: Int, after: String, before: String): ReactingUserConnection!
  viewerHasReacted: Boolean!
}

type RateLimit {
  cost: Int!
  limit: Int!
  nodeCount: Int!
  remaining: Int!
  resetAt: DateTime!
  used: Int!
}

type PageInfo {
  endCursor: String
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
}

interface Node { id: ID! }

interface Labelable {
  labels(first: Int, last: Int, after: String, before: String): LabelConnection
}

interface Assignable {
  assignees(first: Int, last: Int, after: String, before: String): UserConnection!
}

interface Actor {
  avatarUrl(size: Int): URI!
  login: String!
  resourcePath: URI!
  url: URI!
}

interface RepositoryOwner {
  avatarUrl(size: Int): URI!
  id: ID!
  login: String!
  resourcePath: URI!
  url: URI!
}

type User implements Node & Actor & RepositoryOwner {
  avatarUrl(size: Int): URI!
  databaseId: BigInt
  email: String!
  id: ID!
  isBot: Boolean!
  login: String!
  name: String
  resourcePath: URI!
  url: URI!
}

type Organization implements Node & Actor & RepositoryOwner {
  avatarUrl(size: Int): URI!
  databaseId: BigInt
  id: ID!
  login: String!
  name: String
  resourcePath: URI!
  url: URI!
}

type Bot implements Node & Actor {
  avatarUrl(size: Int): URI!
  databaseId: BigInt
  id: ID!
  login: String!
  resourcePath: URI!
  url: URI!
}

"Someone brought over by a GitHub import who has no Diffinery account."
type Mannequin implements Node & Actor {
  avatarUrl(size: Int): URI!
  id: ID!
  login: String!
  resourcePath: URI!
  url: URI!
}

enum RepositoryPermission { ADMIN MAINTAIN WRITE TRIAGE READ }
enum RepositoryVisibility { PRIVATE PUBLIC INTERNAL }
enum PullRequestState { OPEN CLOSED MERGED }
enum IssueState { OPEN CLOSED }
enum IssueStateReason { COMPLETED DUPLICATE NOT_PLANNED REOPENED }
enum IssueClosedStateReason { COMPLETED DUPLICATE NOT_PLANNED }
input IssueFilters {
  assignee: String
  createdBy: String
  labels: [String!]
  mentioned: String
  milestone: String
  milestoneNumber: String
  since: DateTime
  states: [IssueState!]
  viewerSubscribed: Boolean = false
}
enum OrderDirection { ASC DESC }
enum IssueOrderField { CREATED_AT UPDATED_AT COMMENTS }
input IssueOrder { field: IssueOrderField!, direction: OrderDirection! }
enum LabelOrderField { NAME CREATED_AT }
input LabelOrder { field: LabelOrderField!, direction: OrderDirection! }
enum MilestoneState { OPEN CLOSED }
enum MilestoneOrderField { DUE_DATE CREATED_AT UPDATED_AT NUMBER }
input MilestoneOrder { field: MilestoneOrderField!, direction: OrderDirection! }
enum PullRequestReviewDecision { CHANGES_REQUESTED APPROVED REVIEW_REQUIRED }
enum PullRequestReviewState { PENDING COMMENTED APPROVED CHANGES_REQUESTED DISMISSED }
enum MergeableState { MERGEABLE CONFLICTING UNKNOWN }
enum MergeStateStatus { DIRTY UNKNOWN BLOCKED BEHIND DRAFT UNSTABLE HAS_HOOKS CLEAN }
enum PullRequestMergeMethod { MERGE SQUASH REBASE }
enum StatusState { EXPECTED ERROR FAILURE PENDING SUCCESS }
enum CheckStatusState { REQUESTED QUEUED IN_PROGRESS COMPLETED WAITING PENDING }
enum CheckConclusionState { ACTION_REQUIRED TIMED_OUT CANCELLED FAILURE SUCCESS NEUTRAL SKIPPED STARTUP_FAILURE STALE }
enum CheckRunState { REQUESTED QUEUED IN_PROGRESS COMPLETED WAITING PENDING ACTION_REQUIRED TIMED_OUT CANCELLED FAILURE SUCCESS NEUTRAL SKIPPED STARTUP_FAILURE STALE }
enum PatchStatus { ADDED DELETED RENAMED COPIED MODIFIED CHANGED }

type Repository implements Node {
  assignableUsers(first: Int, last: Int, after: String, before: String, query: String): UserConnection!
  createdAt: DateTime!
  databaseId: BigInt
  defaultBranchRef: Ref
  deleteBranchOnMerge: Boolean!
  description: String
  hasDiscussionsEnabled: Boolean!
  hasIssuesEnabled: Boolean!
  hasProjectsEnabled: Boolean!
  hasWikiEnabled: Boolean!
  homepageUrl: URI
  id: ID!
  isArchived: Boolean!
  isEmpty: Boolean!
  issue(number: Int!): Issue
  issueOrPullRequest(number: Int!): IssueOrPullRequest
  issues(first: Int, last: Int, after: String, before: String, states: [IssueState!], labels: [String!], orderBy: IssueOrder, filterBy: IssueFilters): IssueConnection!
  isFork: Boolean!
  isInOrganization: Boolean!
  isLocked: Boolean!
  isMirror: Boolean!
  isPrivate: Boolean!
  isTemplate: Boolean!
  label(name: String!): Label
  labels(first: Int, last: Int, after: String, before: String, query: String, orderBy: LabelOrder): LabelConnection
  mentionableUsers(first: Int, last: Int, after: String, before: String, query: String): UserConnection!
  mergeCommitAllowed: Boolean!
  milestones(first: Int, last: Int, after: String, before: String, states: [MilestoneState!], orderBy: MilestoneOrder, query: String): MilestoneConnection
  name: String!
  nameWithOwner: String!
  owner: RepositoryOwner!
  parent: Repository
  pullRequest(number: Int!): PullRequest
  pullRequests(first: Int, last: Int, after: String, before: String, states: [PullRequestState!], headRefName: String, baseRefName: String, labels: [String!], orderBy: IssueOrder): PullRequestConnection!
  pushedAt: DateTime
  rebaseMergeAllowed: Boolean!
  resourcePath: URI!
  squashMergeAllowed: Boolean!
  sshUrl: String!
  updatedAt: DateTime!
  url: URI!
  viewerCanAdminister: Boolean!
  viewerPermission: RepositoryPermission
  visibility: RepositoryVisibility!
}

type Ref implements Node {
  branchProtectionRule: BranchProtectionRule
  id: ID!
  name: String!
  prefix: String!
  target: Commit
}

type BranchProtectionRule implements Node {
  id: ID!
  pattern: String!
  requiredApprovingReviewCount: Int
  requiredStatusCheckContexts: [String]
  requiresApprovingReviews: Boolean!
  requiresLinearHistory: Boolean!
  requiresStatusChecks: Boolean!
  requiresStrictStatusChecks: Boolean!
}

type PullRequestConnection {
  edges: [PullRequestEdge]
  nodes: [PullRequest]
  pageInfo: PageInfo!
  totalCount: Int!
}
type PullRequestEdge { cursor: String!, node: PullRequest }

union IssueOrPullRequest = Issue | PullRequest

type IssueConnection {
  edges: [IssueEdge]
  nodes: [Issue]
  pageInfo: PageInfo!
  totalCount: Int!
}
type IssueEdge { cursor: String!, node: Issue }

type Issue implements Node & Labelable & Assignable {
  assignees(first: Int, last: Int, after: String, before: String): UserConnection!
  author: Actor
  authorAssociation: String!
  body: String!
  closed: Boolean!
  closedAt: DateTime
  comments(first: Int, last: Int, after: String, before: String): IssueCommentConnection!
  createdAt: DateTime!
  databaseId: BigInt
  id: ID!
  labels(first: Int, last: Int, after: String, before: String): LabelConnection
  locked: Boolean!
  milestone: Milestone
  number: Int!
  projectItems(first: Int, last: Int, after: String, before: String): ProjectV2ItemConnection!
  reactionGroups: [ReactionGroup!]
  repository: Repository!
  resourcePath: URI!
  state: IssueState!
  stateReason: IssueStateReason
  title: String!
  updatedAt: DateTime!
  url: URI!
  viewerCanUpdate: Boolean!
}

type PullRequest implements Node & Labelable & Assignable {
  additions: Int!
  assignees(first: Int, last: Int, after: String, before: String): UserConnection!
  author: Actor
  authorAssociation: String!
  autoMergeRequest: AutoMergeRequest
  baseRef: Ref
  baseRefName: String!
  baseRefOid: GitObjectID!
  baseRepository: Repository
  body: String!
  changedFiles: Int!
  closed: Boolean!
  closedAt: DateTime
  comments(first: Int, last: Int, after: String, before: String): IssueCommentConnection!
  commits(first: Int, last: Int, after: String, before: String): PullRequestCommitConnection!
  createdAt: DateTime!
  databaseId: BigInt
  deletions: Int!
  files(first: Int, last: Int, after: String, before: String): PullRequestChangedFileConnection
  headRef: Ref
  headRefName: String!
  headRefOid: GitObjectID!
  headRepository: Repository
  headRepositoryOwner: RepositoryOwner
  id: ID!
  isCrossRepository: Boolean!
  isDraft: Boolean!
  labels(first: Int, last: Int, after: String, before: String): LabelConnection
  latestReviews(first: Int, last: Int, after: String, before: String): PullRequestReviewConnection
  locked: Boolean!
  maintainerCanModify: Boolean!
  mergeCommit: Commit
  mergeStateStatus: MergeStateStatus!
  mergeable: MergeableState!
  merged: Boolean!
  mergedAt: DateTime
  mergedBy: Actor
  milestone: Milestone
  number: Int!
  permalink: URI!
  projectItems(first: Int, last: Int, after: String, before: String): ProjectV2ItemConnection!
  reactionGroups: [ReactionGroup!]
  repository: Repository!
  resourcePath: URI!
  reviewDecision: PullRequestReviewDecision
  reviewRequests(first: Int, last: Int, after: String, before: String): ReviewRequestConnection
  reviews(first: Int, last: Int, after: String, before: String, states: [PullRequestReviewState!]): PullRequestReviewConnection
  state: PullRequestState!
  statusCheckRollup: StatusCheckRollup
  title: String!
  updatedAt: DateTime!
  url: URI!
}

type AutoMergeRequest {
  authorEmail: String
  commitBody: String
  commitHeadline: String
  enabledAt: DateTime
  enabledBy: Actor
  mergeMethod: PullRequestMergeMethod!
}

type Milestone implements Node {
  description: String
  dueOn: DateTime
  id: ID!
  number: Int!
  state: String!
  title: String!
}

type MilestoneConnection { nodes: [Milestone], totalCount: Int!, pageInfo: PageInfo! }

type UserConnection { nodes: [User], totalCount: Int!, pageInfo: PageInfo! }

type Label implements Node {
  color: String!
  description: String
  id: ID!
  name: String!
}
type LabelConnection { nodes: [Label], totalCount: Int!, pageInfo: PageInfo! }

type Team implements Node {
  id: ID!
  name: String!
  organization: Organization!
  slug: String!
}
union RequestedReviewer = User | Team | Bot | Mannequin
type ReviewRequest { requestedReviewer: RequestedReviewer }
type ReviewRequestConnection { nodes: [ReviewRequest], totalCount: Int!, pageInfo: PageInfo! }

type PullRequestReview implements Node {
  author: Actor
  authorAssociation: String!
  body: String!
  commit: Commit
  id: ID!
  includesCreatedEdit: Boolean!
  reactionGroups: [ReactionGroup!]
  state: PullRequestReviewState!
  submittedAt: DateTime
}
type PullRequestReviewConnection { nodes: [PullRequestReview], totalCount: Int!, pageInfo: PageInfo! }

type IssueComment implements Node {
  author: Actor
  authorAssociation: String!
  body: String!
  createdAt: DateTime!
  id: ID!
  includesCreatedEdit: Boolean!
  isMinimized: Boolean!
  minimizedReason: String
  reactionGroups: [ReactionGroup!]
  url: URI!
  viewerDidAuthor: Boolean!
}
type IssueCommentConnection { nodes: [IssueComment], totalCount: Int!, pageInfo: PageInfo! }

type PullRequestChangedFile {
  additions: Int!
  changeType: PatchStatus!
  deletions: Int!
  path: String!
}
type PullRequestChangedFileConnection { nodes: [PullRequestChangedFile], totalCount: Int!, pageInfo: PageInfo! }

type PullRequestCommit implements Node {
  commit: Commit!
  id: ID!
  url: URI!
}
type PullRequestCommitEdge { cursor: String!, node: PullRequestCommit }
type PullRequestCommitConnection {
  edges: [PullRequestCommitEdge]
  nodes: [PullRequestCommit]
  pageInfo: PageInfo!
  totalCount: Int!
}

type GitActor {
  date: GitTimestamp
  email: String
  name: String
  user: User
}

type GitActorConnection { nodes: [GitActor], totalCount: Int!, pageInfo: PageInfo! }

"Projects aren't part of Diffinery: always empty."
type ProjectV2Item implements Node { id: ID! }
type ProjectV2ItemConnection { nodes: [ProjectV2Item], totalCount: Int!, pageInfo: PageInfo! }

type Commit implements Node {
  abbreviatedOid: String!
  author: GitActor
  authoredDate: DateTime!
  authors(first: Int, last: Int, after: String, before: String): GitActorConnection!
  commitUrl: URI!
  committedDate: DateTime!
  committer: GitActor
  id: ID!
  message: String!
  messageBody: String!
  messageHeadline: String!
  oid: GitObjectID!
  status: Status
  statusCheckRollup: StatusCheckRollup
  url: URI!
}

"The legacy combined commit status (commit statuses only, no check runs)."
type Status implements Node {
  contexts: [StatusContext!]!
  id: ID!
  state: StatusState!
}

type StatusCheckRollup implements Node {
  commit: Commit
  contexts(first: Int, last: Int, after: String, before: String): StatusCheckRollupContextConnection!
  id: ID!
  state: StatusState!
}

union StatusCheckRollupContext = CheckRun | StatusContext

type CheckRunStateCount { count: Int!, state: CheckRunState! }
type StatusContextStateCount { count: Int!, state: StatusState! }
type StatusCheckRollupContextEdge { cursor: String!, node: StatusCheckRollupContext }

type StatusCheckRollupContextConnection {
  checkRunCount: Int!
  checkRunCountsByState: [CheckRunStateCount!]
  edges: [StatusCheckRollupContextEdge]
  nodes: [StatusCheckRollupContext]
  pageInfo: PageInfo!
  statusContextCount: Int!
  statusContextCountsByState: [StatusContextStateCount!]
  totalCount: Int!
}

type App implements Node {
  id: ID!
  logoUrl(size: Int): URI!
  name: String!
  slug: String!
}

type Workflow implements Node {
  id: ID!
  name: String!
}

type WorkflowRun implements Node {
  databaseId: BigInt
  event: String!
  id: ID!
  runNumber: Int!
  url: URI!
  workflow: Workflow!
}

type CheckSuite implements Node {
  app: App
  conclusion: CheckConclusionState
  id: ID!
  status: CheckStatusState!
  workflowRun: WorkflowRun
}

type CheckRun implements Node {
  checkSuite: CheckSuite!
  completedAt: DateTime
  conclusion: CheckConclusionState
  databaseId: BigInt
  detailsUrl: URI
  id: ID!
  isRequired(pullRequestId: ID, pullRequestNumber: Int): Boolean!
  name: String!
  permalink: URI!
  startedAt: DateTime
  status: CheckStatusState!
  summary: String
  text: String
  title: String
  url: URI!
}

type StatusContext implements Node {
  avatarUrl(size: Int): URI
  context: String!
  createdAt: DateTime!
  creator: Actor
  description: String
  id: ID!
  isRequired(pullRequestId: ID, pullRequestNumber: Int): Boolean!
  state: StatusState!
  targetUrl: URI
}
`;
