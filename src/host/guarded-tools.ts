import { constants, existsSync, readdirSync, statSync } from 'node:fs'
import { access, glob, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { PathGuard } from './sandbox.ts'

/**
 * pi's built-in file tools with their filesystem operations routed through a
 * path guard. The operations receive the absolute path each tool actually
 * touches, after pi's own resolution (`@` prefixes, `~`, unicode spaces,
 * macOS name variants), so the guard sees exactly what the tool would open.
 */
export function guardedFileTools(cwd: string, guard: PathGuard, names: readonly string[]): ToolDefinition<any, any>[] {
  const allow = (path: string, recursive = false) => {
    const reason = guard.check(path, recursive)
    if (reason) throw new Error(reason)
  }
  const visibleEntries = (dir: string) => readdirSync(dir).filter(name => guard.check(join(dir, name), false) === undefined)
  const tools: ToolDefinition<any, any>[] = []
  for (const name of new Set(names)) {
    switch (name) {
      case 'read':
        tools.push(createReadToolDefinition(cwd, {
          operations: {
            readFile: async path => {
              allow(path)
              return readFile(path)
            },
            access: async path => {
              allow(path)
              await access(path, constants.R_OK)
            },
          },
        }) as ToolDefinition<any, any>)
        break
      case 'ls':
        tools.push(createLsToolDefinition(cwd, {
          operations: {
            exists: path => guard.check(path, false) === undefined && existsSync(path),
            stat: path => {
              allow(path)
              return statSync(path)
            },
            readdir: path => {
              allow(path)
              return visibleEntries(path)
            },
          },
        }) as ToolDefinition<any, any>)
        break
      case 'grep': {
        // pi reports any failure of isDirectory as "Path not found"; keep the guard's reason for the model.
        const refused = new Map<string, string>()
        const grep = createGrepToolDefinition(cwd, {
          operations: {
            // ripgrep searches below this root: refuse roots that would traverse hidden paths.
            isDirectory: path => {
              const reason = guard.check(path, true)
              if (reason) {
                refused.set(path, reason)
                throw new Error(reason)
              }
              return statSync(path).isDirectory()
            },
            readFile: async path => {
              allow(path)
              return readFile(path, 'utf8')
            },
          },
        }) as ToolDefinition<any, any>
        tools.push({
          ...grep,
          execute: async (...args: Parameters<typeof grep.execute>) => {
            try {
              return await grep.execute(...args)
            } catch (error) {
              const path = /^Path not found: (.*)$/.exec(error instanceof Error ? error.message : '')?.[1]
              const reason = path === undefined ? undefined : refused.get(path)
              if (reason) {
                refused.delete(path!)
                throw new Error(reason)
              }
              throw error
            }
          },
        })
        break
      }
      case 'find':
        tools.push(createFindToolDefinition(cwd, {
          operations: {
            exists: path => {
              allow(path, true)
              return existsSync(path)
            },
            glob: async (pattern, root, options) => {
              // fd matches a slash-free pattern against basenames at any depth.
              const effective = pattern.includes('/') ? pattern : `**/${pattern}`
              const ignored = (path: string) => /(^|\/)(node_modules|\.git)(\/|$)/.test(path)
              const out: string[] = []
              for await (const entry of glob(effective, { cwd: root, exclude: path => ignored(typeof path === 'string' ? path : String(path)) })) {
                const full = isAbsolute(entry) ? entry : resolve(root, entry)
                if (ignored(relative(root, full)) || guard.check(full, false) !== undefined) continue
                out.push(full)
                if (out.length >= options.limit) break
              }
              return out.sort()
            },
          },
        }) as ToolDefinition<any, any>)
        break
      case 'write':
        tools.push(createWriteToolDefinition(cwd, {
          operations: {
            writeFile: async (path, content) => {
              allow(path)
              await writeFile(path, content, 'utf8')
            },
            mkdir: async dir => {
              allow(dir)
              await mkdir(dir, { recursive: true })
            },
          },
        }) as ToolDefinition<any, any>)
        break
      case 'edit':
        tools.push(createEditToolDefinition(cwd, {
          operations: {
            readFile: async path => {
              allow(path)
              return readFile(path)
            },
            writeFile: async (path, content) => {
              allow(path)
              await writeFile(path, content, 'utf8')
            },
            access: async path => {
              allow(path)
              await access(path, constants.R_OK | constants.W_OK)
            },
          },
        }) as ToolDefinition<any, any>)
        break
      default:
        break
    }
  }
  return tools
}
