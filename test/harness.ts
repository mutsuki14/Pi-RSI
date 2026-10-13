import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import piRsi from '../src/index.ts'
import { resetIsolationCache } from '../src/host/sandbox.ts'

export { fauxAssistantMessage, fauxText, fauxToolCall }

/** The text of the system prompt a faux request carries (pi sends it as a leading system message). */
export function systemOf(context: Parameters<FauxResponseFactory>[0]): string {
  const direct = (context as { systemPrompt?: unknown }).systemPrompt
  const parts: string[] = typeof direct === 'string' ? [direct] : []
  for (const message of context.messages as Array<{ role?: string, content?: unknown, sections?: unknown }>) {
    if (message.role !== 'system') continue
    if (typeof message.content === 'string') parts.push(message.content)
    if (Array.isArray(message.content)) for (const block of message.content as Array<{ text?: string }>) if (typeof block.text === 'string') parts.push(block.text)
    if (message.sections && typeof message.sections === 'object') for (const value of Object.values(message.sections as Record<string, unknown>)) if (typeof value === 'string') parts.push(value)
  }
  return parts.join('\n')
}

/** The newest user-visible text the model received (user or tool result). */
export function lastInput(context: Parameters<FauxResponseFactory>[0]): string {
  const messages = context.messages as Array<{ role?: string, content?: unknown }>
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user' && message.role !== 'toolResult') continue
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) return (message.content as Array<{ text?: string }>).map(block => block.text ?? '').join('\n')
  }
  return ''
}

export type Role = 'actor' | 'verifier' | 'curriculum' | 'main'

/** Which role a request belongs to, from its system prompt. */
export function roleOf(context: Parameters<FauxResponseFactory>[0]): Role {
  const system = systemOf(context)
  if (system.includes('You are an independent Verifier Agent')) return 'verifier'
  if (system.includes('You are the Curriculum Agent')) return 'curriculum'
  if (system.includes('You are an Actor Agent in a recursive self-improvement lineage')) return 'actor'
  return 'main'
}

export interface Harness {
  root: string
  agentDir: string
  project: string
  session: AgentSession
  faux: ReturnType<typeof fauxProvider>
  calls: Array<{ role: Role, input: string, system: string }>
  /** Scripts per role: each call takes the next step of its role's script. */
  script(role: Role, steps: Array<FauxResponseFactory | ReturnType<typeof fauxAssistantMessage>>): void
  dispose(): Promise<void>
}

export interface HarnessOptions {
  config?: Record<string, unknown>
  /** Files to create in the project before the initial commit. */
  files?: Record<string, string>
  git?: boolean
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  resetIsolationCache()
  const root = await mkdtemp(join(tmpdir(), 'pi-rsi-test-'))
  const agentDir = join(root, 'agent')
  const project = join(root, 'project')
  await mkdir(agentDir, { recursive: true })
  await mkdir(project, { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  await writeFile(join(agentDir, 'rsi.json'), JSON.stringify(options.config ?? {}), 'utf8')
  for (const [path, content] of Object.entries(options.files ?? { 'README.md': '# project\n' })) {
    await mkdir(join(project, path, '..'), { recursive: true })
    await writeFile(join(project, path), content, 'utf8')
  }
  if (options.git !== false) {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, stdio: 'ignore' })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  }

  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', contextWindow: 200_000, maxTokens: 8192 }] })
  modelRuntime.registerNativeProvider(faux.provider)
  await modelRuntime.setRuntimeApiKey('faux', 'test-key')

  const scripts = new Map<Role, Array<FauxResponseFactory | ReturnType<typeof fauxAssistantMessage>>>()
  const calls: Harness['calls'] = []
  const dispatch: FauxResponseFactory = async (context, opts, state, model) => {
    const role = roleOf(context)
    calls.push({ role, input: lastInput(context), system: systemOf(context) })
    const queue = scripts.get(role) ?? []
    const step = queue.shift()
    if (!step) throw new Error(`no scripted response left for role ${role} (input: ${lastInput(context).slice(0, 200)})`)
    return typeof step === 'function' ? step(context, opts, state, model) : step
  }
  // Every request goes through the dispatcher; refill so the provider never runs dry.
  faux.setResponses(Array.from({ length: 500 }, () => dispatch))

  const loader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [piRsi],
  })
  await loader.reload()
  const { session, extensionsResult } = await createAgentSession({
    cwd: project,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    thinkingLevel: 'off',
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(project),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  })
  if (extensionsResult.errors.length > 0) throw new Error(`extension errors: ${JSON.stringify(extensionsResult.errors)}`)
  await session.bindExtensions({})

  return {
    root,
    agentDir,
    project,
    session,
    faux,
    calls,
    script(role, steps) {
      scripts.set(role, [...(scripts.get(role) ?? []), ...steps])
    },
    async dispose() {
      session.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** A tool-calling assistant turn. */
export function call(name: string, args: Record<string, unknown> = {}) {
  return fauxAssistantMessage(fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]), { stopReason: "toolUse" })
}

/** A final text reply. */
export function say(text: string) {
  return fauxAssistantMessage(text)
}

/** Tool results of the main session, in order: [toolName, text, isError]. */
export function toolResults(session: AgentSession): Array<{ tool: string, text: string, isError: boolean, details: unknown }> {
  const out: Array<{ tool: string, text: string, isError: boolean, details: unknown }> = []
  for (const message of session.messages as Array<{ role?: string, toolName?: string, content?: Array<{ text?: string }>, isError?: boolean, details?: unknown }>) {
    if (message.role !== 'toolResult') continue
    out.push({ tool: message.toolName ?? '', text: (message.content ?? []).map(block => block.text ?? '').join('\n'), isError: message.isError === true, details: message.details })
  }
  return out
}
