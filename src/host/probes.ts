import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Lead } from '../engine/steps.ts'
import { sandboxArgs, type IsolationDecision } from './sandbox.ts'

export type ProbeClassification = 'PASS' | 'FAIL' | 'NOT_RUN'

export interface ClassifiedLead extends Lead {
  classification: ProbeClassification
}

export interface ProbeOptions {
  cwd: string
  isolation: IsolationDecision
  /** Paths masked in the sandbox. */
  hidden: readonly string[]
  /** Parent of the temporary scratch each probe gets. */
  scratchRoot: string
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Runs one Actor-proposed probe once and classifies it (RSIAgent "Harness
 * execution classification"): PASS when it exits 0 and prints a standalone
 * PASS line, FAIL when it ran and did not, NOT_RUN when it could not run.
 * Probes run read-only in the sandbox when available; otherwise the caller
 * has already checkpointed the candidate, so their effects are rolled back
 * with the inspection's.
 */
export async function runProbe(probe: string, options: ProbeOptions): Promise<ProbeClassification> {
  if (options.signal?.aborted) return 'NOT_RUN'
  const scratch = await mkdtemp(join(options.scratchRoot, 'probe-'))
  try {
    const sandboxed = options.isolation.mode === 'sandbox' && options.isolation.bwrap !== undefined
    const [file, args] = sandboxed
      ? [options.isolation.bwrap!, [...sandboxArgs({ cwd: options.cwd, scratch, hidden: options.hidden }), 'bash', '-c', probe]]
      : ['bash', ['-c', probe]]
    return await new Promise<ProbeClassification>(done => {
      let stdout = ''
      let settled = false
      const finish = (value: ProbeClassification) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        done(value)
      }
      const child = spawn(file, args, {
        cwd: options.cwd,
        env: { ...process.env, RSI_SCRATCH: scratch, TMPDIR: scratch },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      })
      const kill = () => {
        try {
          if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
      const timer = setTimeout(() => {
        kill()
        finish('NOT_RUN')
      }, options.timeoutMs)
      const onAbort = () => {
        kill()
        finish('NOT_RUN')
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout!.on('data', chunk => {
        if (stdout.length < 256 * 1024) stdout += String(chunk)
      })
      child.on('error', () => finish('NOT_RUN'))
      child.on('close', code => {
        const printedPass = stdout.split(/\r?\n/).some(line => line.trim() === 'PASS')
        finish(code === 0 && printedPass ? 'PASS' : 'FAIL')
      })
    })
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function classifyLeads(leads: readonly Lead[], options: ProbeOptions): Promise<ClassifiedLead[]> {
  const out: ClassifiedLead[] = []
  for (const lead of leads) out.push({ ...lead, classification: await runProbe(lead.probe, options) })
  return out
}
