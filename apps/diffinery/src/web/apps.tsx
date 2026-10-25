/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import type { Account, Repo } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { APP_EVENTS, APP_EVENT_NAMES, APP_PERMISSIONS, APP_PERMISSION_NAMES, type AppPermissions } from "../apps/model.js";
import { Apps, effectivePermissions, pendingPermissions, type App, type AppInput, type Installation } from "../apps/store.js";
import { acceptPermissions, adminAccounts, administers, auditApp, changeRepositories, installApp, manageableApp, manageableInstallation, suspendInstallation, uninstallApp, whoOf, type Ctx } from "../apps/service.js";
import { requirePerson } from "../http/apps.js";
import { baseOf } from "../http/gh.js";
import { SettingsNav, type SettingsTab } from "./account.js";
import { csrfToken, type FormData } from "./csrf.js";
import { KCheckbox, KRadio, KSelect } from "./kumo.js";
import { Avatar, CopyButton, Form, Time, act, flash, post, prm, render, type WebApp } from "./ui.js";

/**
 * GitHub-compatible apps in the web UI (apps/): Settings → Apps, where people register apps and manage
 * their keys; an app's public page with Install; choosing where to install it; and Settings → Installed
 * apps, where the admins of an account change an app's repositories, accept new permissions, suspend
 * or uninstall it. Registering, keys and installing need a person signed in with a passkey.
 */

const settingsPage = (c: AppContext, me: Account, tab: SettingsTab, title: string, body: Child) =>
  render(
    c,
    { title },
    <div class="grid left">
      <SettingsNav me={me} tab={tab} db={c.env.DB} />
      <div>{body}</div>
    </div>,
  );

const ctx = (c: AppContext): Ctx => ({ env: c.env, dir: c.get("dir"), base: baseOf(c), waitUntil: (p) => c.executionCtx.waitUntil(p), via: "web" });
const apps = (c: AppContext) => new Apps(c.env, c.get("dir"));

/** A form's app settings as the store takes them (the same names as the REST API). */
function appInput(f: FormData, o: { creating: boolean }): AppInput {
  const permissions: Record<string, string> = {};
  for (const name of APP_PERMISSION_NAMES) {
    const level = f.s(`perm_${name}`);
    if (level === "read" || level === "write") permissions[name] = level;
  }
  const lines = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  const secret = f.s("webhook_secret").trim();
  return {
    ...(o.creating ? { name: f.s("name") } : {}),
    description: f.s("description"),
    homepage_url: f.s("homepage_url").trim(),
    setup_url: f.s("setup_url").trim() || null,
    callback_urls: lines(f.s("callback_urls")),
    webhook_url: f.s("webhook_url").trim() || null,
    ...(secret ? { webhook_secret: secret } : {}),
    webhook_active: f.b("webhook_active"),
    public: f.b("public"),
    default_permissions: permissions,
    default_events: f.all("events").filter((e) => APP_EVENT_NAMES.includes(e)),
  };
}

const LEVELS = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read" },
  { value: "write", label: "Read and write" },
];

