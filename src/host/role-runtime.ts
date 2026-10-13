import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ModelRuntime,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { InfraError, type OpenRoleOptions, type RoleConversation, type RoleKind, type RoleReply, type RoleRoute, type RoleRuntime } from '../engine/types.ts'
import type { MemoryStore } from '../memory/store.ts'
import { memoryRevisit, truncatedContinuation } from '../roles/actor.ts'
import { memoryReadTools, memoryWriteTools, type MemoryToolHooks } from './memory-tools.ts'
import { guardedFileTools } from './guarded-tools.ts'
import { privatePathGuard, sandboxCommand, type IsolationDecision } from './sandbox.ts'
import { UsageMeter } from './usage.ts'

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ResolvedModel {
  model: Model<any>
  thinkingLevel: ThinkingLevel
}

export interface RoleEvent {
  type: 'open' | 'tool' | 'reply' | 'close' | 'compaction' | 'error'
  role: RoleKind
  label: string
  detail?: string
}

export interface PiRoleRuntimeOptions {
  agentDir: string
  modelRuntime: ModelRuntime
  /** Model and thinking level of a route; throws when the route cannot be served. */
  resolveModel(route: RoleRoute): ResolvedModel
  store: MemoryStore
  /** Tools a Verifier context receives (already stripped of write/edit). */
  verifierTools: readonly string[]
  isolation: IsolationDecision
  /** Absolute harness-private paths hidden from every role context. */
  hidden: readonly string[]
  /** Parent directory of per-role scratch directories. */
  scratchRoot: string
  /** Persist role transcripts as pi sessions here; in memory when undefined. */
  sessionDir?: string
  /** Settings every role session starts from (pi's effective settings, minus what roles must not inherit). */
  settings?: Record<string, unknown>
  usage: UsageMeter
  observe?: (event: RoleEvent) => void
}

const CODING_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
/** Built-in file tools that role sessions get in guarded form. */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'find'])
/** Bound on output-limit continuations inside one segment; each is a fresh model step, not a handoff. */
const MAX_TRUNCATION_CONTINUATIONS = 4

function lastAssistant(session: AgentSession): AssistantMessage | undefined {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index] as { role?: string }
    if (message.role === 'assistant') return message as AssistantMessage
  }
  return undefined
}

function textOf(message: AssistantMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n').trim()
}

/**
 * RSIAgent's role contexts on pi: every Actor, Verifier, and Curriculum is an
 * in-process pi session with a fresh conversation, its own system prompt,
 * tool allow-list, working directory, and model route. No extension, skill,
 * prompt template, or context file loads into it, so a role hears only the
 * harness. `send()` is one pi run; the run's final assistant reply is the
 * role's handoff, and the next `send()` continues the same conversation.
 */
export class PiRoleRuntime implements RoleRuntime {
  readonly #open = new Set<PiRoleConversation>()

  constructor(readonly options: PiRoleRuntimeOptions) {}

  async open(options: OpenRoleOptions): Promise<RoleConversation> {
    const conversation = new PiRoleConversation(this.options, options, () => this.#open.delete(conversation))
    this.#open.add(conversation)
    try {
      await conversation.start()
    } catch (error) {
      await conversation.close()
      if (error instanceof InfraError) throw error
      throw new InfraError(`${options.label}: the role context could not start (${error instanceof Error ? error.message : String(error)})`)
    }
    return conversation
  }

  /** Routes later usage and progress of this runtime's contexts to another call (a persisting Verifier). */
  rebind(usage: UsageMeter, observe?: (event: RoleEvent) => void): void {
    this.options.usage = usage
    this.options.observe = observe
  }

  /** Closes every role context still open (cancellation, shutdown). */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#open].map(conversation => conversation.close()))
  }
}

class PiRoleConversation implements RoleConversation {
  #session: AgentSession | undefined
  #scratch: string | undefined
  #closed = false
  #compacted = false
  #first: string | undefined

  constructor(
    readonly runtime: PiRoleRuntimeOptions,
    readonly role: OpenRoleOptions,
    readonly onClose: () => void,
  ) {}

