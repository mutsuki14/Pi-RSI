import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { inspect, formatLeads, type Lead } from '../engine/steps.ts'
import type { Verdict } from '../protocol/tokens.ts'
import { MemoryConflictError, MemoryFrozenError, MemoryQuarantineError, type MemoryStore } from '../memory/store.ts'
import { disagreementMessage, distillationMessage, memoryRevisit, reconciliationMessage, unverifiedMessage } from '../roles/actor.ts'
import { verifierSystem } from '../roles/verifier.ts'
import { GitMetadataCheckpoint, WorkspaceCheckpoint } from './checkpoint.ts'
import { workspaceState } from './git.ts'
import { roleSettings, type Host } from './host.ts'
import { memoryReadTools, memoryWriteTools, type MemoryToolHooks } from './memory-tools.ts'
import { classifyLeads } from './probes.ts'
import type { RoleEvent, ThinkingLevel } from './role-runtime.ts'
import { episodeFor, foldBranch, stateCallsInStep, type BranchEntry, type BranchFold, type TaskMeta } from './task-state.ts'
import { UsageMeter } from './usage.ts'

export interface InteractiveDeps {
  pi: ExtensionAPI
  /** The host for the session's project; throws when pi-rsi is off or misconfigured. */
  host(ctx: ExtensionContext): Promise<Host>
}

type ToolResult = { content: Array<{ type: 'text', text: string }>, details: TaskMeta | undefined, usage?: import('@earendil-works/pi-ai').Usage }

const result = (text: string, details?: TaskMeta, usage?: UsageMeter): ToolResult => {
  const snapshot = usage?.snapshot()
  return { content: [{ type: 'text', text }], details, ...(snapshot ? { usage: snapshot } : {}) }
}

function branchOf(ctx: ExtensionContext): BranchEntry[] {
  return ctx.sessionManager.getBranch() as unknown as BranchEntry[]
}

function sessionIdOf(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId()
}

/** The authoritative task: the latest user messages of the current task on this branch, verbatim. */
function authoritativeTask(fold: BranchFold, count: number): string {
  // Never older than the task's first message: a finished task's requests are not this task's requirements.
  const recent = fold.requestTexts.slice(Math.max(fold.taskStart, fold.requestTexts.length - count))
  if (recent.length === 0) return '(no user request was found in this session)'
  if (recent.length === 1) return recent[0]!
  return recent.map((request, index) => `[user message ${index + 1} of ${recent.length}${index === recent.length - 1 ? ', latest' : ''}]\n${request}`).join('\n\n')
}

/** Refuses state tools batched in one assistant message: each stage must be read before the next. */
function requireSingleStateCall(branch: BranchEntry[], fold: BranchFold, toolCallId: string, tool: string): string | null {
  const step = fold.stepOf.get(toolCallId) ?? null
  if (step && stateCallsInStep(branch, step) > 1) {
    throw new Error(`${tool}: call only one of rsi_submit, rsi_learn, and rsi_memory_commit per message, and read its result before the next`)
  }
  return step
}