/** The settings an app is registered with and changed by. */
const AppFields: FC<{ app?: App; owners?: Account[] }> = ({ app, owners }) => (
  <div class="body fbody">
    {app ? null : (
      <div class="fgrid">
        <div class="field">
          <label for="app-name">Name</label>
          <input id="app-name" name="name" type="text" required maxlength={34} autocomplete="off" />
          <div class="hint">Unique on Diffinery. Its bot signs its work as name[bot], with the name in lower case and dashes. It can't change later.</div>
        </div>
        {owners && owners.length > 1 ? (
          <div class="field">
            <label>Owner</label>
            <KSelect name="owner" block options={owners.map((a) => ({ value: a.login, label: a.kind === "org" ? `${a.login} (organization)` : a.login }))} value={owners[0]!.login} label="Owner" />
            <div class="hint">You, or an organization you own or administer.</div>
          </div>
        ) : null}
      </div>
    )}
    <div class="field">
      <label for="app-description">
        Description <span class="faint">(optional)</span>
      </label>
      <textarea id="app-description" name="description" rows={2}>
        {app?.description ?? ""}
      </textarea>
    </div>
    <div class="fgrid">
      <div class="field">
        <label for="app-homepage">Homepage URL</label>
        <input id="app-homepage" name="homepage_url" type="url" required value={app?.homepageUrl ?? ""} placeholder="https://example.com" />
      </div>
      <div class="field">
        <label for="app-setup">
          Setup URL <span class="faint">(optional)</span>
        </label>
        <input id="app-setup" name="setup_url" type="url" value={app?.setupUrl ?? ""} placeholder="https://example.com/setup" />
        <div class="hint">Where people go after installing it, with installation_id and setup_action in the query, as on GitHub.</div>
      </div>
    </div>
    <div class="field">
      <label for="app-callbacks">
        Callback URLs <span class="faint">(optional, one per line)</span>
      </label>
      <textarea id="app-callbacks" name="callback_urls" class="mono" rows={2} autocomplete="off" spellcheck={false}>
        {(app?.callbackUrls ?? []).join("\n")}
      </textarea>
    </div>
    <div class="fgrid">
      <div class="field">
        <label for="app-webhook">
          Webhook URL <span class="faint">(optional)</span>
        </label>
        <input id="app-webhook" name="webhook_url" type="url" value={app?.webhookUrl ?? ""} placeholder="https://example.com/webhooks" />
        <div class="hint">Events from every repository it's installed on go here, signed with the secret (X-Hub-Signature-256).</div>
      </div>
      <div class="field">
        <label for="app-secret">
          Webhook secret <span class="faint">(optional)</span>
        </label>
        <input id="app-secret" name="webhook_secret" type="text" autocomplete="off" class="mono" placeholder={app?.webhookSecret ? "Unchanged" : ""} />
        <div class="hint">{app?.webhookSecret ? "Leave empty to keep the current one." : "Left empty, Diffinery makes one and shows it once."}</div>
      </div>
    </div>
    <div class="fchecks">
      <KCheckbox name="webhook_active" checked={app ? app.webhookActive : true} label="Send webhooks" />
      <KCheckbox name="public" checked={app?.public ?? false} label="Anyone can install it" description="Otherwise only its owner's account can." />
    </div>
    <h3>Repository permissions</h3>
    <p class="muted small">
      What its installation tokens may do in the repositories it's installed on. Apps never change settings, secrets or workflow files. Asking for more later waits until each installation's admins accept it.
    </p>
    <div class="fgrid">
      {APP_PERMISSION_NAMES.filter((n) => n !== "metadata").map((n) => (
        <div class="field">
          <label>{APP_PERMISSIONS[n].label}</label>
          <KSelect name={`perm_${n}`} block options={LEVELS.filter((l) => l.value === "none" || (APP_PERMISSIONS[n].levels as readonly string[]).includes(l.value))} value={app?.permissions[n] ?? "none"} label={APP_PERMISSIONS[n].label} />
          <div class="hint">{APP_PERMISSIONS[n].description}</div>
        </div>
      ))}
    </div>
    <div class="field">
      <label>Events</label>
      <div class="fchecks cols">
        {APP_EVENT_NAMES.map((e) => (
          <KCheckbox name="events" value={e} checked={app?.events.includes(e) ?? false} label={<span class="mono small">{e}</span>} />
        ))}
      </div>
      <div class="hint">Each needs one of these permissions: {APP_EVENT_NAMES.map((e) => `${e}: ${APP_EVENTS[e]!.needs.join(" or ")}`).join("; ")}. Installation events always come.</div>
    </div>
  </div>
);

/** A secret or private key shown once, with Copy (and Download for a key). */
const Once: FC<{ title: string; value: string; note: string; download?: string }> = ({ title, value, note, download }) => (
  <div class="box" style="border-color:var(--amber)">
    <div class="body">
      <h3>{title}</h3>
      <p class="muted">{note}</p>
      <pre class="secret" style="white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto">{value}</pre>
      <div class="row mt">
        <CopyButton text={value} size="base" />
        {download ? (
          <a class="btn" href={`data:application/x-pem-file;charset=utf-8,${encodeURIComponent(value)}`} download={download}>
            Download
          </a>
        ) : null}
      </div>
    </div>
  </div>
);

const PermissionList: FC<{ permissions: AppPermissions }> = ({ permissions }) => (
  <ul class="small m0" style="padding-left:18px">
    {APP_PERMISSION_NAMES.filter((n) => permissions[n]).map((n) => (
      <li>
        {APP_PERMISSIONS[n].label}: <b>{permissions[n] === "write" ? "read and write" : "read"}</b>
      </li>
    ))}
  </ul>
);

