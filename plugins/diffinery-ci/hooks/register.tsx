// diffinery-ci: the current branch's Diffinery pull request and its CI checks, live.
//
// In the terminal, the desktop app's Code tab and VS Code, a band above the prompt and the
// status line show the PR and its checks, and /diffinery-ci opens a pane with each check and
// a link to its log. Everywhere hooks run, cloud sessions and project threads included:
// when this session pushes the branch or opens its pull request, the mod watches that commit
// and, once its checks settle, tells Claude, the way GitHub auto-fix wakes a session: failures
// where the band shows the rest, passes too where nothing draws, so a cloud thread hears either
// way. /diffinery-ci answers in text where nothing draws. Nothing to set up.
//
// It reads Diffinery's GraphQL API with the token of the diffinery CLI (DIFFINERY_TOKEN or
// `diffinery login`) or of gh signed in to the Diffinery host, and sends it only there.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Note, Pr } from '../types'
import {
  QUERY,
  SYMBOL,
  checksLine,
  duration,
  factsLine,
  hostOf,
  ordered,
  parsePr,
  parseRemotes,
  pickRemote,
  pollDelay,
  publishes,
  statusText,
  touchesPr,
  wakeChoice,
  wakeFor,
  wakeText,
  type Target,
  type WakeChoice,
} from './lib'

const PLUGIN = 'diffinery-ci'
const PANE = 'diffinery-ci'
const DEFAULT_URL = 'https://diffinery.com'

// Change a tag when the stored value's fields change: it declines what an earlier version
// stored, which outlives a reload.
const prAtom = atom({ plugin: 'diffinery-ci', key: 'pr' } as const, null, { shape: 'pr-1' })
const noteAtom = atom({ plugin: 'diffinery-ci', key: 'note' } as const, null, { shape: 'note-1' })
const watchingAtom = atom({ plugin: 'diffinery-ci', key: 'watching' } as const, true)
const hiddenAtom = atom({ plugin: 'diffinery-ci', key: 'isHidden' } as const, false)

type Auth = { url: string; host: string; token: string | null; source: string }
type Look = { pr: Pr | null; note: Note | null }

const COLOR = { pass: 'success', fail: 'error', run: 'warning', wait: 'subtle', skip: 'subtle' } as const

const NOTES: Record<WakeChoice, string> = {
  auto: 'failures, and passes too where nothing draws the band (cloud sessions)',
  failures: 'failures',
  all: 'passes and failures',
  off: 'never',
}

