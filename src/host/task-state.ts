import type { Verdict } from '../protocol/tokens.ts'

/**
 * Interactive Actor state, folded from the current branch of the pi session.
 * The interactive state tools return their structured outcome as tool-result
 * `details` (`{ rsi: 1, op, … }`); pi stores those on the branch, so the
 * state follows `/tree` navigation, forks, and resumes, and survives a
 * restart. Failed calls carry no details and never advance the state.
 */

export const STATE_TOOLS = ['rsi_submit', 'rsi_learn', 'rsi_memory_commit'] as const
export type StateTool = typeof STATE_TOOLS[number]

export interface ReportRef {
  generation: number
  verdict: Verdict
  sha256: string
  bytes: number
}

export interface LearningRef {
  episode: string
  /** Session that opened the draft; a fork never writes into its parent's draft. */
  owner: string
  stage: 'distill' | 'reconcile'
  outcome: 'PASS' | 'FAIL'
  /** Entry id of the verdict this phase learns from. */
  verdictEntry: string
  /** Assistant message whose tool call entered the current stage; the next stage needs a later message. */
  stageStep: string | null
}

export interface TaskState {
  generation: number
  reports: ReportRef[]
  verdict: Verdict | null
  /** Entry id of the tool result that recorded the verdict. */
  verdictEntry: string | null
  /** Session that recorded the verdict: a fork learns under the episode its origin would use. */
  verdictSession: string | null
  /** User messages on the branch when the verdict was recorded. */
  requestCount: number
  learning: LearningRef | null
  /** Verdict whose learning ended terminally (quarantined): no second learning phase for it. */
  closedVerdictEntry: string | null
}

export type TaskMeta =
  | { rsi: 1, op: 'submit', newTask: boolean, generation: number, verdict: Verdict, requestCount: number, report: { sha256: string, bytes: number }, session: string }
  | { rsi: 1, op: 'learn', learning: Omit<LearningRef, 'stageStep'> }
  | { rsi: 1, op: 'reconcile', episode: string }
  | { rsi: 1, op: 'commit', episode: string }
  | { rsi: 1, op: 'close', episode: string, terminal: boolean }

export function initialTask(): TaskState {
  return { generation: 0, reports: [], verdict: null, verdictEntry: null, verdictSession: null, requestCount: 0, learning: null, closedVerdictEntry: null }
}

/** The structural slice of a pi session entry this fold reads. */
export interface BranchEntry {
  type: string
  id: string
  customType?: string
  data?: unknown
  message?: {
    role?: string
    toolName?: string
    toolCallId?: string
    isError?: boolean
    details?: unknown
    content?: unknown
  }
}

const VERDICTS = new Set(['PASS', 'FAIL', 'UNVERIFIED'])
const SHA256 = /^[0-9a-f]{64}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates details written by an earlier version or edited by hand; anything malformed is ignored. */
export function parseMeta(value: unknown): TaskMeta | undefined {
  if (!isObject(value) || value.rsi !== 1 || typeof value.op !== 'string') return undefined
  const str = (key: string) => typeof value[key] === 'string' && (value[key] as string) !== ''
  switch (value.op) {
    case 'submit': {
      const report = value.report
      if (!isObject(report) || typeof report.sha256 !== 'string' || !SHA256.test(report.sha256) || typeof report.bytes !== 'number') return undefined
      if (typeof value.generation !== 'number' || value.generation < 1 || !VERDICTS.has(value.verdict as string)) return undefined
      if (typeof value.requestCount !== 'number' || typeof value.newTask !== 'boolean' || !str('session')) return undefined
      return value as TaskMeta
    }
    case 'learn': {
      const learning = value.learning
      if (!isObject(learning)) return undefined
      if (typeof learning.episode !== 'string' || typeof learning.owner !== 'string' || typeof learning.verdictEntry !== 'string') return undefined
      if (learning.stage !== 'distill' && learning.stage !== 'reconcile') return undefined
      if (learning.outcome !== 'PASS' && learning.outcome !== 'FAIL') return undefined
      return value as TaskMeta
    }
    case 'reconcile':
    case 'commit':
      return str('episode') ? (value as TaskMeta) : undefined
    case 'close':
      return str('episode') && typeof value.terminal === 'boolean' ? (value as TaskMeta) : undefined
    default:
      return undefined
  }
}

