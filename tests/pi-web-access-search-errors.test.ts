/** Provider routing must use OpenAI's stream identifiers, including after credential redaction. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function routingFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pig-web-search-errors-'))
  process.env.PIG_DIR = root
  process.env.OPENAI_API_KEY = 'fixture-openai-secret'
  process.env.TAVILY_API_KEY = 'fixture-tavily-secret'
  await writeFile(join(root, 'web-search.json'), JSON.stringify({
    searchRouting: { providers: ['openai', 'tavily'], fallbackOn: ['quota'] }
  }))
  const { search, SearchProviderError } = await import('../src/main/plugins/pi-web-access/gemini-search.ts')
  const { OpenAIStreamError } = await import('../src/main/plugins/pi-web-access/openai-search.ts')
  let body = ''
  let fallbackCalls = 0
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes('tavily.com')) {
      fallbackCalls++
      return Response.json({ answer: 'fallback', results: [{ title: 'Result', url: 'https://example.test/', content: 'result' }] })
    }
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch
  const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
  try {
    const failures = [
      { error: { type: 'authentication_error', code: 'invalid_api_key', message: 'quota details fixture-openai-secret' }, kind: 'auth' },
      { error: { type: 'permission_error', message: 'quota details' }, kind: 'auth' },
      { error: { type: 'server_error', code: 'internal_error', message: 'quota details' }, kind: 'transient' },
      { error: { type: 'invalid_request_error', code: 'unknown_code', message: 'quota details' }, kind: 'invalid-request' },
      { error: { type: 'unknown_type', code: 'unknown_code', message: 'quota details' }, kind: 'invalid-response' }
    ]
    for (const scenario of failures) {
      for (const event of [
        { type: 'error', error: scenario.error },
        { type: 'response.failed', response: { error: scenario.error } }
      ]) {
        body = sse(event)
        await assert.rejects(search('query'), (error: unknown) => {
          assert.ok(error instanceof SearchProviderError)
          assert.equal(error.kind, scenario.kind)
          assert.ok(error.causeError instanceof OpenAIStreamError)
          assert.equal(error.causeError.code, scenario.error.code)
          assert.equal(error.causeError.type, scenario.error.type)
          assert.ok(!error.message.includes('fixture-openai-secret'), 'credentials must remain redacted')
          return true
        })
        assert.equal(fallbackCalls, 0, 'non-quota identifiers must not enter fallbackOn: quota')
      }
    }

    for (const event of [
      { type: 'error', code: 'rate_limit_exceeded', message: 'authentication error wording must not override code' },
      { type: 'error', error: { type: 'invalid_request_error', code: 'subscription_sharing_usage_limit_exceeded', message: 'try later' } }
    ]) {
      body = sse(event)
      const result = await search('query')
      assert.equal(result.provider, 'tavily')
    }
    assert.equal(fallbackCalls, 2)

    const completion = { type: 'response.completed', response: { output: [
      { type: 'web_search_call', action: { sources: [{ title: 'Source', url: 'https://example.test/' }] } },
      { type: 'message', content: [{ type: 'output_text', text: 'answer' }] }
    ] } }
    body = `data: {"type":broken}\n\n${sse(completion)}`
    await assert.rejects(search('query'), (error: unknown) => {
      assert.ok(error instanceof SearchProviderError)
      assert.equal(error.kind, 'invalid-response')
      assert.match(error.message, /invalid JSON in stream/)
      return true
    })
    assert.equal(fallbackCalls, 2, 'malformed stream events must not be ignored')

    body = sse(completion)
    const success = await search('query')
    assert.equal(success.provider, 'openai')
    assert.equal(success.answer, 'answer')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--web-search-errors-fixture')) {
  await routingFixture()
} else {
  const { test } = await import('bun:test')
  test('OpenAI routing preserves error codes/types, rejects malformed SSE, and never classifies prose as quota', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--web-search-errors-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 10000)
    try {
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, errors || output)
    } finally {
      clearTimeout(timeout)
    }
  }, 12000)
}
