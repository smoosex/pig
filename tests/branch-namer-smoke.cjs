const { app, utilityProcess } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const root = mkdtempSync(join(tmpdir(), 'pig-namer-smoke-'))
const agentDir = join(root, 'agent')
mkdirSync(agentDir)
writeFileSync(join(root, 'AGENTS.md'), 'DO_NOT_INCLUDE_CONTEXT')
writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), 'DO_NOT_INCLUDE_APPEND')
app.setPath('userData', join(root, 'electron'))
const children = new Set()
let requestBody
let done = false
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    requestBody = JSON.parse(body)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, reason) => JSON.stringify({
      id: 'test', object: 'chat.completion.chunk', created: 1, model: 'namer',
      choices: [{ index: 0, delta, finish_reason: reason }]
    })
    res.write(`data: ${chunk({ role: 'assistant', content: 'feat/add-search' }, null)}\n\n`)
    res.write(`data: ${chunk({}, 'stop')}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
const finish = (error) => {
  if (done) return
  done = true
  clearTimeout(timer)
  for (const child of children) child.kill()
  server.close()
  if (error) console.error(error)
  else console.log('PASS: Pi utility worker names via mock provider, exposes no tools/context, saves no sessions, and exits')
  rmSync(root, { recursive: true, force: true })
  app.exit(error ? 1 : 0)
}
const timer = setTimeout(() => finish(new Error('Worker timeout')), 20000)

function run(modelId) {
  return new Promise((yes, no) => {
    const child = utilityProcess.fork(resolve('out/main/branch-namer-worker.js'), [], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' },
      stdio: 'pipe'
    })
    children.add(child)
    let reply
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    child.stdout.resume()
    child.once('spawn', () => child.postMessage({ text: 'Add search', provider: 'pig-test', modelId }))
    child.once('message', (message) => { reply = message })
    child.once('exit', (code) => {
      children.delete(child)
      if (code === 0 && reply) yes(reply)
      else no(new Error(`Worker exited without result: ${code}`))
    })
  })
}

app.whenReady().then(async () => {
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes))
  const port = server.address().port
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {
    'pig-test': {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'test',
      models: [{ id: 'namer', reasoning: false, contextWindow: 4096, maxTokens: 128 }]
    }
  } }))
  assert.equal((await run('missing')).error, '默认命名模型不可用')
  assert.equal((await run('namer')).branch, 'feat/add-search')
  assert.equal(requestBody.tools?.length || 0, 0)
  assert.match(JSON.stringify(requestBody.messages), /Reserve fix\//)
  assert.equal(JSON.stringify(requestBody.messages).includes('DO_NOT_INCLUDE'), false)
  const files = readdirSync(root, { recursive: true }).map(String)
  assert.equal(files.some((file) => file.endsWith('.jsonl')), false)
  finish()
}).catch(finish)
