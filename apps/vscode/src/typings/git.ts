// The parts of VS Code's built-in Git extensions' APIs this extension uses (vscode.git and vscode.git-base,
// version 1). Declared here rather than copied whole: only these members are relied on.
import type { Disposable, Event, ProviderResult, Uri } from "vscode";

export interface RemoteSource {
  readonly name: string;
  readonly description?: string;
  readonly detail?: string;
  /** Codicon name. */
  readonly icon?: string;
  readonly url: string | string[];
}

export interface RemoteSourceAction {
  readonly label: string;
  /** Codicon name. */
  readonly icon: string;
  run(branch: string): void;
}

export interface RemoteSourceProvider {
  readonly name: string;
  /** Codicon name. */
  readonly icon?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly supportsQuery?: boolean;
  getBranches?(url: string): ProviderResult<string[]>;
  getRemoteSourceActions?(url: string): ProviderResult<RemoteSourceAction[]>;
  getRemoteSources(query?: string): ProviderResult<RemoteSource[]>;
}

export interface PickRemoteSourceOptions {
  readonly providerLabel?: (provider: RemoteSourceProvider) => string;
  readonly urlLabel?: string | ((url: string) => string);
  readonly providerName?: string;
  readonly title?: string;
  readonly placeholder?: string;
  readonly branch?: boolean;
  readonly showRecentSources?: boolean;
}

export interface GitBaseAPI {
  registerRemoteSourceProvider(provider: RemoteSourceProvider): Disposable;
  pickRemoteSource(options: PickRemoteSourceOptions): Promise<string | { url: string; branch?: string } | undefined>;
}

export interface GitBaseExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): GitBaseAPI;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

export interface CredentialsProvider {
  getCredentials(host: Uri): ProviderResult<Credentials>;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { readonly remote: string; readonly name: string };
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly remotes: Remote[];
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  addRemote(name: string, url: string): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

export interface RemoteSourcePublisher {
  readonly name: string;
  /** Codicon name. */
  readonly icon?: string;
  publishRepository(repository: Repository): Promise<void>;
}

export interface GitAPI {
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  registerCredentialsProvider(provider: CredentialsProvider): Disposable;
  registerRemoteSourcePublisher(publisher: RemoteSourcePublisher): Disposable;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): GitAPI;
}