export function registerInteractive({ pi, host: hostOf }: InteractiveDeps): void {
  const frozen = async (host: Host, store: MemoryStore) => host.config.mode === 'frozen' || (await store.frozen())

  /** The learning draft this session owns, reopened from disk if needed; frozen memory never serves a draft. */
  const ownedDraft = async (ctx: ExtensionContext, host: Host, store: MemoryStore) => {
    const learning = foldBranch(branchOf(ctx)).state.learning
    if (!learning || learning.owner !== sessionIdOf(ctx)) return undefined
    if (await frozen(host, store)) return undefined
    return store.reopenDraft(learning.episode)
  }

  const hooks: MemoryToolHooks = {
    view: async (_tool, ctx) => {
      const host = await hostOf(ctx)
      const store = await host.store()
      const draft = await ownedDraft(ctx, host, store)
      return draft ? { store, dir: draft.dir, draft } : { store, dir: store.canonicalDir }
    },
    writable: async (tool, ctx) => {
      const host = await hostOf(ctx)
      const store = await host.store()
      if (await frozen(host, store)) throw new Error(`${tool}: memory is frozen for test-time reuse; it cannot change`)
      const draft = await ownedDraft(ctx, host, store)
      if (draft) return { store, dir: draft.dir, draft }
      const learning = foldBranch(branchOf(ctx)).state.learning
      if (learning && learning.owner !== sessionIdOf(ctx)) throw new Error(`${tool}: the open learning phase belongs to another session; call rsi_learn to open this session's own`)
      if (learning) throw new Error(`${tool}: the learning draft no longer exists; call rsi_learn to reopen the learning phase`)
      throw new Error(`${tool}: durable memory is read-only while you work. It changes only in a learning phase after an independent verdict (rsi_submit, then rsi_learn).`)
    },
    changed: async ctx => {
      await (await hostOf(ctx)).refreshInventory().catch(() => undefined)
    },
  }
  for (const tool of [...memoryReadTools(hooks), ...memoryWriteTools(hooks)]) pi.registerTool(tool)

  pi.registerTool({
    name: 'rsi_submit',
    // The task state lives on the branch as this tool's result details: never callable from other tools.
    exposure: 'model-only',
    label: 'RSI verification',
    description: 'Submit the current task for independent verification. An isolated Verifier Agent inspects the live result against the user\'s recent messages, verbatim, without seeing your reasoning or memory, and returns PASS, FAIL, or UNVERIFIED with a report. The same Verifier context inspects every revision of one task.',
    promptSnippet: 'Request independent verification of a completed non-trivial task',
    promptGuidelines: ['Call rsi_submit when a non-trivial task with a checkable result is complete; skip it for questions and conversation.'],
    parameters: Type.Object({
      evidence_leads: Type.Optional(Type.Array(Type.Object({
        claim: Type.String({ description: 'The requirement the probe demonstrates.' }),
        probe: Type.String({ description: 'One exact read-only shell command that prints PASS only when the claim holds.' }),
      }), { description: 'Only after UNVERIFIED: reproducible evidence leads. Each pairs a requirement with one exact read-only command the Verifier can re-run. Never a narrative of your own work.' })),
    }),
    executionMode: 'sequential',
    async execute(toolCallId, params: { evidence_leads?: Array<{ claim: string, probe: string }> }, signal, onUpdate, ctx) {
      const host = await hostOf(ctx)
      const sessionId = sessionIdOf(ctx)
      const branch = branchOf(ctx)
      const fold = foldBranch(branch)
      requireSingleStateCall(branch, fold, toolCallId, 'rsi_submit')
      const task = fold.state
      const store = await host.store()
      // While memory is frozen no learning phase can finish, so an open one does not block verification.
      if (task.learning && task.learning.owner === sessionId && !(await frozen(host, store))) {
        throw new Error('a learning phase is open; finish it with rsi_memory_commit before submitting again')
      }
      const isolation = await host.isolation()
      const cwd = host.paths.project
      const newTask = task.verdict === 'PASS' && fold.requests > task.requestCount
      if (newTask) await host.closeVerifier(sessionId)
      const generation = (newTask ? 0 : task.generation) + 1
      const excludes = host.harnessExcludes()
      signal?.throwIfAborted()
      const before = await workspaceState(cwd, excludes, fold.taskBaseline)
      let checkpoint: WorkspaceCheckpoint
      let gitMeta: GitMetadataCheckpoint | undefined
      try {
        checkpoint = await WorkspaceCheckpoint.take(cwd, excludes, { maxBytes: host.config.verifier.checkpointMaxBytes, maxFiles: host.config.verifier.checkpointMaxFiles })
        gitMeta = await GitMetadataCheckpoint.take(cwd).catch(async error => {
          await checkpoint.dispose()
          throw error
        })
      } catch (error) {
        throw new Error(`the candidate could not be checkpointed (${String(error)}). This is an infrastructure failure, not a verdict.`)
      }

      const usage = new UsageMeter()
      const progress = (event: RoleEvent) => {
        if (event.type === 'tool') onUpdate?.({ content: [{ type: 'text', text: `Verifier: ${event.detail}` }], details: undefined })
      }
      let inspection
      let changed: string[] = []
      try {
        let live = host.verifiers.get(sessionId)
        const fresh = live === undefined
        if (!live) {
          const runtime = await host.roleRuntime(ctx, {
            thinking: pi.getThinkingLevel() as ThinkingLevel,
            settings: roleSettings(pi.getSettings() as unknown as Record<string, unknown>),
            usage,
            ...(host.config.persistRoleSessions ? { sessionDir: `${host.paths.lineages}/interactive/${sessionId}` } : {}),
            observe: progress,
          })
          live = {
            runtime,
            conversation: await runtime.open({
              role: 'verifier',
              label: `interactive verifier ${sessionId.slice(0, 8)}`,
              system: verifierSystem(host.config.verifier.allowUnverified, isolation.mode),
              cwd,
              memory: { access: 'none' },
            }),
          }
          host.verifiers.set(sessionId, live)
        } else {
          // A persisting Verifier reports this call's usage and progress.
          live.runtime.rebind(usage, progress)
        }
        const priorReports: string[] = []
        if (fresh && !newTask) {
          for (const ref of task.reports) priorReports.push((await store.getReport(ref.sha256)) ?? `(report unavailable: generation ${ref.generation}, ${ref.verdict}, sha256 ${ref.sha256})`)
        }
        let leads: string | undefined
        if (task.verdict === 'UNVERIFIED' && params.evidence_leads?.length) {
          const given: Lead[] = params.evidence_leads.map(lead => ({ claim: lead.claim ?? '', probe: lead.probe ?? '' })).filter(lead => lead.probe.trim() !== '')
          // Probes run after the checkpoint: their effects are restored with the Verifier's.
          if (given.length > 0) {
            leads = formatLeads(await classifyLeads(given, { cwd, isolation, hidden: host.hiddenPaths(ctx), scratchRoot: host.paths.scratch, timeoutMs: 60_000, ...(signal ? { signal } : {}) }))
          }
        }
        inspection = await inspect(live.conversation, {
          task: authoritativeTask(fold, host.config.verifier.taskMessages),
          generation,
          mechanicalContext: before.summary,
          ...(leads ? { leads } : {}),
          ...(priorReports.length > 0 ? { priorReports } : {}),
          allowUnverified: host.config.verifier.allowUnverified,
          policy: host.config.transport,
          ...(signal ? { signal } : {}),
        })
      } catch (error) {
        await host.closeVerifier(sessionId)
        throw error
      } finally {
        try {
          changed = await checkpoint.restore()
          if (gitMeta) changed = [...changed, ...(await gitMeta.restore())]
        } finally {
          await checkpoint.dispose()
          await gitMeta?.dispose()
        }
      }
      if (signal?.aborted) {
        await host.closeVerifier(sessionId)
        signal.throwIfAborted()
      }
      if (inspection.kind === 'infra') {
        await host.closeVerifier(sessionId)
        const snapshot = usage.snapshot()
        return {
          content: [{ type: 'text' as const, text: `verification is unavailable: ${inspection.reason}. This is an infrastructure failure, not a verdict.` }],
          details: undefined,
          isError: true,
          ...(snapshot ? { usage: snapshot } : {}),
        }
      }
      try {
        const note = changed.length === 0
          ? ''
          : checkpoint.restores
            ? `\n\nHARNESS NOTE: ${changed.length} path(s) changed during the inspection and were restored: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ', …' : ''}`
            : `\n\nHARNESS NOTE: ${changed.length} path(s) changed during the inspection; the workspace was too large to checkpoint, so inspect them: ${changed.slice(0, 20).join(', ')}`
        const ref = await store.putReport(inspection.report)
        const learn = !(await frozen(host, store))
        const verdict: Verdict = inspection.verdict
        let guidance: string
        switch (verdict) {
          case 'PASS':
            guidance = `VERDICT: PASS\n\nThe independent Verifier verified the task. Report:\n---\n${inspection.report.trim()}\n---${learn ? '\nNext: call rsi_learn to distill this experience into durable memory.' : ''}`
            break
          case 'FAIL':
            guidance = `VERDICT: FAIL\n\n${disagreementMessage(inspection.report)}\n\n${memoryRevisit('verifier')}${learn ? '\nIf you decide to stop repairing, call rsi_learn: a FAIL still teaches.' : ''}`
            break
          case 'UNVERIFIED':
            guidance = `VERDICT: UNVERIFIED\n\n${unverifiedMessage(inspection.report)}\n\n${memoryRevisit('verifier')}\nThen call rsi_submit again with evidence_leads.`
            break
          default: {
            const unreachable: never = verdict
            throw new Error(`unknown verdict ${String(unreachable)}`)
          }
        }
        return result(guidance + note, { rsi: 1, op: 'submit', newTask, generation, verdict, requestCount: fold.requests, report: ref, session: sessionId }, usage)
      } catch (error) {
        // The Verifier published a verdict the branch never records: its context must not carry it into the next inspection.
        await host.closeVerifier(sessionId)
        throw error
      }
    },
  })

  pi.registerTool({
    name: 'rsi_learn',
    // The task state lives on the branch as this tool's result details: never callable from other tools.
    exposure: 'model-only',
    label: 'RSI learn',
    description: 'Open the learning phase after a terminal verdict (PASS, or FAIL when you stop repairing): distill this experience into a memory draft, then rsi_memory_commit.',
    promptSnippet: 'Open the learning phase after a terminal verification verdict',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
      const host = await hostOf(ctx)
      const store = await host.store()
      if (await frozen(host, store)) throw new Error('memory is frozen for test-time reuse; no learning phase exists')
      const sessionId = sessionIdOf(ctx)
      const branch = branchOf(ctx)
      const fold = foldBranch(branch)
      requireSingleStateCall(branch, fold, toolCallId, 'rsi_learn')
      const task = fold.state
      if (task.verdict !== 'PASS' && task.verdict !== 'FAIL') throw new Error('rsi_learn needs a terminal Verifier verdict first: call rsi_submit (UNVERIFIED is not terminal)')
      if (task.verdictEntry === null) throw new Error('rsi_learn needs a recorded verdict')
      if (task.closedVerdictEntry === task.verdictEntry) throw new Error('the learning phase for this verdict already ended; durable memory was not changed')
      const episode = episodeFor(sessionId, task.verdictEntry)
      // A verdict is shared by the session that recorded it and every fork: it is learned once.
      const origin = episodeFor(task.verdictSession ?? sessionId, task.verdictEntry)
      for (const candidate of new Set([episode, origin])) {
        if (await store.findCommit(candidate)) {
          return result('This experience was already promoted to durable memory; there is nothing left to learn from it.', { rsi: 1, op: 'commit', episode })
        }
        if (await store.isQuarantined(candidate)) throw new Error('the learning phase for this verdict already ended; durable memory was not changed')
      }
      // The attempt is over: the Verifier context ends before learning starts.
      await host.closeVerifier(sessionId)
      // A draft this branch never opened (another branch's, or a cancelled call's) is not reused.
      await store.openDraft(episode, { fresh: task.learning?.episode !== episode })
      const last = task.reports.at(-1)
      const report = (last && (await store.getReport(last.sha256))) ?? '(the final report is in your history above)'
      return result(distillationMessage(task.verdict, report, 'actor', store.limits), {
        rsi: 1,
        op: 'learn',
        learning: { episode, owner: sessionId, stage: 'distill', outcome: task.verdict, verdictEntry: task.verdictEntry },
      })
    },
  })

  pi.registerTool({
    name: 'rsi_memory_commit',
    // The task state lives on the branch as this tool's result details: never callable from other tools.
    exposure: 'model-only',
    label: 'RSI memory commit',
    description: 'Learning phase: the first call asks you to reconcile the whole draft; the second call promotes it atomically to durable memory.',
    promptSnippet: 'Learning phase: reconcile, then promote the memory draft',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
      const host = await hostOf(ctx)
      const sessionId = sessionIdOf(ctx)
      const branch = branchOf(ctx)
      const fold = foldBranch(branch)
      const step = requireSingleStateCall(branch, fold, toolCallId, 'rsi_memory_commit')
      const task = fold.state
      const learning = task.learning
      if (!learning) throw new Error('no learning phase is open; call rsi_learn after a terminal verdict')
      if (learning.owner !== sessionId) throw new Error('the open learning phase belongs to another session; call rsi_learn to open this session\'s own')
      const origin = episodeFor(task.verdictSession ?? sessionId, learning.verdictEntry)
      const store = await host.store()
      if ((await store.findCommit(learning.episode)) || (await store.findCommit(origin))) {
        await store.discardDraft(learning.episode)
        await host.refreshInventory()
        return result('This learning phase was already promoted to durable memory.', { rsi: 1, op: 'commit', episode: learning.episode })
      }
      if (await frozen(host, store)) {
        return result('Memory is frozen for test-time reuse, so nothing was promoted. The draft is kept; after memory is unfrozen, call rsi_learn to continue this learning phase.', { rsi: 1, op: 'close', episode: learning.episode, terminal: false })
      }
      // Each stage's instructions must be read before the next stage: never in the same message.
      if (learning.stageStep !== null && step !== null && learning.stageStep === step) {
        throw new Error(`call rsi_memory_commit in a later message, after acting on the ${learning.stage === 'distill' ? 'distillation' : 'reconciliation'} instructions above`)
      }
      if (learning.stage === 'distill') return result(reconciliationMessage('actor'), { rsi: 1, op: 'reconcile', episode: learning.episode })
      const draft = await store.reopenDraft(learning.episode)
      if (!draft) {
        if ((await store.isQuarantined(learning.episode)) || (await store.isQuarantined(origin))) {
          return result('this learning phase could not be promoted; durable memory is unchanged', { rsi: 1, op: 'close', episode: learning.episode, terminal: true })
        }
        return result('The learning draft no longer exists, so nothing was promoted. Call rsi_learn to redo the learning phase against the current memory.', { rsi: 1, op: 'close', episode: learning.episode, terminal: false })
      }
      try {
        const record = await store.commit(draft, { kind: 'task', outcome: learning.outcome, origin })
        await host.refreshInventory()
        return result(
          `Memory promoted (${record.outcome} experience). created: ${record.created.join(', ') || '-'}; modified: ${record.modified.join(', ') || '-'}; deleted: ${record.deleted.join(', ') || '-'}. Tree ${record.treeAfter.slice(0, 12)}, ${record.files} files.`,
          { rsi: 1, op: 'commit', episode: learning.episode },
        )
      } catch (error) {
        if (error instanceof MemoryConflictError) {
          await store.discardDraft(learning.episode)
          return result(`${error.message}. Nothing was promoted; call rsi_learn to redo the learning phase.`, { rsi: 1, op: 'close', episode: learning.episode, terminal: false })
        }
        if (error instanceof MemoryFrozenError) {
          return result(`${error.message}. The draft is kept; after memory is unfrozen, call rsi_learn to continue this learning phase.`, { rsi: 1, op: 'close', episode: learning.episode, terminal: false })
        }
        if (error instanceof MemoryQuarantineError) {
          return result(error.message, { rsi: 1, op: 'close', episode: learning.episode, terminal: true })
        }
        // Limits and I/O failures keep the draft open: trim or fix it, then commit again.
        throw error
      }
    },
  })
}
