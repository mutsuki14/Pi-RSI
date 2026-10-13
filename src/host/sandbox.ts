import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Verifier isolation on pi (RSIAgent `effect_isolated` vs `rollback_mirror`):
 *
 * - `sandbox`: every Verifier shell command runs under bubblewrap with the
 *   whole filesystem mounted read-only, Actor-private paths masked, and a
 *   private scratch directory as the only writable mount (at `/tmp`). The
 *   candidate is also checkpointed and restored, as a second line of defence.
 * - `rollback`: commands run unconfined; the harness checkpoints the
 *   candidate and restores it afterwards. File tools still refuse private
 *   paths, and the shell refuses commands that name them, but a determined
 *   command can reach them: prefer `sandbox` where bubblewrap exists.
 */
export type IsolationMode = 'sandbox' | 'rollback'

export interface IsolationDecision {
  mode: IsolationMode
  /** Why this mode was chosen, for `/rsi`. */
  reason: string
  /** bubblewrap executable, in `sandbox` mode. */
  bwrap?: string
}

function run(file: string, args: string[], timeoutMs = 15_000): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return new Promise(done => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
      done({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

let cached: Promise<IsolationDecision> | undefined

/**
 * Chooses the Verifier isolation. `sandbox` is chosen (or, when requested
 * explicitly, accepted) only after a preflight shows bubblewrap really makes
 * the filesystem read-only while the scratch stays writable.
 */
export async function decideIsolation(requested: 'auto' | 'sandbox' | 'rollback'): Promise<IsolationDecision> {
  if (requested === 'rollback') return { mode: 'rollback', reason: 'configured: verifier.isolation = rollback' }
  cached ??= preflight()
  const probe = await cached
  if (probe.mode === 'sandbox') return probe
  if (requested === 'sandbox') throw new Error(`verifier.isolation is "sandbox" but the bubblewrap preflight failed: ${probe.reason}`)
  return probe
}

/** For tests: forget the cached preflight. */
export function resetIsolationCache(): void {
  cached = undefined
}

async function preflight(): Promise<IsolationDecision> {
  if (process.platform !== 'linux') return { mode: 'rollback', reason: `bubblewrap sandboxing is Linux-only (platform ${process.platform})` }
  const which = await run('sh', ['-c', 'command -v bwrap'])
  const bwrap = which.stdout.trim()
  if (which.code !== 0 || bwrap === '') return { mode: 'rollback', reason: 'bubblewrap (bwrap) is not installed' }
  const outside = await mkdtemp(join(tmpdir(), 'pi-rsi-preflight-'))
  const scratch = await mkdtemp(join(tmpdir(), 'pi-rsi-preflight-scratch-'))
  try {
    const target = join(outside, 'probe')
    const script = `if touch '${target}' 2>/dev/null; then echo WRITABLE; exit 3; fi; touch "$RSI_SCRATCH/ok" && echo READY`
    const result = await run(bwrap, [...sandboxArgs({ cwd: outside, own: outside, scratch, hidden: [] }), 'sh', '-c', script])
    const leaked = await stat(target).then(() => true, () => false)
    const scratchWritable = await stat(join(scratch, 'ok')).then(() => true, () => false)
    if (result.code === 0 && result.stdout.includes('READY') && !leaked && scratchWritable) {
      return { mode: 'sandbox', reason: `bubblewrap preflight passed (${bwrap})`, bwrap }
    }
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).split('\n')[0]
    return { mode: 'rollback', reason: `bubblewrap preflight failed: ${detail}` }
  } finally {
    await rm(outside, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  }
}

export interface SandboxSpec {
  cwd: string
  /** Writable private scratch, named by $RSI_SCRATCH and $TMPDIR. */
  scratch: string
  /** Absolute paths masked inside the sandbox (directories become empty, files read as empty). */
  hidden: readonly string[]
  /** The role's own tree: visible (and, in `visibility` mode, writable) even inside a hidden path. */
  own: string
  /**
   * `readonly` (Verifier, probes): the whole filesystem is read-only except the
   * scratch, in a separate process namespace, without host IPC.
   * `visibility` (lineage Actor and Curriculum): writes go through as usual,
   * but hidden paths are masked.
   */
  mode?: 'readonly' | 'visibility'
}

/** Host daemons a read-only Verifier could otherwise ask to write for it. */
const IPC_SOCKETS = ['/run/docker.sock', '/var/run/docker.sock', '/run/containerd', '/run/dbus', '/run/user', '/run/podman']
const IPC_ENV = ['DBUS_SESSION_BUS_ADDRESS', 'DOCKER_HOST', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'XDG_RUNTIME_DIR', 'CONTAINER_HOST']

function mask(args: string[], path: string): void {
  let info
  try {
    // Masks apply to the physical path: bubblewrap refuses to mount over a symlink.
    info = lstatSync(path)
  } catch {
    return
  }
  if (info.isDirectory()) args.push('--tmpfs', path)
  else if (info.isFile() || info.isSocket()) args.push('--ro-bind', '/dev/null', path)
}

/** bubblewrap arguments up to (not including) the command. */
export function sandboxArgs(spec: SandboxSpec): string[] {
  const readonly = (spec.mode ?? 'readonly') === 'readonly'
  const cwd = physical(spec.cwd)
  const own = physical(spec.own)
  const scratch = physical(spec.scratch)
  // No capabilities, even when pi runs as root: masks and read-only mounts cannot be undone from inside.
  const args = [readonly ? '--ro-bind' : '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--cap-drop', 'ALL']
  // The Verifier gets its own process namespace; Actors keep background processes across commands.
  if (readonly) args.push('--unshare-pid', '--die-with-parent')
  args.push('--new-session')
  // A fresh /tmp per command for the Verifier, unless its own tree lives there (it must stay visible).
  if (readonly && !isWithin(own, physical('/tmp')) && !isWithin(cwd, physical('/tmp'))) args.push('--tmpfs', '/tmp')
  if (readonly) {
    for (const socket of IPC_SOCKETS) mask(args, socket)
    for (const name of IPC_ENV) args.push('--unsetenv', name)
  }
  for (const path of new Set(spec.hidden.map(physical))) mask(args, path)
  // Re-expose what the role must reach: its own tree and its scratch (bind sources resolve outside the masks).
  args.push(readonly ? '--ro-bind' : '--bind', own, own)
  if (!isWithin(cwd, own)) args.push(readonly ? '--ro-bind' : '--bind', cwd, cwd)
  args.push('--bind', scratch, scratch, '--setenv', 'RSI_SCRATCH', scratch, '--setenv', 'TMPDIR', scratch, '--chdir', spec.cwd)
  return args
}

/** POSIX single-quote escaping. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The command string pi's bash tool should run instead of `command`. */
export function sandboxCommand(bwrap: string, spec: SandboxSpec, command: string): string {
  return `exec ${[bwrap, ...sandboxArgs(spec), 'bash', '-c', command].map(shellQuote).join(' ')}`
}

/** Whether `path` is `root` or lies inside it (purely lexical; callers resolve first). */
export function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Resolves symlinks as far as the path exists, like the filesystem would. */
export function physical(path: string): string {
  let current = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return rest.length === 0 ? real : join(real, ...rest.reverse())
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) return resolve(path)
      rest.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      current = parent
    }
  }
}

