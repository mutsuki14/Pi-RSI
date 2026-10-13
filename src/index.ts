import { lstat, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { ConfigError, loadConfig, type LoadedConfig } from './config.ts'
import type { EngineEvent } from './engine/types.ts'
import { actorProtocol, memoryPreamble, memoryRevisit } from './roles/actor.ts'
import { describeEvent, newLineageId, runExploration, validateRequest, type ExploreRequest } from './host/explore.ts'
import { Host, roleSettings, snapshotModels } from './host/host.ts'
import { registerInteractive } from './host/interactive.ts'
import type { PiRoleRuntime, ThinkingLevel } from './host/role-runtime.ts'
import { isWithin, physical } from './host/sandbox.ts'
import { runSealedEvaluation } from './host/sealed.ts'
import { BASELINE_ENTRY, foldBranch, type BranchEntry } from './host/task-state.ts'
import { headCommit } from './host/git.ts'
import { UsageMeter } from './host/usage.ts'

export { Host } from './host/host.ts'
export { PiRoleRuntime } from './host/role-runtime.ts'
export * as engine from './engine/index.ts'

const INTERACTIVE_TOOLS = ['rsi_memory_list', 'rsi_memory_read', 'rsi_memory_search', 'rsi_memory_write', 'rsi_memory_delete', 'rsi_submit', 'rsi_learn', 'rsi_memory_commit', 'rsi_explore']
const LEARNING_TOOLS = new Set(['rsi_memory_write', 'rsi_memory_delete', 'rsi_learn', 'rsi_memory_commit', 'rsi_explore'])

/**
 * pi-rsi: RSIAgent-style recursive self-improvement for the pi coding agent.
 *
 * The main pi agent is the Actor. It reuses its own durable experience
 * memory, asks an independent Verifier Agent to judge finished work, and
 * distills verified experience into memory in a learning phase. Curriculum-
 * driven exploration lineages (Phase 1 broad, Phase 2 deep) run Actor,
 * Verifier, and Curriculum contexts as in-process pi sessions.
 */
export default function piRsi(pi: ExtensionAPI): void {
  pi.registerFlag('rsi-mode', { type: 'string', description: 'pi-rsi mode for this run: learn | frozen | off' })

  let host: Host | undefined
  let hostError: string | undefined
  /** Memory re-offer owed to the next run (compaction or resume), RSIAgent `_memory_revisit`. */
  let revisit: 'fold' | 'recovery' | undefined

  const agentDir = () => getAgentDir()

  const ensureHost = async (ctx: ExtensionContext): Promise<Host> => {
    const cwd = ctx.sessionManager.getCwd()
    if (host && host.paths.project === physical(cwd)) return host
    let loaded: LoadedConfig
    try {
      const flag = pi.getFlag('rsi-mode')
      loaded = await loadConfig({ agentDir: agentDir(), cwd, projectTrusted: ctx.isProjectTrusted(), modeFlag: typeof flag === 'string' ? flag : undefined })
    } catch (error) {
      hostError = error instanceof ConfigError ? error.message : String(error)
      throw new Error(`pi-rsi configuration error: ${hostError}`)
    }
    await host?.dispose()
    host = new Host(loaded, agentDir(), cwd)
    hostError = undefined
    return host
  }

  const activeHost = async (ctx: ExtensionContext): Promise<Host> => {
    const current = await ensureHost(ctx)
    if (current.config.mode === 'off') throw new Error('pi-rsi is off (mode "off"); enable it in rsi.json or with --rsi-mode')
    return current
  }

  /** Tools follow the mode: none when off, read-only memory and verification when frozen. */
  const applyMode = async (current: Host) => {
    const store = current.config.mode === 'off' ? undefined : await current.store()
    const frozen = current.config.mode === 'frozen' || (store ? await store.frozen() : false)
    const before = pi.getActiveTools()
    const active = new Set(before)
    for (const tool of INTERACTIVE_TOOLS) {
      const on = current.config.mode !== 'off' && !(frozen && LEARNING_TOOLS.has(tool))
      if (on) active.add(tool)
      else active.delete(tool)
    }
    // Only a real change: any call is a new loadout for pi, which drops tools waiting to be restored.
    if (active.size !== before.length || before.some(tool => !active.has(tool))) pi.setActiveTools([...active])
  }

  const status = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI || !host) return
    if (host.config.mode === 'off') {
      ctx.ui.setStatus('rsi', undefined)
      return
    }
    const store = await host.store()
    const frozen = host.config.mode === 'frozen' || (await store.frozen())
    const files = host.inventory()?.length ?? 0
    const fold = foldBranch(ctx.sessionManager.getBranch() as unknown as BranchEntry[])
    const task = fold.state.learning ? ` · learning (${fold.state.learning.stage})` : fold.state.verdict ? ` · ${fold.state.verdict} g${fold.state.generation}` : ''
    const exploring = host.exploration ? ` · exploring ${host.exploration.lineage}` : ''
    ctx.ui.setStatus('rsi', `RSI ${frozen ? 'frozen' : 'learn'} · ${files} mem${task}${exploring}`)
  }

  pi.on('session_start', async (event, ctx) => {
    try {
      const current = await ensureHost(ctx)
      if (current.config.mode !== 'off') await current.store()
      await applyMode(current)
      for (const warning of current.loaded.warnings) if (ctx.hasUI) ctx.ui.notify(`pi-rsi: ${warning}`, 'warning')
      // A resumed conversation (also `pi -c` / `--session`, which start with reason "startup") gets RSIAgent's recovery re-offer.
      const resumed = event.reason === 'resume' || event.reason === 'fork'
        || (event.reason === 'startup' && ctx.sessionManager.getBranch().some(entry => entry.type === 'message'))
      if (resumed) revisit = 'recovery'
      await status(ctx)
    } catch (error) {
      if (!ctx.hasUI) throw error
      ctx.ui.notify(String(error instanceof Error ? error.message : error), 'error')
    }
  })

  pi.on('session_tree', async (_event, ctx) => {
    // The branch changed under the live Verifier: its task, charters, and reports belong to the old branch.
    await host?.closeVerifier(ctx.sessionManager.getSessionId()).catch(() => undefined)
    await status(ctx).catch(() => undefined)
  })

  pi.on('session_compact', async () => {
    revisit = 'fold'
  })

  pi.on('session_shutdown', async () => {
    const current = host
    host = undefined
    await current?.dispose()
  })

  pi.on('agent_end', async (_event, ctx) => {
    await status(ctx).catch(() => undefined)
  })

  pi.on('before_agent_start', async (event, ctx) => {
    let current: Host
    try {
      current = await ensureHost(ctx)
    } catch {
      return undefined
    }
    if (current.config.mode === 'off') return undefined
    let frozen = current.config.mode === 'frozen'
    let memory: string
    try {
      const store = await current.store()
      frozen ||= await store.frozen()
      memory = memoryPreamble(current.inventory() ?? (await store.inventory()), current.config.promptInventory)
    } catch (error) {
      // A damaged store must not block the user's turn; the tools report the details.
      memory = `[YOUR MEMORY — unavailable: ${error instanceof Error ? error.message : String(error)}]`
    }
    event.systemPromptOptions.sections.rsi_protocol = actorProtocol(frozen ? 'frozen' : 'learn', current.config.verifier.allowUnverified)
    event.systemPromptOptions.sections.rsi_memory = memory
    if (event.messageType === 'user') {
      // The project's HEAD as this prompt arrives: the Verifier's change facts span the whole task.
      const head = await headCommit(current.paths.project).catch(() => undefined)
      if (head) pi.appendEntry(BASELINE_ENTRY, { head })
    }
    if (revisit && event.messageType === 'user') {
      const kind = revisit
      revisit = undefined
      return { message: { customType: 'pi-rsi', content: memoryRevisit(kind), display: false } }
    }
    return undefined
  })

  registerInteractive({ pi, host: activeHost })

  // The main Actor changes durable memory only through a learning phase: a tripwire for direct edits.
  pi.on('tool_call', async (event, ctx) => {
    if (!host || host.config.mode === 'off') return undefined
    const input = event.input as Record<string, unknown>
    const store = host.paths.memory
    const named = (value: unknown) => {
      if (typeof value !== 'string' || value === '') return false
      const path = value.replace(/^@/, '').replace(/^~(?=$|\/)/, homedir())
      const full = physical(isAbsolute(path) ? path : join(ctx.cwd, path))
      return isWithin(full, physical(store))
    }
    const direct = (event.toolName === 'write' || event.toolName === 'edit') && named(input.path)
    const shell = event.toolName === 'bash' && typeof input.command === 'string' && (input.command.includes(store) || input.command.includes(physical(store)))
    if (!direct && !shell) return undefined
    return { block: true, reason: 'durable memory changes only in a learning phase, through rsi_learn, rsi_memory_write / rsi_memory_delete, and rsi_memory_commit' }
  })

  // ---------------------------------------------------------------- exploration
  const runLineage = async (ctx: ExtensionContext, request: ExploreRequest, signal: AbortSignal | undefined, progress: (line: string) => void, usage = new UsageMeter()) => {
    const current = await activeHost(ctx)
    const store = await current.store()
    if (current.config.mode === 'frozen' || (await store.frozen())) throw new Error('memory is frozen for test-time reuse; exploration lineages learn, so they are disabled')
    const problem = validateRequest(request)
    if (problem) throw new Error(problem)
    if (current.exploration) throw new Error(`lineage ${current.exploration.lineage} is already running in this project; stop it with /rsi-explore stop`)
    // Claimed before any await, so two starts can never run side by side.
    const controller = new AbortController()
    const lineage = request.lineage ?? newLineageId(request.phase)
    const state: NonNullable<Host['exploration']> = { lineage, controller, started: Date.now(), phase: request.phase }
    current.exploration = state
    let finished!: () => void
    state.done = new Promise<void>(resolve => { finished = resolve })
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) controller.abort()
    let runtime: PiRoleRuntime | undefined
    try {
      if (await lstat(join(current.paths.lineages, lineage)).then(() => true, () => false)) {
        throw new Error(`lineage ${lineage} already exists; choose a new lineage id`)
      }
      const thinking = pi.getThinkingLevel() as ThinkingLevel
      const isolation = await current.isolation()
      runtime = await current.roleRuntime(ctx, {
        thinking,
        settings: roleSettings(pi.getSettings() as unknown as Record<string, unknown>),
        usage,
        ...(current.config.persistRoleSessions ? { sessionDir: join(current.paths.lineages, lineage, 'sessions') } : {}),
        observe: event => {
          if (event.type === 'open') progress(`${event.label}: opened (${event.detail})`)
        },
      })
      const { result } = await runExploration({
        config: current.config,
        paths: current.paths,
        store,
        runtime,
        isolation,
        hidden: current.hiddenPaths(ctx),
        crossModelVerifier: current.crossModel(snapshotModels(ctx), thinking),
        observe: (event: EngineEvent) => {
          const line = describeEvent(event)
          if (line) progress(line)
        },
        signal: controller.signal,
      }, { ...request, lineage })
      await current.refreshInventory()
      return { lineage, result, usage }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await runtime?.closeAll()
      if (current.exploration === state) current.exploration = undefined
      finished()
    }
  }

  pi.registerTool({
    name: 'rsi_explore',
    exposure: 'model-only',
    label: 'RSI exploration',
    description: 'Run a curriculum-driven exploration lineage that improves durable memory without a user task. phase "broad" (Phase 1): a Curriculum Agent authors waves of practice projects within a search direction; each is attempted by a fresh Actor, judged by a fresh Verifier, and learned in order. phase "deep" (Phase 2): fresh Actors attempt an immutable target; outcomes are learned and the Curriculum chooses focused practice until it is ready or stalls. Blocks until the lineage ends; can take a long time and many model calls.',
    promptSnippet: 'Run a broad or deep self-exploration lineage (long-running)',
    promptGuidelines: ['Use rsi_explore only when the user asks for exploration or practice; it runs many model calls.'],
    parameters: Type.Object({
      phase: Type.Union([Type.Literal('broad'), Type.Literal('deep')], { description: 'broad = Phase 1 waves; deep = Phase 2 target-conditioned practice.' }),
      direction: Type.Optional(Type.String({ description: 'broad: the search direction, i.e. the allowed task distribution to explore.' })),
      target: Type.Optional(Type.String({ description: 'deep: the immutable target task; name <PROJECT_ROOT> for the directory the Actor works in.' })),
      target_fixtures: Type.Optional(Type.String({ description: 'deep: a directory (relative to the project) whose files are replayed into every target attempt.' })),
      lineage: Type.Optional(Type.String({ description: 'Optional lineage id (lowercase letters, digits, "_" and "-").' })),
    }),
    executionMode: 'sequential',
    async execute(_id, params: { phase: 'broad' | 'deep', direction?: string, target?: string, target_fixtures?: string, lineage?: string }, signal, onUpdate, ctx) {
      const request: ExploreRequest = {
        phase: params.phase,
        ...(params.direction !== undefined ? { direction: params.direction } : {}),
        ...(params.target !== undefined ? { target: params.target } : {}),
        ...(params.target_fixtures !== undefined ? { targetFixtures: params.target_fixtures } : {}),
        ...(params.lineage !== undefined ? { lineage: params.lineage } : {}),
      }
      const problem = validateRequest(request)
      if (problem) throw new Error(problem)
      const lines: string[] = []
      const usage = new UsageMeter()
      try {
        const { lineage, result } = await runLineage(ctx, request, signal, line => {
          lines.push(line)
          onUpdate?.({ content: [{ type: 'text', text: lines.slice(-12).join('\n') }], details: undefined })
        }, usage)
        const snapshot = usage.snapshot()
        return {
          content: [{ type: 'text', text: `Lineage ${lineage} ended: ${result.termination}.\n${JSON.stringify(result, null, 2)}\n\nRole usage: ${usage.summary()}` }],
          details: undefined,
          ...(snapshot ? { usage: snapshot } : {}),
        }
      } catch (error) {
        // An unscored or cancelled lineage still spent its role calls: report them with the failure.
        const snapshot = usage.snapshot()
        return {
          content: [{ type: 'text', text: `The lineage ended unscored: ${error instanceof Error ? error.message : String(error)}\n\nRole usage: ${usage.summary()}` }],
          details: undefined,
          isError: true,
          ...(snapshot ? { usage: snapshot } : {}),
        }
      }
    },
  })

  // ---------------------------------------------------------------- commands
  const lineageList = async (current: Host): Promise<string[]> => {
    const names = await readdir(current.paths.lineages).catch(() => [] as string[])
    const out: string[] = []
    for (const name of names.sort()) {
      if (name === 'interactive') continue
      const result = await readFile(join(current.paths.lineages, name, 'result.json'), 'utf8').then(text => JSON.parse(text) as { termination?: string, verdict?: string }, () => undefined)
      out.push(`${name}: ${result ? `${result.termination}${result.verdict ? ` (${result.verdict})` : ''}` : 'unfinished'}`)
    }
    return out
  }

  pi.registerCommand('rsi', {
    description: 'pi-rsi status: memory, isolation, task state, recent commits, lineages',
    handler: async (_args, ctx) => {
      let current: Host
      try {
        current = await ensureHost(ctx)
      } catch (error) {
        ctx.ui.notify(String(error instanceof Error ? error.message : error), 'error')
        return
      }
      const lines = [`pi-rsi mode: ${current.config.mode}`, `config: ${current.loaded.sources.join(', ') || '(defaults)'}`]
      if (current.config.mode !== 'off') {
        const store = await current.store()
        const isolation = await current.isolation().catch(error => ({ mode: 'unavailable', reason: String(error) }))
        const journal = await store.journal()
        const integrity = await store.integrity()
        const fold = foldBranch(ctx.sessionManager.getBranch() as unknown as BranchEntry[])
        lines.push(
          `memory: ${store.canonicalDir} (${(await store.inventory()).length} files, tree ${(await store.treeHash()).slice(0, 12)}${(await store.frozen()) ? ', FROZEN' : ''})`,
          `state: ${current.paths.state}`,
          `verifier isolation: ${isolation.mode} — ${isolation.reason}`,
          `task: ${fold.state.verdict ? `${fold.state.verdict} at generation ${fold.state.generation}` : 'no verdict yet'}${fold.state.learning ? `; learning ${fold.state.learning.stage} (${fold.state.learning.episode})` : ''}`,
          `commits: ${journal.length}${journal.length ? ` — latest ${journal.at(-1)!.episode} (${journal.at(-1)!.outcome}, ${journal.at(-1)!.ts})` : ''}`,
        )
        if (!integrity.consistent) lines.push(`WARNING: memory tree ${integrity.canonical.slice(0, 12)} differs from the last journal record (${integrity.recorded.slice(0, 12)}): it was changed outside a learning phase`)
        if (current.exploration) lines.push(`exploring: ${current.exploration.lineage} (${current.exploration.phase}) for ${Math.round((Date.now() - current.exploration.started) / 1000)}s`)
        const lineages = await lineageList(current)
        if (lineages.length) lines.push('lineages:', ...lineages.slice(-10).map(line => `  ${line}`))
      }
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })

  pi.registerCommand('rsi-freeze', {
    description: 'Freeze durable memory for test-time reuse (Phase 3)',
    handler: async (_args, ctx) => {
      const current = await activeHost(ctx)
      const store = await current.store()
      const tree = await store.freeze()
      await applyMode(current)
      await status(ctx)
      ctx.ui.notify(`pi-rsi: memory frozen at tree ${tree.slice(0, 12)}`, 'info')
    },
  })

  pi.registerCommand('rsi-unfreeze', {
    description: 'Unfreeze durable memory (checks the frozen tree first)',
    handler: async (_args, ctx) => {
      const current = await activeHost(ctx)
      if (current.config.mode === 'frozen') {
        ctx.ui.notify('pi-rsi: mode "frozen" is configured; change rsi.json or --rsi-mode to unfreeze', 'warning')
        return
      }
      const store = await current.store()
      await store.unfreeze()
      await applyMode(current)
      await status(ctx)
      ctx.ui.notify('pi-rsi: memory unfrozen', 'info')
    },
  })

  pi.registerCommand('rsi-explore', {
    description: 'Run an exploration lineage: /rsi-explore broad <direction> | deep <target naming <PROJECT_ROOT>> | stop',
    getArgumentCompletions: prefix => ['broad ', 'deep ', 'stop'].filter(option => option.startsWith(prefix)).map(value => ({ value, label: value.trim() })),
    handler: async (args, ctx: ExtensionCommandContext) => {
      const [phase, ...rest] = args.trim().split(/\s+/)
      const text = args.trim().slice((phase ?? '').length).trim()
      if (phase === 'stop') {
        const current = await ensureHost(ctx)
        if (!current.exploration) ctx.ui.notify('pi-rsi: no lineage is running', 'info')
        else {
          current.exploration.controller.abort()
          ctx.ui.notify(`pi-rsi: stopping ${current.exploration.lineage}`, 'info')
        }
        return
      }
      if ((phase !== 'broad' && phase !== 'deep') || rest.length === 0) {
        ctx.ui.notify('usage: /rsi-explore broad <direction> | /rsi-explore deep <target naming <PROJECT_ROOT>> | /rsi-explore stop', 'warning')
        return
      }
      const request: ExploreRequest = phase === 'broad' ? { phase, direction: text } : { phase, target: text }
      const problem = validateRequest(request)
      if (problem) {
        ctx.ui.notify(`pi-rsi: ${problem}`, 'warning')
        return
      }
      if (!ctx.hasUI) {
        // Print and JSON modes end the session when the command returns: run the lineage in the foreground.
        try {
          const { lineage, result, usage } = await runLineage(ctx, request, undefined, line => process.stderr.write(`pi-rsi: ${line}\n`))
          process.stderr.write(`pi-rsi: lineage ${lineage} ended: ${result.termination} (${usage.summary()})\n`)
        } catch (error) {
          process.stderr.write(`pi-rsi: exploration ended unscored: ${error instanceof Error ? error.message : String(error)}\n`)
        }
        return
      }
      ctx.ui.notify(`pi-rsi: ${phase} exploration started; /rsi shows progress, /rsi-explore stop ends it`, 'info')
      // The command's context goes stale when the session is replaced; UI updates are best-effort.
      const ui = (update: () => void) => {
        try {
          if (ctx.hasUI) update()
        } catch {
          // The session this command ran in is gone.
        }
      }
      // Runs in the background so the session stays usable; progress goes to the status line.
      void runLineage(ctx, request, undefined, line => {
        if (host?.exploration) host.exploration.last = line
        ui(() => ctx.ui.setStatus('rsi', `RSI exploring · ${line.slice(0, 80)}`))
      }).then(({ lineage, result, usage }) => {
        ui(() => ctx.ui.notify(`pi-rsi: lineage ${lineage} ended: ${result.termination} (${usage.summary()})`, 'info'))
      }, error => {
        ui(() => ctx.ui.notify(`pi-rsi: exploration ended unscored: ${error instanceof Error ? error.message : String(error)}`, 'error'))
      }).finally(() => {
        ui(() => void status(ctx).catch(() => undefined))
      })
    },
  })

  pi.registerCommand('rsi-eval', {
    description: 'Sealed evaluation of a finished deep lineage: /rsi-eval <lineage>',
    getArgumentCompletions: async prefix => {
      if (!host) return null
      const names = await readdir(host.paths.lineages).catch(() => [] as string[])
      return names.filter(name => name.startsWith('deep-') && name.startsWith(prefix)).map(value => ({ value, label: value }))
    },
    handler: async (args, ctx) => {
      const current = await activeHost(ctx)
      const lineage = args.trim()
      if (!lineage) {
        ctx.ui.notify('usage: /rsi-eval <lineage id>', 'warning')
        return
      }
      if (current.config.evaluation.command.length === 0) {
        ctx.ui.notify('pi-rsi: no sealed evaluator is configured (evaluation.command in rsi.json)', 'warning')
        return
      }
      if (current.exploration) {
        ctx.ui.notify('pi-rsi: a lineage is running; sealed evaluation runs only after every role context has ended', 'warning')
        return
      }
      const store = await current.store()
      const runId = new Date().toISOString().replace(/[:.]/g, '-')
      const record = await runSealedEvaluation({
        lineage,
        lineageDir: join(current.paths.lineages, lineage),
        resultsDir: current.paths.results,
        runId,
        store,
        config: current.config.evaluation,
      })
      await applyMode(current)
      ctx.ui.notify(`pi-rsi: sealed evaluation of ${lineage}: ${record.status}${record.score === undefined ? '' : `, score ${record.score}`} (written to ${join(current.paths.results, lineage, runId)})`, 'info')
    },
  })
}
