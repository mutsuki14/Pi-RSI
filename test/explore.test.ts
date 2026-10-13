import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, lastInput, makeHarness, say, toolResults, type Harness } from './harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function stateDir(h: Harness): Promise<string> {
  const [key] = await readdir(join(h.agentDir, 'rsi', 'projects'))
  return join(h.agentDir, 'rsi', 'projects', key!)
}

/** The <PROJECT_ROOT> the Actor was given in its opening brief. */
function projectRootOf(input: string): string {
  const match = /PROJECT ROOT: (\S+)/.exec(input)
  if (!match) throw new Error(`no project root in: ${input.slice(0, 300)}`)
  return match[1]!
}

describe('exploration lineages', () => {
  it('Phase 1: authors a wave with fixtures, verifies it, learns in order, and saturates', async () => {
    harness = await makeHarness({ config: { verifier: { isolation: 'rollback' } } })
    const h = harness
    h.script('main', [call('rsi_explore', { phase: 'broad', direction: 'Small text-file chores in a POSIX shell.' }), say('explored')])
    h.script('curriculum', [
      context => {
        const root = /create one nonempty fixture tree per project at:\n\s+(\S+)\/<id>/.exec(lastInput(context))![1]!
        return call('write', { path: `${root}/upper/input.txt`, content: 'hello\n' })
      },
      call('rsi_notes', { content: 'hypothesis: case conversion is easy' }),
      say(JSON.stringify({
        decision: 'WAVE',
        rationale: 'probe basic text transforms',
        projects: [{ id: 'upper', instruction: 'In <PROJECT_ROOT>, write output.txt holding input.txt in upper case.' }],
      })),
      context => {
        const input = lastInput(context)
        expect(input).toContain('TERMINAL OUTCOME: PASS')
        expect(input).toContain('MEMORY CHANGES')
        expect(input).toContain('hypothesis: case conversion is easy')
        return say(JSON.stringify({ decision: 'SATURATED', rationale: 'one transfer shown', projects: [] }))
      },
    ])
    h.script('actor', [
      context => {
        const root = projectRootOf(lastInput(context))
        return call('bash', { command: `tr a-z A-Z < ${root}/input.txt > ${root}/output.txt` })
      },
      say('STATUS: SUBMIT\nwrote output.txt'),
      // Learning phase in the same context: distill, reconcile.
      call('rsi_memory_write', { path: 'procedures/upper.md', content: 'Use tr a-z A-Z for ASCII upper case.\n' }),
      say('draft ready'),
      call('rsi_memory_list'),
      say('reconciled'),
    ])
    h.script('verifier', [
      context => {
        expect(lastInput(context)).toContain('write output.txt holding input.txt in upper case')
        return call('read', { path: 'output.txt' })
      },
      say('output.txt is HELLO.\nVERDICT: PASS'),
    ])
    await h.session.prompt('Explore text chores.')

    const [result] = toolResults(h.session)
    expect(result!.isError).toBe(false)
    expect(result!.text).toContain('ended: saturated')
    const state = await stateDir(h)
    expect(await readFile(join(state, 'store', 'memory', 'procedures', 'upper.md'), 'utf8')).toContain('tr a-z A-Z')
    const [lineage] = await readdir(join(state, 'lineages'))
    const record = JSON.parse(await readFile(join(state, 'lineages', lineage!, 'result.json'), 'utf8'))
    expect(record.termination).toBe('saturated')
    expect(record.projects).toHaveLength(1)
    expect(record.officialEvaluatorCalls).toBe(0)
    const events = (await readFile(join(state, 'lineages', lineage!, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).type)
    expect(events).toEqual(['WAVE_AUTHORED', 'WAVE_FIXTURES_CAPTURED', 'PROJECT_SUBMITTED', 'PROJECT_VERIFIED', 'MEMORY_COMMITTED', 'WAVE_COMPLETED', 'PHASE1_TERMINATED'])
    // Role transcripts are persisted privately for inspection: curriculum, actor, verifier.
    const sessions = await readdir(join(state, 'lineages', lineage!, 'sessions'))
    expect(sessions.filter(name => name.endsWith('.jsonl'))).toHaveLength(3)
  })

  it('Phase 2: attempts the target, learns with a diagnosis, and stops on a verifier PASS', async () => {
    harness = await makeHarness({ config: { verifier: { isolation: 'rollback' }, exploration: { stopPolicy: 'verifier_pass' } } })
    const h = harness
    h.script('main', [call('rsi_explore', { phase: 'deep', target: 'In <PROJECT_ROOT>, create answer.txt containing 42.' }), say('done')])
    h.script('actor', [
      context => {
        const root = projectRootOf(lastInput(context))
        return call('write', { path: `${root}/answer.txt`, content: '42\n' })
      },
      say('STATUS: SUBMIT\nanswer.txt written'),
      call('rsi_memory_write', { path: 'facts/answer.md', content: 'The answer file holds 42.\n' }),
      say('distilled'),
      say('reconciled'),
      say('DIAGNOSIS: trivial target; writing a file with the write tool is reliable.'),
    ])
    h.script('verifier', [call('read', { path: 'answer.txt' }), say('VERDICT: PASS')])
    await h.session.prompt('Practice the answer target.')

    const [result] = toolResults(h.session)
    expect(result!.isError).toBe(false)
    expect(result!.text).toContain('ended: verifier_pass')
    const state = await stateDir(h)
    expect(await readFile(join(state, 'store', 'memory', 'facts', 'answer.md'), 'utf8')).toContain('42')
    const journal = (await readFile(join(state, 'store', 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(journal).toHaveLength(1)
    expect(journal[0].kind).toBe('target')
    expect(journal[0].outcome).toBe('PASS')
    // The Curriculum never ran under verifier_pass.
    expect(h.calls.some(entry => entry.role === 'curriculum')).toBe(false)
  })

  it('refuses a deep target that does not name <PROJECT_ROOT>', async () => {
    harness = await makeHarness()
    harness.script('main', [call('rsi_explore', { phase: 'deep', target: 'make a file' }), say('ok')])
    await harness.session.prompt('go')
    const [result] = toolResults(harness.session)
    expect(result!.isError).toBe(true)
    expect(result!.text).toContain('<PROJECT_ROOT>')
  })

  it('ends an Actor that never hands off as unscored infrastructure, without committing memory', async () => {
    harness = await makeHarness({ config: { verifier: { isolation: 'rollback' }, exploration: { stopPolicy: 'verifier_pass', targetResumes: 0 }, transport: { actionlessLimit: 2, ceiling: 4 } } })
    const h = harness
    h.script('main', [call('rsi_explore', { phase: 'deep', target: 'In <PROJECT_ROOT>, do nothing.', lineage: 'stall-1' }), say('done')])
    // Two actionless segments stall the work phase; the forced inspection then decides.
    h.script('actor', [say('thinking'), say('still thinking')])
    h.script('verifier', [say('VERDICT: UNVERIFIED\nnothing to inspect')])
    await h.session.prompt('go')
    const [result] = toolResults(h.session)
    expect(result!.isError).toBe(false)
    expect(result!.text).toContain('target_harness_unverified')
    const state = await stateDir(h)
    const journal = await readFile(join(state, 'store', 'journal.jsonl'), 'utf8').catch(() => '')
    expect(journal.trim()).toBe('')
  })
})
