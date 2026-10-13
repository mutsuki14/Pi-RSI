#!/usr/bin/env node
// Scripted OpenAI-compatible chat-completions server for the pi-rsi CLI e2e.
// Each role (main Actor, Verifier) follows its own script; a request's role is
// recognized from its system prompt. Prints "LISTENING <port>" when ready and
// writes every request it served to the log file given as argv[2].
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const log = process.argv[2]
const project = process.argv[3]

const tool = (name, args) => ({ tool: { name, args } })
const text = content => ({ text: content })

const scripts = {
  main: [
    tool('bash', { command: `printf 'hello\\n' > ${project}/hello.txt` }),
    tool('rsi_submit', {}),
    tool('rsi_learn', {}),
    tool('rsi_memory_write', { path: 'procedures/hello.md', content: 'Write hello.txt with printf; verify with cat.\n' }),
    tool('rsi_memory_commit', {}),
    tool('rsi_memory_commit', {}),
    text('E2E-DONE'),
  ],
  verifier: [
    tool('bash', { command: 'cat hello.txt; echo probe > "$RSI_SCRATCH/p" && echo scratch-ok; (echo x > hello.txt) 2>&1 | head -1' }),
    text('hello.txt holds exactly "hello".\nVERDICT: PASS'),
  ],
}

function systemText(body) {
  const parts = []
  for (const message of body.messages ?? []) {
    if (message.role !== 'system' && message.role !== 'developer') continue
    if (typeof message.content === 'string') parts.push(message.content)
    else if (Array.isArray(message.content)) for (const block of message.content) if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function roleOf(body) {
  return systemText(body).includes('You are an independent Verifier Agent') ? 'verifier' : 'main'
}

let counter = 0
function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({ id: `chatcmpl-${counter}`, object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', data => { raw += data })
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    const body = JSON.parse(raw)
    const role = roleOf(body)
    const step = scripts[role].shift()
    const last = (body.messages ?? []).at(-1)
    appendFileSync(log, `${JSON.stringify({ role, step: step ?? null, last: typeof last?.content === 'string' ? last.content.slice(0, 2000) : JSON.stringify(last?.content ?? '').slice(0, 2000), tools: (body.tools ?? []).map(t => t.function?.name) })}\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    counter++
    if (!step) {
      res.write(chunk({ role: 'assistant', content: 'SCRIPT EXHAUSTED' }))
      res.write(chunk({}, 'stop'))
    } else if (step.tool) {
      res.write(chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${counter}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }))
      res.write(chunk({}, 'tool_calls'))
    } else {
      res.write(chunk({ role: 'assistant', content: step.text }))
      res.write(chunk({}, 'stop'))
    }
    res.write(`data: ${JSON.stringify({ id: `chatcmpl-${counter}`, object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`)
})
