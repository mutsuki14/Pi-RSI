import { join, relative, isAbsolute } from 'node:path'
import { ModelRuntime, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { VERIFIER_DENIED_TOOLS, type Config, type LoadedConfig } from '../config.ts'
import type { RoleRoute } from '../engine/types.ts'
import type { MemoryStore } from '../memory/store.ts'
import { PiRoleRuntime, type ResolvedModel, type RoleEvent, type ThinkingLevel } from './role-runtime.ts'
import { decideIsolation, type IsolationDecision } from './sandbox.ts'
import { projectPaths, StoreRegistry, type ProjectPaths } from './stores.ts'
import { UsageMeter } from './usage.ts'

/** The session's model state at one moment: the current model and the registry that resolves routes. */
export interface ModelSnapshot {
  model: ExtensionContext['model']
  registry: ExtensionContext['modelRegistry']
}

export function snapshotModels(ctx: ExtensionContext): ModelSnapshot {
  return { model: ctx.model, registry: ctx.modelRegistry }
}

/** A live interactive Verifier context: one per session, persisting across the revisions of one task. */
export interface LiveVerifier {
  runtime: PiRoleRuntime
  conversation: import('../engine/types.ts').RoleConversation
}

/**
 * Per-project host state: configuration, paths, the memory store, the
 * Verifier isolation decision, live interactive Verifiers, and the running
 * exploration lineage. A new session in another directory gets a new host.
 */
export class Host {
  readonly paths: ProjectPaths
  readonly stores: StoreRegistry
  readonly verifiers = new Map<string, LiveVerifier>()
  /** The exploration lineage running in this process, if any (one at a time per project). */
  exploration: { lineage: string, controller: AbortController, started: number, phase: string, last?: string, done?: Promise<unknown> } | undefined
  #store: Promise<MemoryStore> | undefined
  #isolation: Promise<IsolationDecision> | undefined
  #modelRuntime: Promise<ModelRuntime> | undefined

  constructor(
    readonly loaded: LoadedConfig,
    readonly agentDir: string,
    cwd: string,
  ) {
    this.paths = projectPaths(loaded.config, agentDir, cwd)
    this.stores = new StoreRegistry(loaded.config)
  }

  get config(): Config {
    return this.loaded.config
  }

  store(): Promise<MemoryStore> {
    this.#store ??= this.stores.open(this.paths.memory)
    this.#store.catch(() => {
      this.#store = undefined
    })
    return this.#store
  }

  isolation(): Promise<IsolationDecision> {
    this.#isolation ??= decideIsolation(this.config.verifier.isolation)
    this.#isolation.catch(() => {
      this.#isolation = undefined
    })
    return this.#isolation
  }

  /** Cached inventory for synchronous prompt assembly. */
  inventory(): Array<{ path: string, bytes: number }> | undefined {
    return this.stores.inventory(this.paths.memory)
  }

  async refreshInventory(): Promise<void> {
    await this.stores.refresh(await this.store())
  }

  /**
   * Paths no role may see, except its own tree and scratch: the whole pi agent
   * directory (sessions, credentials, settings, every project's pi-rsi state),
   * this project's pi-rsi state and memory wherever they are configured, the
   * session directory, and any configured extras.
   */
  hiddenPaths(ctx: ExtensionContext): string[] {
    const sessionDir = ctx.sessionManager.getSessionDir?.()
    return [...new Set([
      this.agentDir,
      this.paths.state,
      this.paths.memory,
      ...(sessionDir ? [sessionDir] : []),
      ...this.config.verifier.hiddenPaths,
    ])]
  }

  /** Harness-owned paths inside the project, left out of change capture and checkpoints. */
  harnessExcludes(): string[] {
    const out: string[] = []
    for (const path of [this.paths.state, this.paths.memory]) {
      const rel = relative(this.paths.project, path)
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) out.push(rel.split('\\').join('/'))
    }
    return out
  }

  verifierTools(): string[] {
    return [...new Set(this.config.verifier.tools.filter(tool => !VERIFIER_DENIED_TOOLS.has(tool)))]
  }

  /**
   * The model runtime role sessions share with the main session: the same
   * providers (including extension-registered ones), credentials, and
   * runtime API keys. Falls back to a runtime over the agent directory's
   * auth.json and models.json.
   */
  modelRuntime(ctx: ExtensionContext): Promise<ModelRuntime> {
    const inner = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime
    if (inner instanceof ModelRuntime) return Promise.resolve(inner)
    if (inner && typeof (inner as ModelRuntime).streamSimple === 'function' && typeof (inner as ModelRuntime).getModel === 'function') {
      return Promise.resolve(inner as ModelRuntime)
    }
    this.#modelRuntime ??= ModelRuntime.create({ authPath: join(this.agentDir, 'auth.json'), modelsPath: join(this.agentDir, 'models.json') })
    return this.#modelRuntime
  }

  /**
   * The model and thinking level a role route uses; empty route fields inherit
   * the session's. Works from a snapshot of the session's model state, so a
   * long-running lineage never touches a context that went stale.
   */
  resolveModel(models: ModelSnapshot, thinking: ThinkingLevel, route: RoleRoute): ResolvedModel {
    const conf = this.config.roles[route]
    let model = models.model
    if (conf.provider || conf.model) {
      const provider = conf.provider || models.model?.provider
      const id = conf.model || (conf.provider && conf.provider !== models.model?.provider ? undefined : models.model?.id)
      if (!provider || !id) throw new Error(`roles.${route} needs both a provider and a model id`)
      model = models.registry.find(provider, id)
      if (!model) throw new Error(`roles.${route}: model ${provider}/${id} is not known to pi (see /model)`)
    }
    if (!model) throw new Error('no model is selected; choose one with /model before using pi-rsi')
    if (!models.registry.hasConfiguredAuth(model)) throw new Error(`no credentials are configured for ${model.provider} (role route ${route})`)
    return { model, thinkingLevel: conf.thinking ?? thinking }
  }

  /** Whether the escalation route equals the Verifier's while the Actor's differs (the cross-model swap is meaningful). */
  crossModel(models: ModelSnapshot, thinking: ThinkingLevel): boolean {
    try {
      const actor = this.resolveModel(models, thinking, 'actor').model
      const escalation = this.resolveModel(models, thinking, 'escalation').model
      const verifier = this.resolveModel(models, thinking, 'verifier').model
      return `${escalation.provider}/${escalation.id}` === `${verifier.provider}/${verifier.id}` && `${actor.provider}/${actor.id}` !== `${verifier.provider}/${verifier.id}`
    } catch {
      return false
    }
  }

  async roleRuntime(ctx: ExtensionContext, options: {
    thinking: ThinkingLevel
    settings: Record<string, unknown>
    usage: UsageMeter
    sessionDir?: string
    observe?: (event: RoleEvent) => void
  }): Promise<PiRoleRuntime> {
    const [store, isolation, modelRuntime] = await Promise.all([this.store(), this.isolation(), this.modelRuntime(ctx)])
    const models = snapshotModels(ctx)
    return new PiRoleRuntime({
      agentDir: this.agentDir,
      modelRuntime,
      resolveModel: route => this.resolveModel(models, options.thinking, route),
      store,
      verifierTools: this.verifierTools(),
      isolation,
      hidden: this.hiddenPaths(ctx),
      scratchRoot: this.paths.scratch,
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      settings: options.settings,
      usage: options.usage,
      ...(options.observe ? { observe: options.observe } : {}),
    })
  }

  async closeVerifier(sessionId: string): Promise<void> {
    const live = this.verifiers.get(sessionId)
    if (!live) return
    this.verifiers.delete(sessionId)
    await live.conversation.close().catch(() => undefined)
    await live.runtime.closeAll()
  }

  /** Aborts a running lineage and waits (bounded) for it to record its end, then closes live Verifiers. */
  async dispose(waitMs = 10_000): Promise<void> {
    const running = this.exploration
    running?.controller.abort()
    if (running?.done) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([running.done.catch(() => undefined), new Promise(done => { timer = setTimeout(done, waitMs) })])
      clearTimeout(timer)
    }
    await Promise.allSettled([...this.verifiers.keys()].map(id => this.closeVerifier(id)))
  }
}

/** Settings role sessions inherit from the main session, without what must stay per-session. */
export function roleSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['shellPath', 'shellCommandPrefix', 'retry', 'compaction', 'httpIdleTimeoutMs', 'httpProxy', 'thinkingBudgets', 'transport']) {
    if (settings[key] !== undefined) out[key] = structuredClone(settings[key])
  }
  // Idle cache warming would bill role contexts while they wait for the harness.
  out.cacheWarming = settings.cacheWarming === 'off' ? 'off' : 'streaming'
  return out
}
