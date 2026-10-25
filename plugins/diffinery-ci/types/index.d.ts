/** One check on the pull request's head commit, as Diffinery reports it. */
export type CheckState = 'pass' | 'fail' | 'run' | 'wait' | 'skip'

export type Check = {
  name: string
  workflow: string | null
  state: CheckState
  url: string | null
  startedAt: string | null
  completedAt: string | null
}

/** What the checks come to: any failure fails, else anything unfinished runs. */
export type Rollup = 'pass' | 'fail' | 'run' | 'none'

/** The branch's pull request and its checks. */
export type Pr = {
  host: string
  repo: string
  branch: string
  number: number
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  review: string | null
  mergeState: string | null
  autoMerge: boolean
  sha: string
  rollup: Rollup
  checks: Check[]
}

/** Why the band has no pull request to show, when that is worth a word. */
export type Note = { kind: 'signin' | 'error'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'diffinery-ci': {
      pr: Shaped<Pr | null>
      note: Shaped<Note | null>
      watching: boolean
      isHidden: boolean
    }
  }
}
