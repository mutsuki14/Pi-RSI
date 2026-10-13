import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { Config } from '../config.ts'
import { captureTree, shapeGate } from '../engine/fixtures.ts'
import { runBroadExploration, runDeepExploration, type BroadResult, type DeepResult, type EngineConfig } from '../engine/lineage.ts'
import type { EngineEvent } from '../engine/types.ts'
import type { MemoryStore } from '../memory/store.ts'
import { PROJECT_ROOT_PLACEHOLDER } from '../protocol/wave.ts'
import { classifyLeads } from './probes.ts'
import type { PiRoleRuntime } from './role-runtime.ts'
import type { IsolationDecision } from './sandbox.ts'
import { prepareWorkRoot, type ProjectPaths } from './stores.ts'

export interface ExploreRequest {
  phase: 'broad' | 'deep'
  /** Phase 1 search direction (the allowed task distribution). */
  direction?: string
  /** Phase 2 immutable target; should name <PROJECT_ROOT>. */
  target?: string
  /** Phase 2: a directory whose files are replayed into every target attempt's project root. */
  targetFixtures?: string
  /** Optional lineage id; generated when omitted. */
  lineage?: string
}

export function engineConfig(config: Config, isolation: IsolationDecision, crossModelVerifier: boolean): EngineConfig {
  const ex = config.exploration
  const escalation = Boolean(config.roles.escalation.model || config.roles.escalation.provider)
  return {
    waveCeiling: ex.waveCeiling,
    waveConcurrency: ex.waveConcurrency,
    broadProjectBudget: ex.broadProjectBudget,
    deepPracticeBudget: ex.deepPracticeBudget,
    targetCycleBudget: ex.targetCycleBudget,
    unverifiedRounds: ex.unverifiedRounds,
    targetResumes: ex.targetResumes,
    branchRetries: ex.branchRetries,
    inventoryListed: config.promptInventory,
    stopPolicy: ex.stopPolicy,
    curriculumMemoryAccess: ex.curriculumMemoryAccess,
    transport: config.transport,
    verifierMechanics: isolation.mode,
    escalation,
    crossModelVerifier: escalation && crossModelVerifier,
  }
}

const LINEAGE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** `<phase>-<utc stamp>-<random>`: sortable and unique per project. */
export function newLineageId(phase: 'broad' | 'deep', now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase()
  return `${phase}-${stamp}-${randomBytes(3).toString('hex')}`
}

export function validateRequest(request: ExploreRequest): string | undefined {
  if (request.lineage !== undefined && !LINEAGE_ID.test(request.lineage)) return 'lineage ids use lowercase letters, digits, "_" and "-" (at most 64 characters)'
  if (request.phase === 'broad') {
    if (!request.direction?.trim()) return 'a broad lineage needs a search direction (the allowed task distribution)'
    if (request.target || request.targetFixtures) return 'target and target_fixtures belong to deep lineages'
    return undefined
  }
  if (!request.target?.trim()) return 'a deep lineage needs an immutable target'
  if (request.direction) return 'direction belongs to broad lineages'
  if (!request.target.includes(PROJECT_ROOT_PLACEHOLDER)) {
    return `the target must name ${PROJECT_ROOT_PLACEHOLDER} for the directory the Actor works in, e.g. "In ${PROJECT_ROOT_PLACEHOLDER}, …"`
  }
  return undefined
}

export interface ExploreDeps {
  config: Config
  paths: ProjectPaths
  store: MemoryStore
  runtime: PiRoleRuntime
  isolation: IsolationDecision
  hidden: readonly string[]
  crossModelVerifier: boolean
  observe: (event: EngineEvent) => void
  signal?: AbortSignal
}

