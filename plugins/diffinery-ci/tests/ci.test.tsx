import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  checksLine,
  parsePr,
  pollDelay,
  publishes,
  remoteRepo,
  statusText,
  touchesPr,
  wakeFor,
  wakeText,
} from '../hooks/lib'

const TARGET = { host: 'diffinery.com', repo: 'codician/demo', branch: 'feature/x', dir: '/work/demo' }

const run = (name: string, status: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://diffinery.com/codician/demo/actions/runs/r1/job/${name.length}`,
  startedAt: '2026-10-23T10:00:00.000Z',
  completedAt: status === 'COMPLETED' ? '2026-10-23T10:01:05.000Z' : null,
  checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
})

const answer = (sha: string, contexts: unknown[], extra: Record<string, unknown> = {}) => ({
  data: {
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 7,
            title: 'Add retries',
            url: 'https://diffinery.com/codician/demo/pull/7',
            state: 'OPEN',
            isDraft: false,
            reviewDecision: 'REVIEW_REQUIRED',
            mergeStateStatus: 'BLOCKED',
            headRefOid: sha,
            autoMergeRequest: { enabledAt: '2026-10-23T10:00:00Z' },
            commits: { nodes: [{ commit: { oid: sha, statusCheckRollup: { state: 'PENDING', contexts: { nodes: contexts } } } }] },
            ...extra,
          },
        ],
      },
    },
  },
})

test('remotes on the Diffinery host are read, lookalikes are not', async () => {
  expect(remoteRepo('https://diffinery.com/codician/demo.git', 'diffinery.com')).toBe('codician/demo')
  expect(remoteRepo('https://x-token@diffinery.com/codician/demo', 'diffinery.com')).toBe('codician/demo')
  expect(remoteRepo('git@diffinery.com:codician/demo.git', 'diffinery.com')).toBe('codician/demo')
  expect(remoteRepo('ssh://git@diffinery.com:22/codician/demo.git', 'diffinery.com')).toBe('codician/demo')
  expect(remoteRepo('https://diffinery.com.evil.example/codician/demo', 'diffinery.com')).toBe(null)
  expect(remoteRepo('https://github.com/codician/demo', 'diffinery.com')).toBe(null)
  expect(remoteRepo('https://diffinery.com/codician/demo/extra', 'diffinery.com')).toBe(null)
  expect(remoteRepo('https://diffinery.com/../demo', 'diffinery.com')).toBe(null)
})

test('the answer reads into a pull request with its checks', async () => {
  const pr = parsePr(
    answer('abc1234def', [
      run('Typecheck', 'COMPLETED', 'SUCCESS'),
      run('Unit tests', 'IN_PROGRESS', null),
      run('Lint', 'COMPLETED', 'FAILURE'),
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS', targetUrl: 'https://example.com' },
    ]),
    TARGET,
  )
  expect(pr?.number).toBe(7)
  expect(pr?.rollup).toBe('fail')
  expect(pr?.autoMerge).toBe(true)
  expect(pr && checksLine(pr.checks)).toBe('✗ 1 failed · ● 1 running · ✓ 2')
  expect(pr && statusText(pr)).toBe('PR #7 ✗ 1 failed')
  expect(parsePr({ data: { repository: { pullRequests: { nodes: [] } } } }, TARGET)).toBe(null)
  expect(() => parsePr({ errors: [{ message: 'nope' }] }, TARGET)).toThrow('nope')
})

test('Claude is told about failures, and about passes only when asked', async () => {
  const failing = parsePr(answer('abc1234def', [run('Lint', 'COMPLETED', 'FAILURE')]), TARGET)!
  const passing = parsePr(answer('abc1234def', [run('Lint', 'COMPLETED', 'SUCCESS')]), TARGET)!
  expect(wakeText(failing, 'failures')).toContain('Diffinery CI failed on codician/demo#7')
  expect(wakeText(failing, 'failures')).toContain('CI / Lint')
  expect(wakeText(failing, 'off')).toBe(null)
  expect(wakeText(passing, 'failures')).toBe(null)
  expect(wakeText(passing, 'all')).toContain('Diffinery CI passed')
  // Unset, it tells about passes too where nothing draws the band.
  expect(wakeFor('auto', true)).toBe('failures')
  expect(wakeFor('auto', false)).toBe('all')
  expect(wakeFor('off', false)).toBe('off')
})

