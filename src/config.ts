import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/**
 * pi-rsi configuration. Sources, later ones winning key by key:
 *
 * 1. the defaults below;
 * 2. `<agentDir>/rsi.json` (personal, usually `~/.pi/agent/rsi.json`);
 * 3. `<project>/.pi/rsi.json`, only while the project is trusted;
 * 4. the `--rsi-mode` flag.
 *
 * Objects merge recursively; arrays and scalars replace.
 */

export type Mode = 'learn' | 'frozen' | 'off'
export type ThinkingSetting = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface RoleRouteConfig {
  /** Provider id, e.g. `anthropic`. Empty: the provider of the session's current model. */
  provider?: string
  /** Model id. Empty: the session's current model. */
  model?: string
  /** Thinking level for this role. Empty: the session's current level. */
  thinking?: ThinkingSetting
}

export interface Config {
  mode: Mode
  /** Durable memory, drafts, journal, reports. Empty: `<agentDir>/rsi/projects/<project>-<hash>/memory`. */
  memoryDir: string
  /** Lineage work roots, private lineage records, results. Empty: `<agentDir>/rsi/projects/<project>-<hash>`. */
  stateDir: string
  /** Memory inventory lines (names and sizes only) placed in the Actor's system prompt. */
  promptInventory: number
  /** Persist role transcripts as pi session files under the lineage record (inspect them with `pi --session`). */
  persistRoleSessions: boolean
  roles: {
    actor: RoleRouteConfig
    verifier: RoleRouteConfig
    curriculum: RoleRouteConfig
    escalation: RoleRouteConfig
  }
  memory: {
    maxFileBytes: number
    maxTotalBytes: number
    maxFiles: number
    keepHistory: boolean
  }
  audit: {
    sealedTexts: string[]
    shingleWords: number
  }
  verifier: {
    isolation: 'auto' | 'sandbox' | 'rollback'
    allowUnverified: boolean
    taskMessages: number
    /** Tools of every Verifier context. `write` and `edit` are always removed. */
    tools: string[]
    checkpointMaxBytes: number
    checkpointMaxFiles: number
    /** Extra absolute paths hidden from every role, in addition to the pi agent directory and pi-rsi state. */
    hiddenPaths: string[]
  }
  transport: {
    actionlessLimit: number
    ceiling: number
  }
  exploration: {
    waveCeiling: number
    waveConcurrency: number
    broadProjectBudget: number
    deepPracticeBudget: number
    targetCycleBudget: number
    unverifiedRounds: number
    targetResumes: number
    branchRetries: number
    stopPolicy: 'curriculum_review' | 'verifier_pass'
    curriculumMemoryAccess: 'read_only' | 'none'
  }
  evaluation: {
    command: string[]
    timeoutSec: number
    retries: number
  }
}

export const DEFAULT_CONFIG: Config = {
  mode: 'learn',
  memoryDir: '',
  stateDir: '',
  promptInventory: 40,
  persistRoleSessions: true,
  roles: { actor: {}, verifier: {}, curriculum: {}, escalation: {} },
  memory: { maxFileBytes: 64 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxFiles: 400, keepHistory: true },
  audit: { sealedTexts: [], shingleWords: 8 },
  verifier: {
    isolation: 'auto',
    allowUnverified: true,
    taskMessages: 3,
    tools: ['read', 'grep', 'find', 'ls', 'bash'],
    checkpointMaxBytes: 256 * 1024 * 1024,
    checkpointMaxFiles: 20_000,
    hiddenPaths: [],
  },
  transport: { actionlessLimit: 3, ceiling: 24 },
  exploration: {
    waveCeiling: 16,
    waveConcurrency: 1,
    broadProjectBudget: 12,
    deepPracticeBudget: 6,
    targetCycleBudget: 6,
    unverifiedRounds: 3,
    targetResumes: 1,
    branchRetries: 1,
    stopPolicy: 'curriculum_review',
    curriculumMemoryAccess: 'read_only',
  },
  evaluation: { command: [], timeoutSec: 900, retries: 2 },
}

/** Tools a Verifier context never receives, whatever `verifier.tools` lists. */
export const VERIFIER_DENIED_TOOLS = new Set(['write', 'edit'])

export class ConfigError extends Error {}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Recursive merge: objects merge, everything else replaces. Unknown keys are reported, never silently kept. */
function merge(base: unknown, override: unknown, path: string, unknown: string[]): unknown {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override
  const out: Record<string, unknown> = { ...base }
  // A role route starts empty: its keys are checked by `validate`, not by the defaults' shape.
  const route = /^roles\.[^.]+$/.test(path)
  for (const [key, value] of Object.entries(override)) {
    const where = path ? `${path}.${key}` : key
    if (!(key in base) && !route) {
      unknown.push(where)
      continue
    }
    out[key] = key in base ? merge(base[key], value, where, unknown) : value
  }
  return out
}

const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function check(condition: boolean, message: string): void {
  if (!condition) throw new ConfigError(message)
}

function natural(value: unknown, path: string, min = 0): void {
  check(typeof value === 'number' && Number.isInteger(value) && value >= min, `${path} must be an integer >= ${min}`)
}

function strings(value: unknown, path: string): void {
  check(Array.isArray(value) && value.every(item => typeof item === 'string'), `${path} must be an array of strings`)
}

function oneOf(value: unknown, path: string, allowed: readonly string[]): void {
  check(typeof value === 'string' && allowed.includes(value), `${path} must be one of ${allowed.join(', ')}`)
}