/** Runs one Phase 1 or Phase 2 lineage to its end; infrastructure and cancellation reject. */
export async function runExploration(deps: ExploreDeps, request: ExploreRequest): Promise<{ lineage: string, result: BroadResult | DeepResult }> {
  const problem = validateRequest(request)
  if (problem) throw new Error(problem)
  const lineage = request.lineage ?? newLineageId(request.phase)
  await prepareWorkRoot(deps.paths.work)
  const paths = { workspace: join(deps.paths.work, lineage), private: join(deps.paths.lineages, lineage) }
  const engine = {
    runtime: deps.runtime,
    store: deps.store,
    config: engineConfig(deps.config, deps.isolation, deps.crossModelVerifier),
    observe: deps.observe,
    ...(deps.signal ? { signal: deps.signal } : {}),
    classifyLeads: (leads: Parameters<typeof classifyLeads>[0], root: string, signal?: AbortSignal) =>
      classifyLeads(leads, { cwd: root, isolation: deps.isolation, hidden: deps.hidden, scratchRoot: deps.paths.scratch, timeoutMs: 60_000, ...(signal ? { signal } : {}) }),
  }
  if (request.phase === 'broad') {
    return { lineage, result: await runBroadExploration(engine, { lineage, direction: request.direction!.trim(), paths }) }
  }
  let targetFixtures
  if (request.targetFixtures) {
    const source = resolve(deps.paths.project, request.targetFixtures)
    const shape = await shapeGate(source)
    if (shape) throw new Error(`target_fixtures ${source} is not replayable: ${shape}`)
    targetFixtures = await captureTree(source, join(paths.private, 'target-fixtures'))
  }
  return {
    lineage,
    result: await runDeepExploration(engine, { lineage, target: request.target!.trim(), paths, ...(targetFixtures ? { targetFixtures } : {}) }),
  }
}

/** One-line progress text for an engine event. */
export function describeEvent(event: EngineEvent): string | undefined {
  const get = (key: string) => (event[key] === undefined ? '' : String(event[key]))
  switch (event.type) {
    case 'WAVE_AUTHORED': return `wave ${get('wave')} authored: ${(event.projects as string[] | undefined)?.join(', ') ?? ''}`
    case 'PROJECT_SUBMITTED': return `project ${get('project')} submitted`
    case 'PROJECT_VERIFIED': return `project ${get('project')} generation ${get('generation')}: ${get('verdict')}`
    case 'PROJECT_RESTARTED_UNSCORED': return `project ${get('project')} restarted (infrastructure: ${get('reason')})`
    case 'MEMORY_COMMITTED': return `memory committed after ${get('project')} (tree ${get('tree').slice(0, 12)})`
    case 'WAVE_COMPLETED': return `wave ${get('wave')} completed`
    case 'WAVE_BLOCKED': return `wave ${get('wave')} blocked: ${get('reason')}`
    case 'PHASE1_TERMINATED': return `phase 1 ended: ${get('termination')}`
    case 'TARGET_STARTED': return `target attempt ${get('targetCycle')} started`
    case 'TARGET_VERIFIED': return `target attempt ${get('targetCycle')} generation ${get('generation')}: ${get('verdict')}`
    case 'TARGET_STALLED': return `target attempt ${get('targetCycle')} stalled: ${get('reason')}`
    case 'TARGET_RESUMED': return `target attempt ${get('targetCycle')} resumed (${get('escalated') === 'true' ? 'escalation route' : 'same route'})`
    case 'TARGET_LEARNING_COMPLETED': return `target attempt ${get('targetCycle')} learned (tree ${get('tree').slice(0, 12)})`
    case 'CURRICULUM_DECIDED': return `curriculum: ${get('decision')}`
    case 'PRACTICE_LEARNING_COMPLETED': return `practice ${get('project')} learned (tree ${get('tree').slice(0, 12)})`
    case 'TARGET_LOOP_TERMINATED': return `phase 2 ended: ${get('termination')} (${get('verdict')})`
    case 'VERIFIER_EFFECTS_ROLLED_BACK': return `verifier effects on ${get('candidate')} rolled back`
    case 'LINEAGE_ABORTED': return `lineage ended unscored: ${get('termination')} — ${get('reason')}`
    default: return undefined
  }
}