/** Applies one settled state-tool result. */
export function settle(state: TaskState, entryId: string, meta: TaskMeta, step: string | null): TaskState {
  switch (meta.op) {
    case 'submit': {
      const reports = meta.newTask ? [] : state.reports
      return {
        ...state,
        generation: meta.generation,
        reports: [...reports, { generation: meta.generation, verdict: meta.verdict, sha256: meta.report.sha256, bytes: meta.report.bytes }],
        verdict: meta.verdict,
        verdictEntry: entryId,
        verdictSession: meta.session,
        requestCount: meta.requestCount,
      }
    }
    case 'learn':
      return { ...state, learning: { ...meta.learning, stageStep: step } }
    case 'reconcile':
      return state.learning?.episode === meta.episode ? { ...state, learning: { ...state.learning, stage: 'reconcile', stageStep: step } } : state
    case 'commit':
      // A promoted experience completes the task: the next submission starts a new Verifier lineage.
      return initialTask()
    case 'close':
      return {
        ...state,
        learning: state.learning?.episode === meta.episode ? null : state.learning,
        closedVerdictEntry: meta.terminal ? state.verdictEntry : state.closedVerdictEntry,
      }
    default: {
      const unreachable: never = meta
      return unreachable
    }
  }
}

function toolCallIds(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.filter(block => isObject(block) && block.type === 'toolCall' && typeof block.id === 'string').map(block => (block as { id: string }).id)
}

export interface BranchFold {
  state: TaskState
  /** User messages on the branch. */
  requests: number
  /** Assistant entry id per tool call id, for the steps of state-tool calls. */
  stepOf: Map<string, string>
  /** Texts of user messages on the branch, oldest first. */
  requestTexts: string[]
  /** HEAD commit recorded when the current task's first user message arrived, if any. */
  taskBaseline: string | undefined
  /** Index into `requestTexts` of the current task's first user message. */
  taskStart: number
}

/** Custom entry pi-rsi appends before every user prompt: the project's HEAD commit at that moment. */
export const BASELINE_ENTRY = 'pi-rsi-baseline'

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => isObject(block) && block.type === 'text' && typeof block.text === 'string').map(block => (block as { text: string }).text).join('\n')
}

/** Folds the branch (root to leaf) into the task state. */
export function foldBranch(entries: readonly BranchEntry[]): BranchFold {
  let state = initialTask()
  let requests = 0
  const requestTexts: string[] = []
  const stepOf = new Map<string, string>()
  // The task baseline is the HEAD recorded just before the task's first user message; a task ends at a
  // promoted commit, or at a new user message after a PASS (the next submission is a new task).
  let lastBaseline: string | undefined
  let taskBaseline: string | undefined
  let taskStart = 0
  let startsTask = true
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === BASELINE_ENTRY) {
      const head = isObject(entry.data) && typeof entry.data.head === 'string' ? entry.data.head : undefined
      lastBaseline = head
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue
    const message = entry.message
    if (message.role === 'user') {
      requests++
      if (startsTask || (state.verdict === 'PASS' && requests > state.requestCount)) {
        taskBaseline = lastBaseline
        taskStart = requestTexts.length
        startsTask = false
      }
      const body = userText(message.content).trim()
      if (body) requestTexts.push(body)
      continue
    }
    if (message.role === 'assistant') {
      for (const id of toolCallIds(message.content)) stepOf.set(id, entry.id)
      continue
    }
    if (message.role !== 'toolResult' || message.isError === true) continue
    if (!(STATE_TOOLS as readonly string[]).includes(message.toolName ?? '')) continue
    const meta = parseMeta(message.details)
    if (!meta) continue
    state = settle(state, entry.id, meta, (message.toolCallId && stepOf.get(message.toolCallId)) ?? null)
    if (meta.op === 'commit') startsTask = true
  }
  return { state, requests, stepOf, requestTexts, taskBaseline, taskStart }
}

/** State-tool calls of one assistant message (to refuse batching them). */
export function stateCallsInStep(entries: readonly BranchEntry[], step: string): number {
  const entry = entries.find(candidate => candidate.id === step)
  if (!entry?.message || !Array.isArray(entry.message.content)) return 0
  return entry.message.content.filter(block => isObject(block) && block.type === 'toolCall' && (STATE_TOOLS as readonly string[]).includes(block.name as string)).length
}

/** Deterministic episode id: a retried or cancelled rsi_learn reuses the same draft. */
export function episodeFor(sessionId: string, verdictEntry: string): string {
  return `task-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}-${verdictEntry.replace(/[^A-Za-z0-9_-]/g, '_')}`
}
