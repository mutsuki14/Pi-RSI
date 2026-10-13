import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, makeHarness, say, toolResults, type Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('interactive Actor protocol', () => {
  it('runs submit → PASS → learn → write → reconcile → commit and promotes memory outside the project', async () => {
    harness = await makeHarness({ config: { verifier: { isolation: 'rollback' } } })
    const h = harness
    h.script('main', [
      async () => {
        await writeFile(join(h.project, 'hello.txt'), 'hello\n')
        return call('rsi_submit')
      },
      call('rsi_learn'),
      call('rsi_memory_write', { path: 'procedures/hello.md', content: 'Write hello.txt with one line: hello.\n' }),
      call('rsi_memory_commit'),
      call('rsi_memory_commit'),
      say('done'),
    ])
    h.script('verifier', [
      call('read', { path: 'hello.txt' }),
      say('Checked hello.txt: it contains exactly "hello".\nVERDICT: PASS'),
    ])
    await h.session.prompt('Create hello.txt containing the word hello.')

    const results = toolResults(h.session)
    expect(results.map(result => result.tool)).toEqual(['rsi_submit', 'rsi_learn', 'rsi_memory_write', 'rsi_memory_commit', 'rsi_memory_commit'])
    expect(results.every(result => !result.isError)).toBe(true)
    expect(results[0]!.text).toMatch(/^VERDICT: PASS/)
    expect(results[1]!.text).toContain('MEMORY DISTILLATION')
    expect(results[3]!.text).toContain('MEMORY RECONCILIATION')
    expect(results[4]!.text).toContain('Memory promoted (PASS experience)')

    // The Verifier saw the user's request verbatim and the git change facts, nothing of the Actor's.
    const verifierCalls = h.calls.filter(entry => entry.role === 'verifier')
    expect(verifierCalls).toHaveLength(2)
    expect(verifierCalls[0]!.input).toContain('Create hello.txt containing the word hello.')
    expect(verifierCalls[0]!.input).toContain('?? hello.txt')
    expect(verifierCalls[0]!.system).not.toContain('rsi_submit')

    // The main Actor's system prompt carries the protocol and the memory inventory.
    const main = h.calls.find(entry => entry.role === 'main')!
    expect(main.system).toContain('Recursive self-improvement protocol (pi-rsi)')
    expect(main.system).toContain('YOUR MEMORY')

    const memoryFile = await readFile(join(h.agentDir, 'rsi', 'projects'), 'utf8').catch(() => undefined)
    expect(memoryFile).toBeUndefined() // a directory, not a file
    const { readdir } = await import('node:fs/promises')
    const [projectKey] = await readdir(join(h.agentDir, 'rsi', 'projects'))
    const stored = await readFile(join(h.agentDir, 'rsi', 'projects', projectKey!, 'store', 'memory', 'procedures', 'hello.md'), 'utf8')
    expect(stored).toBe('Write hello.txt with one line: hello.\n')
    // Nothing of pi-rsi lands in the project.
    expect((await readdir(h.project)).sort()).toEqual(['.git', 'README.md', 'hello.txt'])
  })

  it('refuses memory writes outside a learning phase', async () => {
    harness = await makeHarness()
    harness.script('main', [call('rsi_memory_write', { path: 'x.md', content: 'x' }), say('ok')])
    await harness.session.prompt('remember x')
    const [result] = toolResults(harness.session)
    expect(result!.isError).toBe(true)
    expect(result!.text).toContain('read-only while you work')
  })

  it('continues a Verifier that ends without a verdict in the same context, and reports infrastructure after three actionless segments', async () => {
    harness = await makeHarness({ config: { verifier: { isolation: 'rollback' } } })
    const h = harness
    h.script('main', [call('rsi_submit'), say('stopped')])
    h.script('verifier', [say('looks fine'), say('still thinking'), say('no verdict')])
    await h.session.prompt('Do the thing.')
    const [result] = toolResults(h.session)
    expect(result!.isError).toBe(true)
    expect(result!.text).toContain('infrastructure failure, not a verdict')
    const verifierCalls = h.calls.filter(entry => entry.role === 'verifier')
    expect(verifierCalls).toHaveLength(3)
    expect(verifierCalls[1]!.input).toContain('SAME-CONTEXT TRANSPORT CONTINUATION')
  })

  it('restores candidate files the Verifier changed (rollback isolation)', async () => {
    harness = await makeHarness({ config: { verifier: { isolation: 'rollback' } }, files: { 'app.txt': 'original\n' } })
    const h = harness
    h.script('main', [call('rsi_submit'), say('ok')])
    h.script('verifier', [
      call('bash', { command: 'echo mutated > app.txt; echo junk > stray.tmp; echo "$RSI_SCRATCH" > /dev/null' }),
      say('VERDICT: FAIL\napp.txt is wrong'),
    ])
    await h.session.prompt('Keep app.txt.')
    const [result] = toolResults(h.session)
    expect(result!.text).toMatch(/^VERDICT: FAIL/)
    expect(result!.text).toContain('2 path(s) changed during the inspection and were restored: app.txt, stray.tmp')
    expect(result!.text).toContain('[MEMORY RETRIEVAL OPPORTUNITY]')
    expect(await readFile(join(h.project, 'app.txt'), 'utf8')).toBe('original\n')
  })

  it('keeps one Verifier context across revisions of a task and hides write tools from it', async () => {
    harness = await makeHarness({ config: { verifier: { isolation: 'rollback' } } })
    const h = harness
    h.script('main', [call('rsi_submit'), call('rsi_submit'), say('done')])
    h.script('verifier', [
      call('write', { path: 'x.txt', content: 'x' }),
      say('VERDICT: FAIL\nmissing output'),
      say('VERDICT: PASS'),
    ])
    await h.session.prompt('Produce output.')
    const results = toolResults(h.session)
    expect(results.map(result => result.text.split('\n')[0])).toEqual(['VERDICT: FAIL', 'VERDICT: PASS'])
    const verifierCalls = h.calls.filter(entry => entry.role === 'verifier')
    // Same context: the second inspection's charter says generation 2 and the context persists.
    expect(verifierCalls.at(-1)!.input).toContain('This is candidate generation 2')
    expect(verifierCalls[1]!.input).toContain('Tool write not found')
  })
})