// ---------------------------------------------------------------- Settings → Apps

async function appsPage(c: AppContext) {
  const me = requireAccount(c);
  const accounts = await adminAccounts(c.get("dir"), me);
  const owned = await apps(c).ownedBy(accounts.map((a) => a.id));
  const ownerLogin = new Map(accounts.map((a) => [a.id, a.login]));
  return settingsPage(
    c,
    me,
    "apps",
    "Apps",
    <>
      <div class="row between">
        <h1>Apps</h1>
        <a class="btn primary" href="/settings/apps/new">
          New app
        </a>
      </div>
      <p class="muted">
        Apps work like GitHub Apps: deploy, CI and review services sign in with a key, get short-lived tokens for the repositories they're installed on, and receive webhooks. An integration built for GitHub works by changing its API URL to <span class="mono">{baseOf(c)}/api/v3</span>. See <a href="/docs/repositories/apps">the docs</a>.
      </p>
      <div class="box">
        {owned.length ? (
          <ul class="list">
            {owned.map((a) => (
              <li style="align-items:center">
                <Avatar login={ownerLogin.get(a.ownerId) ?? a.slug} />
                <div class="grow">
                  <a class="title" href={`/settings/apps/${a.slug}`}>
                    {a.name}
                  </a>{" "}
                  {a.public ? <span class="badge">public</span> : <span class="badge">private</span>}
                  <div class="meta">
                    {ownerLogin.get(a.ownerId)} · {a.slug}[bot] · registered <Time at={a.createdAt} />
                  </div>
                </div>
                <a class="btn sm" href={`/apps/${a.slug}`}>
                  Install
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div class="empty">No apps yet. Register one to build an integration, or see apps installed on your accounts under <a href="/settings/installations">Installed apps</a>.</div>
        )}
      </div>
    </>,
  );
}

async function newAppPage(c: AppContext) {
  const me = requireAccount(c);
  const owners = await adminAccounts(c.get("dir"), me);
  return settingsPage(
    c,
    me,
    "apps",
    "New app",
    <>
      <h1>New app</h1>
      <p class="muted">
        <a href="/settings/apps">Apps</a> · Diffinery makes the app's first private key and shows it once, as a PEM file like GitHub's.
      </p>
      <Form action="/settings/apps" t={csrfToken(c)} class="box">
        <AppFields owners={owners} />
        <div class="body" style="border-top:1px solid var(--border)">
          <button class="btn primary">Register app</button>
        </div>
      </Form>
    </>,
  );
}

async function appSettingsPage(c: AppContext, app: App, shown?: { pem?: string; webhookSecret?: string | null; created?: boolean }) {
  const me = requireAccount(c);
  const t = csrfToken(c);
  const [keys, installs, owner] = await Promise.all([apps(c).keys(app.id), apps(c).installationsOf(app.id), c.get("dir").account(app.ownerId)]);
  const api = `${baseOf(c)}/api/v3`;
  return settingsPage(
    c,
    me,
    "apps",
    app.name,
    <>
      <h1>{app.name}</h1>
      <p class="muted">
        <a href="/settings/apps">Apps</a> · owned by {owner?.login} · <a href={`/apps/${app.slug}`}>public page</a> · {installs.length} {installs.length === 1 ? "installation" : "installations"}
      </p>
      {shown?.pem ? <Once title={shown.created ? `${app.name} is registered: its private key` : "The new private key"} value={shown.pem} note="Copy or download it now: Diffinery keeps only the public half and can't show it again. The app signs its JWTs with it." download={`${app.slug}.private-key.pem`} /> : null}
      {shown?.webhookSecret ? <Once title="Webhook secret" value={shown.webhookSecret} note="Deliveries are signed with it (X-Hub-Signature-256). Copy it now; it won't be shown again." /> : null}
      <div class="box">
        <div class="head">
          <h2>About</h2>
        </div>
        <div class="body">
          <div class="fgrid c3">
            <div class="field">
              <label>App ID</label>
              <div class="row">
                <span class="mono">{app.id}</span>
                <CopyButton text={String(app.id)} />
              </div>
            </div>
            <div class="field">
              <label>Client ID</label>
              <div class="row">
                <span class="mono">{app.clientId}</span>
                <CopyButton text={app.clientId} />
              </div>
            </div>
            <div class="field">
              <label>API URL</label>
              <div class="row">
                <span class="mono small">{api}</span>
                <CopyButton text={api} />
              </div>
            </div>
          </div>
          <p class="muted small m0">
            Last webhook delivery: {app.lastDelivery ? <>status {app.lastDelivery.status || "failed to connect"}, <Time at={app.lastDelivery.at} /></> : "none yet"}.
          </p>
        </div>
      </div>
      <Form action={`/settings/apps/${app.slug}`} t={t} class="box">
        <div class="head">
          <h2>Settings</h2>
        </div>
        <AppFields app={app} />
        <div class="body" style="border-top:1px solid var(--border)">
          <button class="btn primary">Save changes</button>
        </div>
      </Form>
      <div class="box">
        <div class="head">
          <h2>Private keys</h2>
        </div>
        <ul class="list">
          {keys.map((k) => (
            <li style="align-items:center">
              <div class="grow">
                <span class="mono small">{k.fingerprint}</span>
                <div class="meta">
                  Added <Time at={k.createdAt} /> · {k.lastUsedAt ? <>last used <Time at={k.lastUsedAt} /></> : "never used"}
                </div>
              </div>
              {keys.length > 1 ? (
                <Form action={`/settings/apps/${app.slug}/keys/${k.id}/delete`} t={t} class="inline" confirm="Delete this key? JWTs signed with it stop working at once.">
                  <button class="btn sm danger">Delete</button>
                </Form>
              ) : null}
            </li>
          ))}
        </ul>
        <div class="body" style="border-top:1px solid var(--border)">
          <Form action={`/settings/apps/${app.slug}/keys`} t={t} class="inline">
            <button class="btn">Generate a private key</button>
          </Form>
          <details class="mt">
            <summary class="small" style="cursor:pointer">
              Or add a public key you made
            </summary>
            <Form action={`/settings/apps/${app.slug}/keys`} t={t} class="mt">
              <textarea name="public_key" class="mono" rows={6} required spellcheck={false} placeholder="-----BEGIN PUBLIC KEY-----" aria-label="Public key" />
              <div class="hint">An RSA public key of at least 2048 bits, in PEM: openssl rsa -in key.pem -pubout.</div>
              <button class="btn mt">Add public key</button>
            </Form>
          </details>
        </div>
      </div>
      <div class="box" style="border-color:color-mix(in srgb,var(--red) 45%,transparent)">
        <div class="head" style="background:var(--red-soft)">
          <h2 class="bad">Delete this app</h2>
        </div>
        <Form action={`/settings/apps/${app.slug}/delete`} t={t} match={app.slug} class="body">
          <p class="muted small">
            Its keys and its {installs.length} {installs.length === 1 ? "installation" : "installations"} go with it, and its tokens stop working. This can't be undone. Type <b class="mono">{app.slug}</b> to confirm.
          </p>
          <div class="row">
            <input name="confirm" type="text" required autocomplete="off" style="max-width:320px" aria-label="Confirm the app's slug" />
            <button class="btn danger">Delete app</button>
          </div>
        </Form>
      </div>
    </>,
  );
}

// ---------------------------------------------------------------- an app's public page and installing it

/** The app, when this person may see it: a public one, or their own or their organization's. */
async function visibleApp(c: AppContext, slug: string, me: Account | null): Promise<App> {
  const app = await apps(c).bySlug(slug);
  if (!app || !(app.public || (me && (await administers(c.get("dir"), me, app.ownerId))))) throw new HttpError(404, "app not found");
  return app;
}

async function publicAppPage(c: AppContext) {
  const p = c.get("principal");
  const me = p.type === "account" ? p.account : null;
  const app = await visibleApp(c, prm(c, "slug"), me);
  const owner = await c.get("dir").account(app.ownerId);
  return render(
    c,
    { title: app.name, description: app.description || `${app.name}, an app on Diffinery` },
    <div style="max-width:720px;margin:0 auto">
      <div class="row mb">
        <Avatar login={owner?.login ?? app.slug} size="lg" />
        <div class="grow">
          <h1 class="m0">{app.name}</h1>
          <div class="muted small">
            by {owner?.login} · <a href={app.homepageUrl} rel="noopener nofollow ugc">{app.homepageUrl}</a>
          </div>
        </div>
        <a class="btn primary" href={`/apps/${app.slug}/installations/new`}>
          Install
        </a>
      </div>
      {app.description ? <p>{app.description}</p> : null}
      <div class="box">
        <div class="head">
          <h2>It asks for</h2>
        </div>
        <div class="body">
          <PermissionList permissions={app.permissions} />
          <p class="muted small">Apps never change repository settings, secrets or workflow files. You choose which repositories it can use, and can change that, suspend it or uninstall it at any time.</p>
        </div>
      </div>
    </div>,
  );
}

async function installPage(c: AppContext) {
  const me = requireAccount(c);
  const app = await visibleApp(c, prm(c, "slug"), me);
  const dir = c.get("dir");
  const accounts = await adminAccounts(dir, me);
  const chosen = c.req.query("account") ? accounts.find((a) => a.login.toLowerCase() === c.req.query("account")!.toLowerCase()) : accounts.length === 1 ? accounts[0] : undefined;
  const existing = new Map((await apps(c).installationsOf(app.id)).map((i) => [i.accountId, i]));
  let body: Child;
  if (!chosen) {
    body = (
      <div class="box">
        <div class="head">
          <h2>Where do you want to install {app.name}?</h2>
        </div>
        <ul class="list">
          {accounts.map((a) => {
            const inst = existing.get(a.id);
            const allowed = app.public || a.id === app.ownerId;
            return (
              <li style="align-items:center">
                <Avatar login={a.login} kind={a.kind} />
                <div class="grow">
                  <b>{a.login}</b>
                  <div class="meta">{a.kind === "org" ? "Organization" : "Your account"}</div>
                </div>
                {inst ? (
                  <a class="btn sm" href={`/settings/installations/${inst.id}`}>
                    Configure
                  </a>
                ) : allowed ? (
                  <a class="btn sm primary" href={`/apps/${app.slug}/installations/new?account=${encodeURIComponent(a.login)}`}>
                    Install
                  </a>
                ) : (
                  <span class="muted small">Private to its owner</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  } else if (existing.has(chosen.id)) {
    return c.redirect(`/settings/installations/${existing.get(chosen.id)!.id}`, 302);
  } else {
    const repos = (await dir.reposVisibleTo(me, chosen.id)).filter((r) => r.owner_id === chosen.id);
    body = (
      <Form action={`/apps/${app.slug}/installations`} t={csrfToken(c)} class="box">
        <input type="hidden" name="account" value={chosen.login} />
        <div class="head">
          <h2>
            Install {app.name} on {chosen.login}
          </h2>
        </div>
        <div class="body fbody">
          <RepoChoice repos={repos} selection="all" selected={[]} />
          <div class="field">
            <label>With these permissions</label>
            <PermissionList permissions={app.permissions} />
          </div>
          <div class="factions">
            <button class="btn primary">Install</button>
            <a class="btn" href={`/apps/${app.slug}`}>
              Cancel
            </a>
          </div>
        </div>
      </Form>
    );
  }
  return render(
    c,
    { title: `Install ${app.name}` },
    <div style="max-width:720px;margin:0 auto">
      <h1>Install {app.name}</h1>
      {body}
    </div>,
  );
}

const RepoChoice: FC<{ repos: Repo[]; selection: "all" | "selected"; selected: string[] }> = ({ repos, selection, selected }) => (
  <>
    <div class="field">
      <label>Repository access</label>
      <KRadio
        name="repository_selection"
        value={selection}
        items={[
          { value: "all", label: "All repositories", description: "Including ones created later." },
          { value: "selected", label: "Only select repositories" },
        ]}
      />
    </div>
    {repos.length ? (
      <div class="field">
        <label>Selected repositories</label>
        <div class="fchecks cols">
          {repos.map((r) => (
            <KCheckbox name="repositories" value={r.name} checked={selected.includes(r.id)} label={<span class="mono small">{r.name}</span>} />
          ))}
        </div>
        <div class="hint">Used when "Only select repositories" is chosen.</div>
      </div>
    ) : (
      <p class="muted small">No repositories yet.</p>
    )}
  </>
);

// ---------------------------------------------------------------- Settings → Installed apps

async function installationsPage(c: AppContext) {
  const me = requireAccount(c);
  const accounts = await adminAccounts(c.get("dir"), me);
  const list = await apps(c).installationsOn(accounts.map((a) => a.id));
  const login = new Map(accounts.map((a) => [a.id, a.login]));
  return settingsPage(
    c,
    me,
    "installations",
    "Installed apps",
    <>
      <h1>Installed apps</h1>
      <p class="muted">Apps installed on your account and on organizations you own or administer.</p>
      <div class="box">
        {list.length ? (
          <ul class="list">
            {list.map(({ installation: i, app }) => (
              <li style="align-items:center">
                <div class="grow">
                  <a class="title" href={`/settings/installations/${i.id}`}>
                    {app.name}
                  </a>{" "}
                  {i.suspendedAt ? <span class="badge amber">suspended</span> : null}
                  {pendingPermissions(app, i) ? <span class="badge blue">new permissions</span> : null}
                  <div class="meta">
                    on {login.get(i.accountId)} · {i.selection === "all" ? "all repositories" : "selected repositories"} · installed <Time at={i.createdAt} />
                  </div>
                </div>
                <a class="btn sm" href={`/settings/installations/${i.id}`}>
                  Configure
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div class="empty">No apps installed.</div>
        )}
      </div>
    </>,
  );
}

async function installationPage(c: AppContext) {
  const me = requireAccount(c);
  const dir = c.get("dir");
  const { installation: i, app, account } = await manageableInstallation(dir, c.env, me, Number(prm(c, "id")));
  const t = csrfToken(c);
  const [repos, selected] = await Promise.all([dir.reposVisibleTo(me, account.id), apps(c).selectedRepoIds(i.id)]);
  const pending = pendingPermissions(app, i);
  return settingsPage(
    c,
    me,
    "installations",
    app.name,
    <>
      <h1>{app.name}</h1>
      <p class="muted">
        <a href="/settings/installations">Installed apps</a> · on {account.login} · <a href={`/apps/${app.slug}`}>about the app</a> · installed <Time at={i.createdAt} />
      </p>
      {i.suspendedAt ? <div class="flash notice">This installation is suspended: the app can't use its tokens or receive webhooks until it's unsuspended.</div> : null}
      {pending ? (
        <div class="box" style="border-color:var(--amber)">
          <div class="head">
            <h2>{app.name} asks for new permissions</h2>
          </div>
          <div class="body">
            <PermissionList permissions={pending} />
            <Form action={`/settings/installations/${i.id}/accept`} t={t} class="mt">
              <button class="btn primary">Accept new permissions</button>
            </Form>
          </div>
        </div>
      ) : null}
      <div class="box">
        <div class="head">
          <h2>Permissions</h2>
        </div>
        <div class="body">
          <PermissionList permissions={effectivePermissions(app, i)} />
        </div>
      </div>
      <Form action={`/settings/installations/${i.id}/repositories`} t={t} class="box">
        <div class="head">
          <h2>Repository access</h2>
        </div>
        <div class="body fbody">
          <RepoChoice repos={repos.filter((r) => r.owner_id === account.id)} selection={i.selection} selected={selected} />
          <div class="factions">
            <button class="btn primary">Save</button>
          </div>
        </div>
      </Form>
      <div class="box" style="border-color:color-mix(in srgb,var(--red) 45%,transparent)">
        <div class="head" style="background:var(--red-soft)">
          <h2 class="bad">Danger zone</h2>
        </div>
        <ul class="list">
          <li style="align-items:center">
            <div class="grow">
              <b>{i.suspendedAt ? "Unsuspend" : "Suspend"}</b>
              <div class="meta">{i.suspendedAt ? "Let the app use its access again." : "Stop the app's tokens and webhooks, keeping its settings."}</div>
            </div>
            <Form action={`/settings/installations/${i.id}/${i.suspendedAt ? "unsuspend" : "suspend"}`} t={t} class="inline">
              <button class="btn sm">{i.suspendedAt ? "Unsuspend" : "Suspend"}</button>
            </Form>
          </li>
          <li style="align-items:center">
            <div class="grow">
              <b>Uninstall</b>
              <div class="meta">Remove {app.name} from {account.login}. Its tokens stop working at once.</div>
            </div>
            <Form action={`/settings/installations/${i.id}/delete`} t={t} class="inline" confirm={`Uninstall ${app.name} from ${account.login}?`}>
              <button class="btn sm danger">Uninstall</button>
            </Form>
          </li>
        </ul>
      </div>
    </>,
  );
}

/** Repository names chosen in a form, as ids of the account's repositories. */
async function chosenRepos(c: AppContext, account: Account, f: FormData): Promise<{ selection: "all" | "selected"; ids: string[] }> {
  const selection = f.s("repository_selection") === "selected" ? "selected" : "all";
  if (selection === "all") return { selection, ids: [] };
  const ids: string[] = [];
  for (const name of f.all("repositories")) {
    const r = await c.get("dir").repo(account.login, name);
    if (r && r.owner_id === account.id) ids.push(r.id);
  }
  return { selection, ids };
}

export function registerApps(web: WebApp): void {
  web.get("/settings/apps", appsPage);
  web.get("/settings/apps/new", newAppPage);
  post(web, "/settings/apps", async (c, f) =>
    showOrBack(c, "/settings/apps/new", async () => {
      const me = requirePerson(c, "register an app", { recent: "/settings/apps/new" });
      const dir = c.get("dir");
      const ownerLogin = f.s("owner") || me.login;
      const owner = ownerLogin === me.login ? me : await dir.accountByLogin(ownerLogin);
      if (!owner || !(await administers(dir, me, owner.id))) throw new HttpError(422, "the owner must be you or an organization you own or administer");
      const r = await apps(c).create(owner, me, appInput(f, { creating: true }));
      auditApp(ctx(c), me, "app.create", r.app, { owner: owner.login });
      // The private key is shown on this answer only: never in a redirect, a cookie or a log.
      return appSettingsPage(c, r.app, { pem: r.privateKeyPem, webhookSecret: r.webhookSecret, created: true });
    }),
  );
  web.get("/settings/apps/:slug", async (c) => appSettingsPage(c, await manageableApp(c.get("dir"), c.env, requireAccount(c), prm(c, "slug"))));
  post(web, "/settings/apps/:slug", async (c, f) => {
    const back = `/settings/apps/${prm(c, "slug")}`;
    return showOrBack(c, back, async () => {
      const me = requirePerson(c, "change an app");
      const app = await manageableApp(c.get("dir"), c.env, me, prm(c, "slug"));
      const next = (await apps(c).update(app, appInput(f, { creating: false }))) as App & { madeWebhookSecret?: string };
      auditApp(ctx(c), me, "app.update", app);
      if (next.madeWebhookSecret) return appSettingsPage(c, next, { webhookSecret: next.madeWebhookSecret });
      flash(c, "notice", widened(app, next) ? "Saved. The new permissions apply to each installation once its admins accept them." : "Saved.");
      return c.redirect(back, 303);
    });
  });
  post(web, "/settings/apps/:slug/keys", async (c, f) => {
    const back = `/settings/apps/${prm(c, "slug")}`;
    return showOrBack(c, back, async () => {
      const me = requirePerson(c, "add a key to an app", { recent: back });
      const app = await manageableApp(c.get("dir"), c.env, me, prm(c, "slug"));
      const k = await apps(c).addKey(app, me, f.s("public_key").trim() || undefined);
      auditApp(ctx(c), me, "app.key.create", app, { fingerprint: k.fingerprint });
      if (k.privateKeyPem) return appSettingsPage(c, app, { pem: k.privateKeyPem });
      flash(c, "notice", `Added the key ${k.fingerprint}.`);
      return c.redirect(back, 303);
    });
  });
  post(web, "/settings/apps/:slug/keys/:id/delete", async (c) => {
    const back = `/settings/apps/${prm(c, "slug")}`;
    return act(c, back, async () => {
      const me = requirePerson(c, "delete an app's key");
      const app = await manageableApp(c.get("dir"), c.env, me, prm(c, "slug"));
      const keys = await apps(c).keys(app.id);
      if (keys.length <= 1) throw new HttpError(422, "an app needs at least one key: add another before deleting this one");
      const key = keys.find((k) => k.id === prm(c, "id"));
      if (!key) throw new HttpError(404, "key not found");
      await apps(c).deleteKey(app, key.id);
      auditApp(ctx(c), me, "app.key.delete", app, { fingerprint: key.fingerprint });
      flash(c, "notice", `Deleted the key ${key.fingerprint}.`);
    });
  });
  post(web, "/settings/apps/:slug/delete", async (c, f) => {
    const back = `/settings/apps/${prm(c, "slug")}`;
    return act(c, back, async () => {
      const me = requirePerson(c, "delete an app", { recent: back });
      const app = await manageableApp(c.get("dir"), c.env, me, prm(c, "slug"));
      if (f.s("confirm").trim() !== app.slug) throw new HttpError(422, `type ${app.slug} to confirm`);
      await apps(c).delete(app);
      auditApp(ctx(c), me, "app.delete", app);
      flash(c, "notice", `Deleted ${app.name}.`);
      return "/settings/apps";
    });
  });

  web.get("/apps/:slug", publicAppPage);
  web.get("/apps/:slug/installations/new", installPage);
  post(web, "/apps/:slug/installations", async (c, f) => {
    const back = `/apps/${prm(c, "slug")}/installations/new?account=${encodeURIComponent(f.s("account"))}`;
    return act(c, back, async () => {
      const me = requirePerson(c, "install an app");
      const app = await visibleApp(c, prm(c, "slug"), me);
      const account = await c.get("dir").accountByLogin(f.s("account"));
      if (!account) throw new HttpError(422, "choose an account");
      const { selection, ids } = await chosenRepos(c, account, f);
      const inst = await installApp(ctx(c), me, app, account, selection, ids);
      flash(c, "notice", `Installed ${app.name} on ${account.login}.`);
      // As on GitHub: the app's setup page learns which installation it was.
      if (app.setupUrl) {
        const u = new URL(app.setupUrl);
        u.searchParams.set("installation_id", String(inst.id));
        u.searchParams.set("setup_action", "install");
        return u.toString();
      }
      return `/settings/installations/${inst.id}`;
    });
  });

  web.get("/settings/installations", installationsPage);
  web.get("/settings/installations/:id", installationPage);
  const change = (path: string, fn: (c: AppContext, me: Account, x: { installation: Installation; app: App; account: Account }, f: FormData) => Promise<string | void>) =>
    post(web, `/settings/installations/:id/${path}`, async (c, f) => {
      const back = `/settings/installations/${prm(c, "id")}`;
      return act(c, back, async () => {
        const me = requirePerson(c, "change an installed app");
        return fn(c, me, await manageableInstallation(c.get("dir"), c.env, me, Number(prm(c, "id"))), f);
      });
    });
  change("repositories", async (c, me, { installation, app, account }, f) => {
    const { selection, ids } = await chosenRepos(c, account, f);
    await changeRepositories(ctx(c), me, installation, app, account, selection, ids);
    flash(c, "notice", "Saved.");
  });
  change("accept", async (c, me, { installation, app, account }) => {
    await acceptPermissions(ctx(c), me, installation, app, account);
    flash(c, "notice", `${app.name} has its new permissions.`);
  });
  change("suspend", async (c, me, { installation, app, account }) => {
    await suspendInstallation(ctx(c), me, whoOf(me), installation, app, account, true);
    flash(c, "notice", `Suspended ${app.name}.`);
  });
  change("unsuspend", async (c, me, { installation, app, account }) => {
    await suspendInstallation(ctx(c), me, whoOf(me), installation, app, account, false);
    flash(c, "notice", `Unsuspended ${app.name}.`);
  });
  change("delete", async (c, me, { installation, app, account }) => {
    await uninstallApp(ctx(c), whoOf(me), installation, app, account);
    flash(c, "notice", `Uninstalled ${app.name} from ${account.login}.`);
    return "/settings/installations";
  });
}

/** Whether an app's change asks for more than it had (installations wait for their admins). */
const widened = (prev: App, next: App) => APP_PERMISSION_NAMES.some((n) => next.permissions[n] && (!prev.permissions[n] || (prev.permissions[n] === "read" && next.permissions[n] === "write")));

/**
 * A change whose answer may show something once (a private key, a secret): that page is the answer
 * itself, never a redirect or a cookie. A refusal goes back to `back` with the reason, as act() does.
 */
async function showOrBack(c: AppContext, back: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    return act(c, back, async () => {
      throw e;
    });
  }
}
