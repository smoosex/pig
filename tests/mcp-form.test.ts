/** Quoted commands, pasted shapes and literal credentials are the manual form's essential contract. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate, type Translate } from '../src/shared/i18n'
import {
  formatMcpCommand,
  mcpConfigFromForm,
  mcpFormFromConfig,
  mcpFormPairs,
  parseMcpCommand,
  parseMcpPaste
} from '../src/renderer/src/lib/mcp-form'

const t: Translate = (key, params) => translate('en', key, params)

test('command lines preserve quoted, empty, escaped and Windows arguments without expansion', () => {
  assert.deepEqual(parseMcpCommand(`npx -y server 'two words' "" escaped\\ space`, t), {
    command: 'npx',
    args: ['-y', 'server', 'two words', '', 'escaped space']
  })
  const command = 'C:\\Program Files\\server.exe'
  const args = ['C:\\work\\', 'double"quote', "single'quote", '', '$TOKEN', '!echo', 'line\nbreak']
  assert.deepEqual(parseMcpCommand(formatMcpCommand(command, args), t), { command, args })
  assert.deepEqual(parseMcpCommand('npx server C:\\work', t), {
    command: 'npx',
    args: ['server', 'C:\\work']
  })
  assert.deepEqual(parseMcpCommand('   ', t), { command: '', args: [] })
  assert.equal(formatMcpCommand('', []), '')
  assert.throws(() => parseMcpCommand('npx "unfinished', t), /unclosed quote/)
})

test('pasting accepts a single config, a named entry and complete mcpServers, but never repairs malformed JSON', () => {
  const config = { command: 'npx', args: ['-y', 'docs'], env: { TOKEN: '${TOKEN}' }, timeout: 9000 }
  assert.deepEqual(parseMcpPaste(JSON.stringify(config), t), { kind: 'single', config })
  assert.deepEqual(parseMcpPaste(JSON.stringify({ docs: config }), t), {
    kind: 'single',
    name: 'docs',
    config
  })
  assert.deepEqual(parseMcpPaste(JSON.stringify({ mcpServers: { docs: config } }), t), {
    kind: 'single',
    name: 'docs',
    config
  })
  const document = { mcpServers: { docs: config, remote: { url: 'https://example.com/mcp' } } }
  assert.deepEqual(parseMcpPaste(JSON.stringify(document), t), { kind: 'multiple', document })
  assert.throws(() => parseMcpPaste('{"mcpServers":', t), SyntaxError)
  assert.throws(() => parseMcpPaste('[{"command":"npx"}]', t), /Accepts one server/)
  assert.throws(() => parseMcpPaste('{"mcpServers":{}}', t), /No server/)
  assert.throws(() => parseMcpPaste('{"mcpServers":{"bad":42}}', t), /Accepts one server/)
  assert.throws(
    () => parseMcpPaste('{"mcpServers":{"bad":{"type":"sse","url":"https://example.com/sse"}}}', t),
    /SSE/
  )
})

test('form round trips preserve advanced fields and existing config expressions; transport changes remove incompatible fields', () => {
  const config = {
    type: 'stdio',
    command: 'uvx',
    args: ['mcp-server', '/two words', ''],
    cwd: '/work',
    env: { TOKEN: '!read-token', OTHER: '$HOME', LITERAL: '$$TOKEN', BANG: '$!literal' },
    exposure: 'deferred',
    timeout: 9000,
    description: 'Custom description'
  }
  const form = mcpFormFromConfig(config, t)
  assert.equal(form.env.find((pair) => pair.key === 'LITERAL')!.value, '$TOKEN')
  assert.deepEqual(mcpConfigFromForm(config, form, t), config)
  assert.deepEqual(config.env, {
    TOKEN: '!read-token',
    OTHER: '$HOME',
    LITERAL: '$$TOKEN',
    BANG: '$!literal'
  })
  const remote = mcpConfigFromForm(
    config,
    { ...form, transport: 'http', url: ' https://example.com/mcp ' },
    t
  )
  assert.equal(remote.url, 'https://example.com/mcp')
  for (const key of ['command', 'args', 'env', 'cwd']) assert.equal(key in remote, false)
  assert.equal(remote.timeout, 9000)
  const local = mcpConfigFromForm({ ...remote, oauth: {}, auth: {} }, form, t)
  for (const key of ['url', 'headers', 'oauth', 'auth']) assert.equal(key in local, false)
  assert.throws(() => mcpFormFromConfig({ url: 'https://example.com', type: 'sse' }, t), /SSE/)
  assert.throws(() => mcpFormFromConfig({ command: 'npx', args: [42] }, t), /Accepts one server/)
  assert.throws(() => mcpFormFromConfig({ command: 'npx', env: { TOKEN: 42 } }, t), /TOKEN.*string/)
})

test('new key/value inputs are literal except an explicit variable reference and reject silent key loss', () => {
  assert.deepEqual(
    mcpFormPairs(
      [
        { key: ' TOKEN ', value: '!echo $TOKEN' },
        { key: 'REF', value: '${TOKEN}' },
        { key: 'LITERAL', value: '$TOKEN' },
        { key: '', value: '' }
      ],
      t
    ),
    { TOKEN: '$!echo $$TOKEN', REF: '${TOKEN}', LITERAL: '$$TOKEN' }
  )
  const form = mcpFormFromConfig({ command: 'npx', env: { TOKEN: '!old-command' } }, t)
  form.env[0].value = '!new-token'
  assert.equal(mcpFormPairs(form.env, t).TOKEN, '$!new-token')
  assert.throws(() => mcpFormPairs([{ key: '', value: 'secret' }], t), /Enter a key/)
  assert.throws(
    () =>
      mcpFormPairs(
        [
          { key: 'KEY', value: 'a' },
          { key: ' KEY ', value: 'b' }
        ],
        t
      ),
    /Duplicate key: KEY/
  )
})
