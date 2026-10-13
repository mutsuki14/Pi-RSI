import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Config } from '../config.ts'
import { LeakageAudit } from '../memory/audit.ts'
import { MemoryStore } from '../memory/store.ts'
import { physical } from './sandbox.ts'

/**
 * Where pi-rsi keeps state for one project (the session's working directory:
 * memory follows the environment the Actor learned).
 *
 * Default layout, all outside the project so candidates, diffs, and the
 * Verifier never contain it:
 *
 *     <agentDir>/rsi/projects/<name>-<hash>/
 *       store/      durable memory (canonical tree, drafts, journal, reports, history)
 *       work/       role-visible lineage roots: practice and target projects, fixture authoring
 *       lineages/   harness-private lineage records: events, captures, snapshots, notes, role transcripts
 *       results/    sealed evaluation runs
 *       scratch/    per-Verifier scratch directories
 */
export interface ProjectPaths {
  project: string
  state: string
  memory: string
  work: string
  lineages: string
  results: string
  scratch: string
}

/** `<basename>-<sha12>` of a project directory: readable and collision-free. */
export function projectKey(projectDir: string): string {
  const key = createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 12)
  const name = basename(resolve(projectDir)).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'root'
  return `${name}-${key}`
}

function configured(value: string, projectDir: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return isAbsolute(trimmed) ? trimmed : resolve(projectDir, trimmed)
}

export function projectPaths(config: Config, agentDir: string, cwd: string): ProjectPaths {
  const project = physical(cwd)
  const state = configured(config.stateDir, project) ?? join(agentDir, 'rsi', 'projects', projectKey(project))
  return {
    project,
    state,
    memory: configured(config.memoryDir, project) ?? join(state, 'store'),
    work: join(state, 'work'),
    lineages: join(state, 'lineages'),
    results: join(state, 'results'),
    scratch: join(state, 'scratch'),
  }
}

export class StoreRegistry {
  readonly #stores = new Map<string, Promise<MemoryStore>>()
  readonly #inventories = new Map<string, Array<{ path: string, bytes: number }>>()
  readonly #audit: LeakageAudit

  constructor(readonly config: Config) {
    this.#audit = new LeakageAudit(config.audit.sealedTexts, config.audit.shingleWords)
  }

  /** Opens (once per root) and recovers the store. */
  open(root: string): Promise<MemoryStore> {
    let store = this.#stores.get(root)
    if (!store) {
      const created = new MemoryStore(root, this.config.memory, {
        keepHistory: this.config.memory.keepHistory,
        audit: this.#audit,
        frozen: this.config.mode === 'frozen',
      })
      store = created.init().then(async () => {
        await this.refresh(created)
        return created
      })
      store.catch(() => this.#stores.delete(root))
      this.#stores.set(root, store)
    }
    return store
  }

  /** Re-reads the inventory the synchronous prompt assembly serves. */
  async refresh(store: MemoryStore): Promise<void> {
    this.#inventories.set(store.root, await store.inventory())
  }

  /** Cached inventory, or `undefined` before the store was opened. */
  inventory(root: string): Array<{ path: string, bytes: number }> | undefined {
    return this.#inventories.get(root)
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

/**
 * Makes a work root inert for git: it ignores itself (so a project that
 * contains it stays clean) and is its own repository (so a role's git command
 * never discovers an enclosing repository). Host-side, no hooks run.
 */
export async function prepareWorkRoot(workRoot: string): Promise<void> {
  await mkdir(workRoot, { recursive: true })
  await writeFile(join(workRoot, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined)
  if (!(await exists(join(workRoot, '.git')))) {
    await new Promise<void>(done => {
      execFile('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', workRoot], { timeout: 15_000 }, () => done())
    })
  }
}