test('it looks often while checks run, rarely when nothing moves, and backs off on errors', async () => {
  const running = parsePr(answer('abc1234def', [run('Lint', 'IN_PROGRESS', null)]), TARGET)!
  const done = parsePr(answer('abc1234def', [run('Lint', 'COMPLETED', 'SUCCESS')]), TARGET)!
  const merged = parsePr(answer('abc1234def', [], { state: 'MERGED' }), TARGET)!
  expect(pollDelay(running, 0)).toBe(15)
  expect(pollDelay(done, 0)).toBe(60)
  expect(pollDelay(merged, 0)).toBe(300)
  expect(pollDelay(null, 0)).toBe(60)
  expect([1, 2, 3, 4, 9].map(n => pollDelay(null, n))).toEqual([30, 60, 120, 240, 240])
})

test('the commands that publish or move a branch are recognised', async () => {
  expect(publishes('cd demo && git push -u origin feature/x')).toBe(true)
  expect(publishes('git -C demo push')).toBe(true)
  expect(publishes('cd demo && git -c http.extraHeader="Authorization: Bearer $TOKEN" push -u origin feature/x')).toBe(true)
  expect(publishes("git -c credential.helper='!f() { echo password=$T; }; f' -C demo push")).toBe(true)
  expect(publishes('git --no-pager -c push.default=current --git-dir=demo/.git push')).toBe(true)
  expect(publishes('git --work-tree demo -P push origin HEAD')).toBe(true)
  expect(publishes('git -c core.pager=cat log --oneline')).toBe(false)
  expect(publishes('git config push.default current')).toBe(false)
  expect(publishes('git commit -m "push later"')).toBe(false)
  expect(publishes('diffinery pr create --intent x')).toBe(true)
  expect(publishes('gh pr view')).toBe(false)
  expect(touchesPr('gh pr view')).toBe(true)
  expect(touchesPr('git switch main')).toBe(true)
  expect(touchesPr('git -c user.name="A B" -c user.email=a@b.c commit -qam x')).toBe(true)
  expect(touchesPr('git -c core.pager=cat log')).toBe(false)
  expect(touchesPr('ls -la')).toBe(false)
})

// A session in /work, with a Diffinery checkout at /work/demo one level down (as in a cloud
// thread), signed in through DIFFINERY_TOKEN. `server` is what Diffinery answers.
type Server = { body: unknown; status?: number; head: string; seen: string[]; token?: string | null; surfaces?: ('terminal' | 'mobile')[]; store?: Map<string, unknown> }