export interface PathGuard {
  /** A reason to refuse access to an absolute path, or undefined to allow. `recursive` also refuses ancestors of hidden paths. */
  check(absolutePath: string, recursive: boolean): string | undefined
  /** A reason to refuse a shell command that names a hidden path (a tripwire, not a boundary). */
  checkCommand(command: string): string | undefined
}

/**
 * What a role may not see: everything inside a hidden root, except its own
 * tree and its scratch. Paths are resolved physically, as the filesystem
 * would, so a symlink into a hidden root is refused too.
 */
export function privatePathGuard(hidden: readonly string[], allowed: readonly string[]): PathGuard {
  const roots = [...new Set(hidden.flatMap(path => [resolve(path), physical(path)]))]
  const open = [...new Set(allowed.flatMap(path => [resolve(path), physical(path)]))]
  return {
    check(absolutePath, recursive) {
      const target = physical(absolutePath)
      if (open.some(root => isWithin(target, root))) return undefined
      for (const root of roots) {
        if (isWithin(target, root)) return `${absolutePath} is hidden from this role`
        if (recursive && isWithin(root, target)) return `searching ${absolutePath} would traverse paths hidden from this role; search inside your own tree instead`
      }
      return undefined
    },
    checkCommand(command) {
      let rest = command
      for (const root of open) rest = rest.split(root).join('')
      for (const root of roots) if (rest.includes(root)) return 'the command names a path hidden from this role'
      return undefined
    },
  }
}