export const register: Register = on => {
  // What the person chose with `/diffinery-ci notes`, kept across sessions.
  let choice: WakeChoice = 'auto'

  // Set by session.start: look again now (resolves once the look is done), and note that this
  // session just published the branch. Other hooks reach the session's loop through these.
  let refreshNow: (() => Promise<Look>) | null = null
  let notePublished: (() => Promise<void>) | null = null
  let nextAt = 0
  // Mirrors watchingAtom for the session's loop, whose own reads see the state as it began.
  let watching = true

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    choice = wakeChoice(await $.store.get('wake')) ?? 'auto'

    let auth: Auth | null = null
    let lastDir: string | null = null
    let failures = 0
    let busy: Promise<Look> | null = null
    // repo#branch → the local commit a push from this session published, until its checks settle.
    const awaiting = new Map<string, string>()
    // repo#number → sha:rollup last seen, to toast a change once.
    const seen = new Map<string, string>()

    const readAuth = async (): Promise<Auth> => {
      let url = (await $.env.get('DIFFINERY_URL')) ?? null
      let token = (await $.env.get('DIFFINERY_TOKEN')) ?? null
      let source = token ? 'DIFFINERY_TOKEN' : ''
      if (!url || !token) {
        const xdg = await $.env.get('XDG_CONFIG_HOME')
        const home = await $.env.get('HOME')
        const base = xdg && xdg.startsWith('/') ? xdg : home ? `${home}/.config` : null
        if (base) {
          try {
            const cfg = JSON.parse(await $.fs.read(`${base}/diffinery/config.json`)) as Record<string, unknown>
            if (!url && typeof cfg.url === 'string') url = cfg.url
            if (!token && typeof cfg.token === 'string' && cfg.token) {
              token = cfg.token
              source = 'diffinery login'
            }
          } catch {
            // No config file, or not JSON: the CLI isn't signed in here.
          }
        }
      }
      url = (url ?? DEFAULT_URL).replace(/\/+$/, '')
      const host = hostOf(url) ?? 'diffinery.com'
      if (!token) {
        try {
          const gh = await $.process.run(['gh', 'auth', 'token', '--hostname', host], { timeoutMs: 5000 })
          const t = gh.exitCode === 0 ? gh.stdout.trim() : ''
          if (t && !/\s/.test(t)) {
            token = t
            source = 'gh'
          }
        } catch {
          // gh isn't installed.
        }
      }
      return { url, host, token, source }
    }

    const git = async (dir: string, args: string[]): Promise<string | null> => {
      try {
        const r = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: 5000 })
        return r.exitCode === 0 ? r.stdout.trim() : null
      } catch {
        return null
      }
    }

    const targetIn = async (dir: string, host: string): Promise<Target | null> => {
      const remotes = await git(dir, ['config', '--get-regexp', '^remote\\..*\\.url$'])
      if (!remotes) return null
      const repo = pickRemote(parseRemotes(remotes), host)
      if (!repo) return null
      const branch = await git(dir, ['branch', '--show-current'])
      if (!branch) return null
      const top = (await git(dir, ['rev-parse', '--show-toplevel'])) ?? dir
      return { host, repo, branch, dir: top }
    }

    // The session's directory first, then the last Diffinery checkout seen, then the
    // checkouts one level down (cloud threads start above the repositories they clone).
    const findTarget = async (host: string): Promise<Target | null> => {
      const cwd = await $.session.cwd()
      const tried = new Set<string>()
      for (const dir of [cwd, lastDir]) {
        if (!dir || tried.has(dir)) continue
        tried.add(dir)
        const t = await targetIn(dir, host)
        if (t) return t
      }
      try {
        const entries = await $.fs.list(cwd)
        for (const entry of entries.slice(0, 40)) {
          if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
          const dir = `${cwd.replace(/\/+$/, '')}/${entry.name}`
          if (tried.has(dir)) continue
          const t = await targetIn(dir, host)
          if (t) return t
        }
      } catch {
        // Unreadable directory: nothing below it to show.
      }
      return null
    }

    const fetchPr = async (a: Auth, t: Target): Promise<Pr | null> => {
      const [owner, name] = t.repo.split('/') as [string, string]
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
      if (a.token) headers.Authorization = `Bearer ${a.token}`
      const res = await $.http.fetch(`${a.url}/api/graphql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: QUERY, variables: { o: owner, r: name, b: t.branch } }),
      })
      if (res.status === 401 || res.status === 403) {
        const err = new Error(a.token ? `Diffinery refused the token from ${a.source}` : 'not signed in to Diffinery')
        err.name = 'SignIn'
        throw err
      }
      if (!res.ok) throw new Error(`Diffinery answered ${res.status}`)
      return parsePr(JSON.parse(res.text) as unknown, t)
    }

    // Toasts a change of the checks, and tells Claude once the commit this session pushed settles.
    const settle = async (pr: Pr): Promise<void> => {
      const key = `${pr.repo}#${pr.number}`
      const before = seen.get(key)
      const now = `${pr.sha}:${pr.rollup}`
      seen.set(key, now)
      if (before && before !== now && before.startsWith(pr.sha) && pr.state === 'OPEN') {
        if (pr.rollup === 'pass') $.ui.toast(`PR #${pr.number}: CI passed`)
        if (pr.rollup === 'fail') $.ui.toast(`PR #${pr.number}: CI failed`)
      }
      const branchKey = `${pr.repo}#${pr.branch}`
      const pushed = awaiting.get(branchKey)
      if (!pushed || pushed !== pr.sha || (pr.rollup !== 'pass' && pr.rollup !== 'fail')) return
      awaiting.delete(branchKey)
      if (!watching) return
      const text = wakeText(pr, wakeFor(choice, (await $.session.surfaces()).length > 0))
      // From a timer of its own: a look the person asked for (/diffinery-ci) holds a turn,
      // and a prompt submitted from inside it would wait on that turn.
      if (text) $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))
    }

    const refresh = (): Promise<Look> => {
      if (busy) return busy
      busy = (async () => {
        try {
          auth ??= await readAuth()
          const t = await findTarget(auth.host)
          if (!t) {
            await update($, prAtom, () => null)
            await update($, noteAtom, () => null)
            $.ui.status(undefined)
            failures = 0
            nextAt = (await $.clock.now()) + 60_000
            return { pr: null, note: null }
          }
          lastDir = t.dir
          const pr = await fetchPr(auth, t)
          failures = 0
          await update($, noteAtom, () => null)
          await update($, prAtom, () => pr)
          $.ui.status(pr ? statusText(pr) : undefined)
          if (pr) await settle(pr)
          nextAt = (await $.clock.now()) + pollDelay(pr, 0) * 1000
          return { pr, note: null }
        } catch (err) {
          failures += 1
          const e = err instanceof Error ? err : new Error(String(err))
          const note: Note =
            e.name === 'SignIn'
              ? { kind: 'signin', text: `${e.message}. Set DIFFINERY_TOKEN, run \`diffinery login\`, or \`diffinery auth setup-gh\`.` }
              : { kind: 'error', text: `Couldn't read CI from Diffinery: ${e.message}` }
          if (e.name === 'SignIn') auth = null // read the token again next time: the person may sign in meanwhile
          await update($, noteAtom, () => note)
          $.ui.log(`${PLUGIN}: ${note.text}`, { to: 'debug' })
          nextAt = (await $.clock.now()) + pollDelay(null, failures) * 1000
          return { pr: await read($, prAtom), note }
        } finally {
          busy = null
        }
      })()
      return busy
    }

    refreshNow = refresh
    notePublished = async () => {
      auth ??= await readAuth()
      const t = await findTarget(auth.host)
      const head = t ? await git(t.dir, ['rev-parse', 'HEAD']) : null
      if (t && head) awaiting.set(`${t.repo}#${t.branch}`, head)
      nextAt = (await $.clock.now()) + 3000
    }

    await $.command.register({
      name: 'diffinery-ci',
      description: "Show this branch's Diffinery pull request and its CI checks (on/off: tell Claude when CI settles; notes: which results)",
      argumentHint: '[on|off|refresh|notes auto|failures|all|off]',
    })
    void refresh()
    // A cheap tick: it only looks at the clock until a look is due.
    $.clock.every(2000, () => {
      void $.clock.now().then(now => {
        if (now >= nextAt) void refresh()
      })
    })
    return started
  })

  on('command.run', { command: 'diffinery-ci' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const [verb, value] = arg.split(/\s+/)
    if (verb === 'notes') {
      const picked = wakeChoice(value)
      if (!picked) return { text: `Diffinery CI: Claude is told about ${NOTES[choice]}. Choose with /diffinery-ci notes auto|failures|all|off.` }
      choice = picked
      await $.store.set('wake', picked)
      return { text: `Diffinery CI: from now on Claude is told about ${NOTES[picked]}, in this and later sessions.` }
    }
    if (arg === 'off' || arg === 'on') {
      watching = arg === 'on'
      await update($, watchingAtom, () => watching)
      return {
        text:
          arg === 'on'
            ? `Diffinery CI: Claude will be told when CI settles on a commit this session pushed (${NOTES[choice]}).`
            : 'Diffinery CI: Claude will not be told when CI settles in this session. The band and status line still update.',
      }
    }
    await update($, hiddenAtom, () => false)
    // What this look found: a hook's own reads see the state as its dispatch began.
    const { pr, note } = (await refreshNow?.()) ?? { pr: null, note: null }
    if (arg !== 'refresh') await $.ui.open({ id: PANE, title: 'Diffinery CI' })
    if (note) return { text: `Diffinery CI: ${note.text}` }
    if (!pr) return { text: 'Diffinery CI: no pull request for this branch on Diffinery.' }
    const facts = factsLine(pr)
    return { text: `Diffinery CI: PR #${pr.number} ${pr.title}: ${checksLine(pr.checks)}${facts ? ` · ${facts}` : ''}. ${pr.url}` }
  })

  // After a command that may change the branch, its PR or its checks, look again soon; after
  // a push or `pr create` from this session, watch the pushed commit.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = e.command
    if (!touchesPr(command) || 'deny' in ran || ran.isError) return ran
    // Never let the look-again get in the way of the call's own result.
    if (publishes(command)) void notePublished?.().catch(() => undefined)
    else void $.clock.now().then(now => (nextAt = now + 3000), () => undefined)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)
    const pr = await read($, prAtom)
    const note = await read($, noteAtom)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    if (!pr) {
      if (note?.kind !== 'signin') return next(e)
      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text color="warning">Diffinery CI:</Text>
          <Text dimColor>{note.text}</Text>
        </Box>
      )
    }
    const facts = factsLine(pr)
    const symbol = pr.state === 'MERGED' ? '◆' : pr.state === 'CLOSED' ? '◇' : SYMBOL[pr.rollup === 'none' ? 'wait' : pr.rollup]
    const color = pr.state !== 'OPEN' ? 'merged' : COLOR[pr.rollup === 'none' ? 'wait' : pr.rollup]
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text color={color}>{symbol}</Text>
        <Text bold>PR #{pr.number}</Text>
        <Text wrap="truncate-end">{pr.title.length > 60 ? `${pr.title.slice(0, 59)}…` : pr.title}</Text>
        {pr.state === 'OPEN' && <Text color={color}>{checksLine(pr.checks)}</Text>}
        {facts !== '' && <Text dimColor>{facts}</Text>}
        <Button key="details" label="Checks" plain onPress={() => void $.ui.open({ id: PANE, title: 'Diffinery CI' })} />
        <Link href={pr.url} label="Open" />
        <Button key="hide" label="Hide" plain dimColor onPress={() => void update($, hiddenAtom, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const pr = await read($, prAtom)
    const note = await read($, noteAtom)
    const isWatching = await read($, watchingAtom)
    const now = await $.clock.now()
    const refreshButton = <Button key="refresh" label="Refresh" onPress={() => void refreshNow?.()} />
    if (!pr) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>{note ? note.text : 'No pull request for this branch on Diffinery yet.'}</Text>
          {refreshButton}
        </Box>
      )
    }
    const facts = factsLine(pr)
    const failed = pr.state === 'OPEN' && pr.rollup === 'fail'
    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          <Text bold>
            PR #{pr.number} {pr.title}
          </Text>
          <Text dimColor>
            {pr.repo} · {pr.branch} · {pr.sha.slice(0, 7)}
            {facts ? ` · ${facts}` : ''}
          </Text>
          <Link href={pr.url} label="Open on Diffinery" />
        </Box>
        <Box flexDirection="column">
          {pr.checks.length === 0 && <Text dimColor>No checks on this commit yet.</Text>}
          {ordered(pr.checks).map(c => (
            <Box key={`check-${c.workflow ?? ''}-${c.name}`} flexDirection="row" columnGap={1}>
              <Text color={COLOR[c.state]}>{SYMBOL[c.state]}</Text>
              <Text>{c.name}</Text>
              {c.workflow && <Text dimColor>{c.workflow}</Text>}
              <Text dimColor>{duration(c, now)}</Text>
              {c.url && <Link href={c.url} label="log" />}
            </Box>
          ))}
        </Box>
        {note && <Text color="warning">{note.text}</Text>}
        <Box flexDirection="row" columnGap={2}>
          {refreshButton}
          {failed && (
            <Button
              key="fix"
              label="Fix CI"
              variant="primary"
              onPress={() => {
                const text = wakeText(pr, 'failures')
                if (text) void $.prompt.submit({ text })
              }}
            />
          )}
          <Button
            key="watch"
            label={isWatching ? 'Stop telling Claude' : 'Tell Claude when CI settles'}
            onPress={() => {
              watching = !isWatching
              void update($, watchingAtom, () => watching)
            }}
          />
        </Box>
      </Box>
    )
  })
}