function engine(on: On, server: Server) {
  const store = (server.store ??= new Map())
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('session.surfaces', () => ({ value: server.surfaces ?? ['terminal'] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_, e) => (server.seen.push(`log ${JSON.stringify(e)}`), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', (_, e) => ({ value: e.name === 'DIFFINERY_TOKEN' ? (server.token === null ? undefined : 'dfy_test') : e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.list', (_, e) => ({
    value: e.path === '/work' ? [{ name: 'demo', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] : [],
  }))
  on('process.run', (_, e) => {
    const [cmd, , dir, ...args] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (cmd !== 'git' || dir !== '/work/demo') return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }
    if (args[0] === 'config') return ok('remote.origin.url https://diffinery.com/codician/demo.git\n')
    if (args[0] === 'branch') return ok('feature/x\n')
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok('/work/demo\n')
    if (args[0] === 'rev-parse') return ok(`${server.head}\n`)
    return ok('')
  })
  on('http.fetch', (_, e) => {
    server.seen.push(`${e.url} ${e.init?.headers?.Authorization ?? 'no-auth'}`)
    const status = server.status ?? 200
    return { value: { status, ok: status < 400, headers: {}, text: JSON.stringify(server.body) } }
  })
  on('tool.call', () => ({ result: {} }))
}

const BAND = {
  plugin: 'diffinery-ci',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, rows: 10, bodyColumns: 100 },
} as const

const PANE = {
  plugin: 'diffinery-ci',
  component: 'Pane',
  requestId: 'diffinery-ci',
  props: { title: 'Diffinery CI', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the band and the pane show the branch PR and its checks, on every surface', async ($, on) => {
  const server = {
    body: answer('abc1234def', [run('Typecheck', 'COMPLETED', 'SUCCESS'), run('Lint', 'COMPLETED', 'FAILURE')]),
    head: 'abc1234def',
    seen: [] as string[],
  }
  engine(on, server)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'diffinery-ci', args: 'refresh' })

  expect(server.seen[0]).toBe('https://diffinery.com/api/graphql Bearer dfy_test')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /PR #7/ }))?.text).toBe('PR #7')
    expect((await ui.find({ type: 'Text', text: /failed/ }))?.text).toBe('✗ 1 failed · ✓ 1')
    await ui.unmount()
  }
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Lint/ })).toBeDefined()
    expect(await ui.find({ key: 'fix' })).toBeDefined()
    await ui.unmount()
  }
})

test('a push from the session is watched, and Claude hears once its checks fail', async ($, on) => {
  const server = {
    body: answer('old0000000', [run('Lint', 'COMPLETED', 'FAILURE')]),
    head: 'new1111111',
    seen: [] as string[],
  }
  engine(on, server)
  const clock = mock.clock(on, { now: 1_000_000 })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'cd demo && git push origin feature/x' })
  await clock.advance(1000)

  // Diffinery still reports the old commit's failure: nothing to say about the new one yet.
  await $.command.run({ command: 'diffinery-ci', args: 'refresh' })
  expect(prompts).toEqual([])

  server.body = answer('new1111111', [run('Lint', 'IN_PROGRESS', null)])
  await $.command.run({ command: 'diffinery-ci', args: 'refresh' })
  expect(prompts).toEqual([])

  server.body = answer('new1111111', [run('Lint', 'COMPLETED', 'FAILURE')])
  await $.command.run({ command: 'diffinery-ci', args: 'refresh' })
  await clock.advance(10)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Diffinery CI failed on codician/demo#7')

  // Once per pushed commit.
  await $.command.run({ command: 'diffinery-ci', args: 'refresh' })
  await clock.advance(10)
  expect(prompts.length).toBe(1)
})

test('without a token the band says how to sign in', async ($, on) => {
  const server = { body: { message: 'Requires authentication' }, status: 401, head: 'abc', seen: [] as string[], token: null }
  engine(on, server)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'diffinery-ci', args: 'refresh' })
  expect(out.text).toContain('not signed in to Diffinery')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /diffinery login/ })).toBeDefined()
  await ui.unmount()
})

// A cloud session draws nothing: the band can't show a pass, so Claude is told about it too.
test('where nothing draws, Claude also hears when CI passes; notes picks which results', async ($, on) => {
  const server: Server = { body: answer('new1111111', [run('Lint', 'IN_PROGRESS', null)]), head: 'new1111111', seen: [], surfaces: [] }
  engine(on, server)
  const clock = mock.clock(on, { now: 1_000_000 })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: 'cd demo && git push origin feature/x' })
  await clock.advance(1000)
  server.body = answer('new1111111', [run('Lint', 'COMPLETED', 'SUCCESS')])
  await $.command.run({ command: 'diffinery-ci', args: 'refresh' })
  await clock.advance(10)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Diffinery CI passed on codician/demo#7')

  const out = await $.command.run({ command: 'diffinery-ci', args: 'notes failures' })
  expect(out.text).toContain('from now on Claude is told about failures')
  expect(server.store?.get('wake')).toBe('failures')
  expect((await $.command.run({ command: 'diffinery-ci', args: 'notes' })).text).toContain('Claude is told about failures.')
})
