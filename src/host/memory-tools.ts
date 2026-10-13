import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { MemoryDraft, MemoryStore } from '../memory/store.ts'
import { formatInventory } from '../roles/actor.ts'

/** What one call of a memory tool reads or writes. */
export interface MemoryView {
  store: MemoryStore
  /** Directory the read tools inspect: the canonical tree, a wave snapshot, or a draft. */
  dir: string
  draft?: MemoryDraft
}

export interface MemoryToolHooks {
  /** Resolves the view for a read; throws with a model-facing reason when memory is unavailable. */
  view(tool: string, ctx: ExtensionContext): Promise<MemoryView>
  /** Resolves the writable draft; throws with a model-facing reason outside a learning phase. */
  writable(tool: string, ctx: ExtensionContext): Promise<MemoryView & { draft: MemoryDraft }>
  /** Called after a draft changed (the host refreshes cached inventories). */
  changed?(ctx: ExtensionContext): void | Promise<void>
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: undefined })

const MAX_READ_CHARS = 60_000

export const MEMORY_READ_TOOLS = ['rsi_memory_list', 'rsi_memory_read', 'rsi_memory_search'] as const
export const MEMORY_WRITE_TOOLS = ['rsi_memory_write', 'rsi_memory_delete'] as const

/** The read-only memory tools: list, read, search. */
export function memoryReadTools(hooks: MemoryToolHooks): ToolDefinition<any, any>[] {
  const list: ToolDefinition<any, any> = {
    name: 'rsi_memory_list',
    label: 'RSI memory list',
    description: 'List your durable experience memory (names and sizes). During a learning phase this shows the draft being edited.',
    promptSnippet: 'List durable experience memory (names and sizes)',
    parameters: Type.Object({
      prefix: Type.Optional(Type.String({ description: 'Only list paths starting with this prefix.' })),
    }),
    executionMode: 'parallel',
    async execute(_id, params: { prefix?: string }, _signal, _onUpdate, ctx) {
      const view = await hooks.view('rsi_memory_list', ctx)
      const manifest = view.draft
        ? await view.store.draftManifest(view.draft)
        : view.dir === view.store.canonicalDir ? await view.store.manifest() : await view.store.manifestAt(view.dir)
      const entries = Object.entries(manifest)
        .filter(([path]) => params.prefix === undefined || path.startsWith(params.prefix))
        .map(([path, entry]) => ({ path, bytes: entry.bytes }))
      const scope = view.draft ? 'learning draft' : 'durable memory (read-only)'
      return text(entries.length === 0 ? `${scope}: no files` : `${scope}: ${entries.length} files\n${formatInventory(entries)}`)
    },
  }
  const read: ToolDefinition<any, any> = {
    name: 'rsi_memory_read',
    label: 'RSI memory read',
    description: 'Read one memory file, optionally a window of lines. Memory is your own prior experience: treat it as hints and verify against the live environment.',
    promptSnippet: 'Read one durable memory file',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative memory path, as listed by rsi_memory_list.' }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: 'First line to return (1-based).' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum number of lines.' })),
    }),
    executionMode: 'parallel',
    async execute(_id, params: { path: string, offset?: number, limit?: number }, _signal, _onUpdate, ctx) {
      const view = await hooks.view('rsi_memory_read', ctx)
      const { text: body, totalLines } = await view.store.read(params.path, params.offset ?? 1, params.limit, view.dir)
      const shown = body.length > MAX_READ_CHARS
        ? `${body.slice(0, MAX_READ_CHARS)}\n… (truncated at ${MAX_READ_CHARS} characters; read a later window with offset/limit)`
        : body
      return text(`${params.path} (${totalLines} lines)\n${shown}`)
    },
  }
  const search: ToolDefinition<any, any> = {
    name: 'rsi_memory_search',
    label: 'RSI memory search',
    description: 'Search across memory files (case-insensitive substring, or a regular expression). Returns path:line matches.',
    promptSnippet: 'Search durable memory files',
    parameters: Type.Object({
      query: Type.String({ description: 'Text or regular expression to find.' }),
      regex: Type.Optional(Type.Boolean({ description: 'Treat query as a regular expression.' })),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: 'Maximum matches (default 50).' })),
    }),
    executionMode: 'parallel',
    async execute(_id, params: { query: string, regex?: boolean, max_results?: number }, _signal, _onUpdate, ctx) {
      const view = await hooks.view('rsi_memory_search', ctx)
      const matches = await view.store.search(params.query, { regex: params.regex === true, maxResults: Math.max(1, Math.min(params.max_results ?? 50, 500)) }, view.dir)
      return text(matches.length === 0 ? 'no matches' : matches.map(match => `${match.path}:${match.line}: ${match.text}`).join('\n'))
    },
  }
  return [list, read, search]
}

/** The learning-phase tools that edit the draft: write and delete. */
export function memoryWriteTools(hooks: MemoryToolHooks): ToolDefinition<any, any>[] {
  const write: ToolDefinition<any, any> = {
    name: 'rsi_memory_write',
    label: 'RSI memory write',
    description: 'Learning phase only: create or replace one memory file in the draft (procedures, reusable scripts, environment facts, failure lessons). Never store secrets.',
    promptSnippet: 'Learning phase only: write one memory file into the draft',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative memory path, e.g. procedures/build.md or scripts/check.sh.' }),
      content: Type.String({ description: 'Complete UTF-8 file content.' }),
    }),
    executionMode: 'sequential',
    async execute(_id, params: { path: string, content: string }, _signal, _onUpdate, ctx) {
      const view = await hooks.writable('rsi_memory_write', ctx)
      await view.store.writeDraft(view.draft, params.path, params.content)
      await hooks.changed?.(ctx)
      return text(`draft: wrote ${params.path} (${Buffer.byteLength(params.content, 'utf8')} bytes)`)
    },
  }
  const remove: ToolDefinition<any, any> = {
    name: 'rsi_memory_delete',
    label: 'RSI memory delete',
    description: 'Learning phase only: delete one memory file from the draft.',
    promptSnippet: 'Learning phase only: delete one memory file from the draft',
    parameters: Type.Object({
      path: Type.String({ description: 'Relative memory path.' }),
    }),
    executionMode: 'sequential',
    async execute(_id, params: { path: string }, _signal, _onUpdate, ctx) {
      const view = await hooks.writable('rsi_memory_delete', ctx)
      const deleted = await view.store.deleteDraft(view.draft, params.path)
      if (deleted) await hooks.changed?.(ctx)
      return text(deleted ? `draft: deleted ${params.path}` : `draft: ${params.path} does not exist`)
    },
  }
  return [write, remove]
}