  #observe(type: RoleEvent['type'], detail?: string): void {
    this.runtime.observe?.({ type, role: this.role.role, label: this.role.label, ...(detail === undefined ? {} : { detail }) })
  }

  #tools(): string[] {
    const { role, memory } = this.role
    const memoryTools = memory.access === 'none' ? [] : ['rsi_memory_list', 'rsi_memory_read', 'rsi_memory_search']
    switch (role) {
      case 'actor':
        return [...CODING_TOOLS, ...memoryTools, 'rsi_memory_write', 'rsi_memory_delete']
      case 'curriculum':
        return [...CODING_TOOLS, ...memoryTools, 'rsi_notes']
      case 'verifier':
        return [...this.runtime.verifierTools]
      default: {
        const unreachable: never = role
        throw new Error(`unknown role ${String(unreachable)}`)
      }
    }
  }

  #memoryHooks(store: MemoryStore): MemoryToolHooks {
    const binding = this.role.memory
    return {
      view: async tool => {
        if (binding.access === 'none') throw new Error(`${tool}: memory is not available in the ${this.role.role} context`)
        const dir = binding.readDir ?? store.canonicalDir
        return binding.access === 'draft' && binding.draft ? { store, dir, draft: binding.draft } : { store, dir }
      },
      writable: async tool => {
        if (binding.access !== 'draft' || !binding.draft) {
          throw new Error(`${tool}: durable memory is read-only while you work. It changes only in the learning phase the harness opens after the verdict.`)
        }
        return { store, dir: binding.draft.dir, draft: binding.draft }
      },
    }
  }

  #extension(): (pi: ExtensionAPI) => void {
    const { role, cwd, notesFile, visible } = this.role
    const runtime = this.runtime
    const scratch = this.#scratch!
    return pi => {
      const hooks = this.#memoryHooks(runtime.store)
      if (this.role.memory.access !== 'none') for (const tool of memoryReadTools(hooks)) pi.registerTool(tool)
      if (role === 'actor') for (const tool of memoryWriteTools(hooks)) pi.registerTool(tool)
      if (role === 'curriculum' && notesFile) pi.registerTool(notesTool(notesFile))

      const verifier = role === 'verifier'
      // Every role is kept out of the harness's private state (the pi agent directory, pi-rsi state, sessions),
      // except its own tree and scratch: a lineage role's own episode or authoring tree, the interactive
      // Verifier's project. Sibling projects and other lineages live inside the hidden state root.
      const own = visible?.own ?? cwd
      const guard = privatePathGuard(runtime.hidden, [own, scratch])
      const fileTools = this.#tools().filter(name => FILE_TOOLS.has(name))
      for (const tool of guardedFileTools(cwd, guard, fileTools)) pi.registerTool(tool)
      const bwrap = runtime.isolation.mode === 'sandbox' ? runtime.isolation.bwrap : undefined
      const settings = runtime.settings ?? {}
      const bash = createBashToolDefinition(cwd, {
        ...(typeof settings.shellPath === 'string' ? { shellPath: settings.shellPath } : {}),
        ...(typeof settings.shellCommandPrefix === 'string' ? { commandPrefix: settings.shellCommandPrefix } : {}),
        spawnHook: ({ command, cwd: commandCwd, env }) => {
          const scratchEnv = { ...env, RSI_SCRATCH: scratch, TMPDIR: scratch }
          if (!bwrap) return { command, cwd: commandCwd, env: scratchEnv }
          const spec = { cwd: commandCwd, own, scratch, hidden: runtime.hidden, mode: verifier ? 'readonly' as const : 'visibility' as const }
          return { command: sandboxCommand(bwrap, spec, command), cwd: commandCwd, env: scratchEnv }
        },
      })
      pi.registerTool(bash as ToolDefinition<any, any>)
      // Unconfined shells get a tripwire only: refuse commands that name a hidden path.
      if (!bwrap) {
        pi.on('tool_call', async event => {
          const command = (event.input as Record<string, unknown>).command
          if (event.toolName !== 'bash' || typeof command !== 'string') return undefined
          const reason = guard.checkCommand(command)
          return reason ? { block: true, reason } : undefined
        })
      }
    }
  }

  async start(): Promise<void> {
    const { role, cwd, label, system } = this.role
    const { model, thinkingLevel } = this.runtime.resolveModel(this.role.route ?? role)
    await mkdir(this.runtime.scratchRoot, { recursive: true })
    this.#scratch = await mkdtemp(join(this.runtime.scratchRoot, `${role}-`))
    const settingsManager = SettingsManager.inMemory(this.runtime.settings ?? {})
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.runtime.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: system,
      // Nothing a project (or a role) can write may reach a role's prompt: no SYSTEM.md, APPEND_SYSTEM.md, or AGENTS files.
      systemPromptOverride: () => system,
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [this.#extension()],
    })
    await resourceLoader.reload()
    let sessionManager: SessionManager
    if (this.runtime.sessionDir) {
      await mkdir(this.runtime.sessionDir, { recursive: true })
      sessionManager = SessionManager.create(cwd, this.runtime.sessionDir)
    } else {
      sessionManager = SessionManager.inMemory(cwd)
    }
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir: this.runtime.agentDir,
      modelRuntime: this.runtime.modelRuntime,
      model,
      thinkingLevel,
      resourceLoader,
      tools: this.#tools(),
      sessionManager,
      settingsManager,
    })
    if (extensionsResult.errors.length > 0) {
      session.dispose()
      throw new InfraError(`${label}: role tools failed to load (${extensionsResult.errors.map(error => error.error).join('; ')})`)
    }
    session.setSessionName(`pi-rsi ${label}`)
    this.#session = session
    this.#observe('open', `${model.provider}/${model.id}`)
  }

  async send(message: string, signal?: AbortSignal): Promise<RoleReply> {
    const session = this.#session
    if (this.#closed || !session) throw new InfraError(`${this.role.label}: the role context is closed`)
    signal?.throwIfAborted()
    let actions = 0
    const unsubscribe = session.subscribe(event => {
      switch (event.type) {
        case 'tool_execution_end':
          actions++
          this.#observe('tool', event.toolName)
          break
        case 'message_end':
          if ((event.message as { role?: string }).role === 'assistant') this.runtime.usage.add((event.message as AssistantMessage).usage)
          break
        case 'compaction_end':
          if (event.result && !event.aborted) {
            this.runtime.usage.add(event.result.usage)
            this.#compacted = true
            this.#observe('compaction', event.reason)
          }
          break
        case 'entry_appended':
          // Cache-warm refreshes and other billed side requests are recorded as usage entries.
          if (event.entry.type === 'usage') this.runtime.usage.add((event.entry as { usage?: import('@earendil-works/pi-ai').Usage }).usage)
          break
        default:
          break
      }
    })
    const abort = () => void session.abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      let text = this.#prepare(message)
      for (let round = 0; ; round++) {
        try {
          await session.prompt(text)
        } catch (error) {
          signal?.throwIfAborted()
          throw new InfraError(`${this.role.label}: the role run failed (${error instanceof Error ? error.message : String(error)})`)
        }
        signal?.throwIfAborted()
        const last = lastAssistant(session)
        if (!last) return { text: '', actions }
        if (last.stopReason === 'length' && round < MAX_TRUNCATION_CONTINUATIONS) {
          text = truncatedContinuation()
          continue
        }
        if (last.stopReason === 'error' || last.stopReason === 'aborted') {
          // pi already retried transient provider failures; what remains is infrastructure, with its reason.
          const reason = last.errorMessage ?? `the model run ended with stop reason ${last.stopReason}`
          this.#observe('error', reason)
          throw new InfraError(`${this.role.label}: model request failed (${reason})`)
        }
        const reply = textOf(last)
        this.#observe('reply', reply.split('\n').find(line => line.trim() !== '')?.slice(0, 120) ?? '')
        return { text: reply, actions }
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      unsubscribe()
    }
  }

  /**
   * After a compaction the opening brief survives only as a summary; RSIAgent
   * pins the verbatim task and re-offers memory retrieval (`_memory_revisit`,
   * event `fold`). The first message is the role's opening brief.
   */
  #prepare(message: string): string {
    // A persisting Verifier gets a complete charter per inspection: the latest one is its brief.
    const charter = this.role.role === 'verifier' && message.startsWith('VERIFIER AGENT — CANDIDATE VERIFICATION.')
    if (this.#first === undefined || charter) {
      this.#first = message
      this.#compacted = false
      return message
    }
    if (!this.#compacted) return message
    this.#compacted = false
    const revisit = this.role.memory.access === 'none' ? '' : `\n\n${memoryRevisit('fold')}`
    return `CONTEXT NOTE: earlier conversation in this context was compacted into a summary. Your opening brief,
verbatim and unchanged (it remains authoritative):
---
${this.#first.trim()}
---${revisit}

${message}`
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      const session = this.#session
      this.#session = undefined
      if (session) {
        if (!session.isIdle) await session.abort().catch(() => undefined)
        session.dispose()
      }
    } finally {
      if (this.#scratch) await rm(this.#scratch, { recursive: true, force: true }).catch(() => undefined)
      this.onClose()
      this.#observe('close')
    }
  }
}

/** The Curriculum's private search notes (RSIAgent `curriculum_notes.md`). */
function notesTool(notesFile: string): ToolDefinition<any, any> {
  return {
    name: 'rsi_notes',
    label: 'RSI curriculum notes',
    description: 'Replace your private search notes (a recovery copy of your search state across turns). They are never shown to the Actor or Verifier.',
    parameters: Type.Object({
      content: Type.String({ description: 'The complete new notes.' }),
    }),
    executionMode: 'sequential',
    async execute(_id, params: { content: string }) {
      await writeFile(notesFile, params.content, 'utf8')
      return { content: [{ type: 'text' as const, text: `notes saved (${Buffer.byteLength(params.content, 'utf8')} bytes)` }], details: undefined }
    },
  }
}
