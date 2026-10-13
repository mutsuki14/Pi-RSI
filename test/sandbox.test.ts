import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideIsolation, privatePathGuard, resetIsolationCache, sandboxCommand } from '../src/host/sandbox.ts'
import { call, lastInput, makeHarness, say, toolResults, type Harness } from './harness.ts'

/** Sandbox tests run only where bubblewrap really confines (installed, and user namespaces allowed). */
const hasBwrap = await (async () => {
  try {
    execFileSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' })
  } catch {
    return false
  }
  resetIsolationCache()
  const decision = await decideIsolation('auto')
  resetIsolationCache()
  return decision.mode === 'sandbox'
})()

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('private path guard', () => {
  it('refuses hidden paths, their symlinks, and recursive searches above them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-rsi-guard-'))
    try {
      const hidden = join(root, 'private')
      await mkdir(hidden)
      await writeFile(join(hidden, 'secret.md'), 'x')
      const { symlink } = await import('node:fs/promises')
      await symlink(hidden, join(root, 'alias'))
      const guard = privatePathGuard([hidden])
      expect(guard.check(join(hidden, 'secret.md'), root, false)).toContain('hidden from this role')
      expect(guard.check('alias/secret.md', root, false)).toContain('hidden from this role')
      expect(guard.check(root, root, true)).toContain('would traverse')
      expect(guard.check(root, root, false)).toBeUndefined()
      expect(guard.check(join(root, 'other'), root, true)).toBeUndefined()
      expect(guard.checkCommand(`cat ${hidden}/secret.md`)).toBeDefined()
      expect(guard.checkCommand('cat README.md')).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!hasBwrap)('bubblewrap sandbox', () => {
  it('passes the preflight', async () => {
    resetIsolationCache()
    const decision = await decideIsolation('auto')
    expect(decision.mode).toBe('sandbox')
  })

  it('makes the filesystem read-only, keeps a private scratch, and masks private paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-rsi-bwrap-'))
    try {
      const cwd = join(root, 'cwd')
      const scratch = join(root, 'scratch')
      const hidden = join(root, 'memory')
      await mkdir(cwd)
      await mkdir(scratch)
      await mkdir(hidden)
      await writeFile(join(hidden, 'secret.md'), 'SECRET')
      await writeFile(join(cwd, 'app.txt'), 'original')
      resetIsolationCache()
      const decision = await decideIsolation('sandbox')
      const command = sandboxCommand(decision.bwrap!, { cwd, scratch, hidden: [hidden] }, `
        (echo mutated > app.txt) 2>/dev/null && echo WROTE-CANDIDATE
        echo note > "$RSI_SCRATCH/n" && cat "$RSI_SCRATCH/n"
        cat ${hidden}/secret.md 2>/dev/null || echo NO-SECRET
        echo "scratch=$RSI_SCRATCH"
      `)
      const out = execFileSync('bash', ['-c', command], { cwd, encoding: 'utf8' })
      expect(out).not.toContain('WROTE-CANDIDATE')
      expect(out).toContain('note')
      expect(out).toContain('NO-SECRET')
      expect(out).toContain(`scratch=${scratch}`)
      expect(await readFile(join(cwd, 'app.txt'), 'utf8')).toBe('original')
      expect(await readFile(join(scratch, 'n'), 'utf8')).toBe('note\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs the interactive Verifier inside the sandbox', async () => {
    harness = await makeHarness({ config: { verifier: { isolation: 'sandbox' } }, files: { 'app.txt': 'original\n' } })
    const h = harness
    h.script('main', [call('rsi_submit'), say('ok')])
    h.script('verifier', [
      call('bash', { command: 'echo mutated > app.txt; echo $? ; echo probe > "$RSI_SCRATCH/p" && cat "$RSI_SCRATCH/p"; ls "$HOME/.pi" 2>&1 | head -1' }),
      call('grep', { pattern: 'SECRET', path: '/' }),
      say('VERDICT: PASS\nThe file is intact.'),
    ])
    await h.session.prompt('Keep app.txt.')
    const [result] = toolResults(h.session)
    expect(result!.text).toMatch(/^VERDICT: PASS/)
    expect(result!.text).not.toContain('HARNESS NOTE')
    expect(await readFile(join(h.project, 'app.txt'), 'utf8')).toBe('original\n')
    const verifierCalls = h.calls.filter(entry => entry.role === 'verifier')
    expect(verifierCalls[1]!.input).toContain('Read-only file system')
    expect(verifierCalls[1]!.input).toContain('probe')
    // A recursive search of / would traverse the private agent directory.
    expect(verifierCalls[2]!.input).toContain('would traverse paths hidden from this role')
    expect(verifierCalls[0]!.system).toContain('$RSI_SCRATCH')
  })

  it('hides sibling projects of a wave from a sandboxed lineage Actor', async () => {
    harness = await makeHarness({ config: { verifier: { isolation: 'sandbox' } } })
    const h = harness
    let firstRoot = ''
    h.script('main', [call('rsi_explore', { phase: 'broad', direction: 'file chores', lineage: 'sib' }), say('ok')])
    h.script('curriculum', [
      context => {
        const root = /create one nonempty fixture tree per project at:\n\s+(\S+)\/<id>/.exec(lastInput(context))![1]!
        return call('bash', { command: `mkdir -p ${root}/a ${root}/b && echo in > ${root}/a/in.txt && echo in > ${root}/b/in.txt` })
      },
      say(JSON.stringify({ decision: 'WAVE', rationale: 'two', projects: [
        { id: 'a', instruction: 'In <PROJECT_ROOT>, write secret-a.txt.' },
        { id: 'b', instruction: 'In <PROJECT_ROOT>, write b.txt.' },
      ] })),
      say(JSON.stringify({ decision: 'SATURATED', rationale: 'enough', projects: [] })),
    ])
    h.script('actor', [
      // Project a
      context => {
        firstRoot = /PROJECT ROOT: (\S+)/.exec(lastInput(context))![1]!
        return call('bash', { command: 'echo SIBLING-SECRET > secret-a.txt' })
      },
      say('STATUS: SUBMIT'),
      // Project b tries to read a's work, then submits.
      () => call('bash', { command: `cat ${firstRoot}/secret-a.txt 2>&1; ls ${firstRoot} 2>&1; echo done > b.txt` }),
      () => call('read', { path: `${firstRoot}/secret-a.txt` }),
      say('STATUS: SUBMIT'),
      // Serial learning: a, then b.
      say('distilled'), say('reconciled'),
      say('distilled'), say('reconciled'),
    ])
    h.script('verifier', [say('VERDICT: PASS'), say('VERDICT: PASS')])
    await h.session.prompt('explore')
    const [result] = toolResults(h.session)
    expect(result!.text).toContain('ended: saturated')
    const actorInputs = h.calls.filter(entry => entry.role === 'actor').map(entry => entry.input)
    const probe = actorInputs.find(input => input.includes('No such file') || input.includes('SIBLING-SECRET'))
    expect(probe).toBeDefined()
    expect(probe).not.toContain('SIBLING-SECRET')
    expect(actorInputs.some(input => input.includes("belongs to another project of this lineage"))).toBe(true)
  })
})