/** Validates a merged configuration; throws `ConfigError` naming the first bad key. */
export function validate(config: Config): Config {
  oneOf(config.mode, 'mode', ['learn', 'frozen', 'off'])
  check(typeof config.memoryDir === 'string', 'memoryDir must be a string')
  check(typeof config.stateDir === 'string', 'stateDir must be a string')
  natural(config.promptInventory, 'promptInventory')
  check(typeof config.persistRoleSessions === 'boolean', 'persistRoleSessions must be a boolean')
  for (const role of ['actor', 'verifier', 'curriculum', 'escalation'] as const) {
    const route = config.roles[role]
    check(isObject(route), `roles.${role} must be an object`)
    for (const key of Object.keys(route)) check(['provider', 'model', 'thinking'].includes(key), `roles.${role}.${key} is not a known key`)
    if (route.provider !== undefined) check(typeof route.provider === 'string', `roles.${role}.provider must be a string`)
    if (route.model !== undefined) check(typeof route.model === 'string', `roles.${role}.model must be a string`)
    if (route.thinking !== undefined) check(THINKING.has(route.thinking), `roles.${role}.thinking must be one of ${[...THINKING].join(', ')}`)
  }
  for (const role of Object.keys(config.roles)) check(['actor', 'verifier', 'curriculum', 'escalation'].includes(role), `roles.${role} is not a known role`)
  natural(config.memory.maxFileBytes, 'memory.maxFileBytes', 1)
  natural(config.memory.maxTotalBytes, 'memory.maxTotalBytes', 1)
  natural(config.memory.maxFiles, 'memory.maxFiles', 1)
  check(typeof config.memory.keepHistory === 'boolean', 'memory.keepHistory must be a boolean')
  strings(config.audit.sealedTexts, 'audit.sealedTexts')
  natural(config.audit.shingleWords, 'audit.shingleWords', 3)
  oneOf(config.verifier.isolation, 'verifier.isolation', ['auto', 'sandbox', 'rollback'])
  check(typeof config.verifier.allowUnverified === 'boolean', 'verifier.allowUnverified must be a boolean')
  natural(config.verifier.taskMessages, 'verifier.taskMessages', 1)
  check(config.verifier.taskMessages <= 16, 'verifier.taskMessages must be <= 16')
  strings(config.verifier.tools, 'verifier.tools')
  natural(config.verifier.checkpointMaxBytes, 'verifier.checkpointMaxBytes')
  natural(config.verifier.checkpointMaxFiles, 'verifier.checkpointMaxFiles')
  strings(config.verifier.hiddenPaths, 'verifier.hiddenPaths')
  for (const path of config.verifier.hiddenPaths) check(isAbsolute(path), `verifier.hiddenPaths entries must be absolute paths (${path})`)
  natural(config.transport.actionlessLimit, 'transport.actionlessLimit', 1)
  natural(config.transport.ceiling, 'transport.ceiling', 1)
  const ex = config.exploration
  natural(ex.waveCeiling, 'exploration.waveCeiling', 1)
  natural(ex.waveConcurrency, 'exploration.waveConcurrency', 1)
  natural(ex.broadProjectBudget, 'exploration.broadProjectBudget', 1)
  natural(ex.deepPracticeBudget, 'exploration.deepPracticeBudget')
  natural(ex.targetCycleBudget, 'exploration.targetCycleBudget', 1)
  natural(ex.unverifiedRounds, 'exploration.unverifiedRounds', 1)
  natural(ex.targetResumes, 'exploration.targetResumes')
  natural(ex.branchRetries, 'exploration.branchRetries')
  oneOf(ex.stopPolicy, 'exploration.stopPolicy', ['curriculum_review', 'verifier_pass'])
  oneOf(ex.curriculumMemoryAccess, 'exploration.curriculumMemoryAccess', ['read_only', 'none'])
  strings(config.evaluation.command, 'evaluation.command')
  natural(config.evaluation.timeoutSec, 'evaluation.timeoutSec', 1)
  natural(config.evaluation.retries, 'evaluation.retries')
  return config
}

async function readJson(path: string): Promise<Json | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ConfigError(`${path}: ${String(error)}`)
  }
  try {
    return JSON.parse(text) as Json
  } catch (error) {
    throw new ConfigError(`${path}: invalid JSON (${(error as Error).message})`)
  }
}

export interface LoadedConfig {
  config: Config
  /** Files that contributed, in order. */
  sources: string[]
  /** Unknown keys that were ignored, as `file: key`. */
  warnings: string[]
}

export interface LoadOptions {
  agentDir: string
  cwd: string
  /** Project configuration is read only for trusted projects. */
  projectTrusted: boolean
  modeFlag?: string | undefined
}

export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  let merged: unknown = structuredClone(DEFAULT_CONFIG)
  const sources: string[] = []
  const warnings: string[] = []
  const files = [join(options.agentDir, 'rsi.json'), ...(options.projectTrusted ? [join(options.cwd, '.pi', 'rsi.json')] : [])]
  for (const file of files) {
    const value = await readJson(file)
    if (value === undefined) continue
    if (!isObject(value)) throw new ConfigError(`${file}: the top level must be a JSON object`)
    const unknown: string[] = []
    merged = merge(merged, value, '', unknown)
    warnings.push(...unknown.map(key => `${file}: unknown key ${key} ignored`))
    sources.push(file)
  }
  const config = merged as Config
  if (options.modeFlag) {
    oneOf(options.modeFlag, '--rsi-mode', ['learn', 'frozen', 'off'])
    config.mode = options.modeFlag as Mode
  }
  return { config: validate(config), sources, warnings }
}
