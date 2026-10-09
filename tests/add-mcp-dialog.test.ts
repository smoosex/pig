/** The manual sheet fills from a paste, never saves implicitly, and keeps JSON/conflict boundaries. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type {
  McpConfig,
  McpMarketServer,
  McpServerView,
  McpSettingsState,
  SessionApi
} from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const state: McpSettingsState = {
    codemode: false,
    projects: {},
    pendingSessions: [],
    servers: []
  }
  const writes: Array<{
    source: Record<string, unknown>
    replaced: string[]
    name?: string
    icon?: string
  }> = []
  const saved = () => writes.at(-1)!
  const entries = (json: string, name?: string) => {
    const raw = JSON.parse(json) as Record<string, unknown>
    const map =
      'command' in raw || 'url' in raw
        ? { [name ?? '']: raw }
        : ((raw.mcpServers ?? raw) as Record<string, unknown>)
    return Object.entries(map).map(([key, value]) => ({
      name: key,
      config: { ...(value as McpConfig), enabled: false },
      conflict: key === 'existing' || key === 'keep'
    }))
  }
  const service = {
    getMcpSettings: async () => state,
    previewMcpImport: async (json: string, name?: string) => entries(json, name),
    importMcpServers: async (json: string, replaced: string[], name?: string, icon?: string) => {
      writes.push({ source: JSON.parse(json), replaced, name, icon })
      return state
    }
  } satisfies Partial<SessionApi>
  Object.assign(window, { api: service })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  const { useToolSettingsStore: store } = await import('../src/renderer/src/stores/tool-settings')
  const { AddMcpDialog } = await import('../src/renderer/src/components/settings/AddMcpDialog')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let closed = 0
  let generation = 0
  const mount = async (props: { server?: McpServerView; recipe?: McpMarketServer } = {}) => {
    writes.length = 0
    closed = 0
    await act(async () => {
      store.setState({ state, busy: false, loaded: true, error: undefined })
      root.render(
        h(AddMcpDialog, {
          ...props,
          key: generation++,
          onClose: () => {
            closed++
          }
        })
      )
    })
  }
  const button = (text: string) => {
    const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => (node.getAttribute('aria-label') ?? node.textContent) === text
    )
    assert.ok(result, `Missing button ${text}`)
    return result
  }
  const click = async (text: string) => {
    await act(async () => {
      button(text).click()
    })
  }
  const input = (id: string) => {
    const result = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null
    assert.ok(result, `Missing input ${id}`)
    return result
  }
  const fill = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const labeled = (label: string) => {
    const found = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    assert.ok(found, `Missing input ${label}`)
    return found
  }
  const paste = async (element: Element, text: string) => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
    await act(async () => {
      element.dispatchEvent(event)
    })
    return event
  }
  const jsonButton = 'JSON'
  try {
    await mount()
    assert.equal(
      document.querySelector('[data-slot="dialog-title"]')!.textContent,
      'New MCP server'
    )
    assert.equal(document.querySelector('[data-slot="dialog-close"]'), null)
    assert.equal(document.querySelector('input[placeholder="e.g. github"]')!.id, 'mcp-name')
    assert.equal(input('mcp-command').value, '')
    assert.equal(button('Command').getAttribute('data-state'), 'on')
    const transport = button('Command').closest('[data-slot="toggle-group"]')!
    assert.equal(transport.getAttribute('data-size'), 'xs')
    assert.equal(transport.getAttribute('data-spacing'), '0.5')
    assert.ok(transport.classList.contains('border'))
    assert.ok(transport.classList.contains('p-px'))
    assert.equal(button('Command').getAttribute('data-variant'), 'default')
    const modes = document.querySelector('[data-slot="dialog-header"] [data-slot="toggle-group"]')!
    assert.equal(modes.getAttribute('aria-label'), 'Editor mode')
    assert.equal(modes.getAttribute('data-size'), 'xs')
    assert.equal(modes.getAttribute('data-spacing'), '0.5')
    assert.ok(modes.classList.contains('border'))
    assert.ok(modes.classList.contains('p-px'))
    assert.deepEqual(
      [...modes.querySelectorAll('[data-slot="toggle-group-item"]')].map(
        (node) => node.textContent
      ),
      ['Form', 'JSON']
    )
    assert.equal(button('JSON').getAttribute('data-state'), 'off')
    assert.equal(button('Form').getAttribute('data-state'), 'on')
    await click('Form')
    assert.equal(
      button('Form').getAttribute('data-state'),
      'on',
      'the active mode cannot be deselected'
    )
    assert.equal(button('Add').disabled, true)
    assert.equal(document.body.textContent?.includes('Agent'), false)
    await click('JSON')
    assert.equal(input('mcp-json').value, '')
    assert.deepEqual(JSON.parse(input('mcp-json').getAttribute('placeholder')!), {
      type: 'stdio',
      command: '',
      args: [],
      env: {}
    })
    assert.equal(button('Add').disabled, true, 'a placeholder is not a configuration')
    await click('Form')
    assert.equal(
      document.querySelector('[role="alert"]'),
      null,
      'an empty editor can return to the form'
    )
    await click('HTTP')
    await click('JSON')
    assert.equal(input('mcp-json').value, '')
    assert.deepEqual(JSON.parse(input('mcp-json').getAttribute('placeholder')!), {
      type: 'http',
      url: '',
      headers: {}
    })
    await fill(input('mcp-json'), '   ')
    assert.equal(button('Add').disabled, true)
    await click('Form')
    await click('Command')
    await fill(input('mcp-name'), 'docs')
    await fill(input('mcp-command'), 'npx -y docs "two words"')
    await click('Add Variable name')
    await fill(labeled('Variable name 1'), 'TOKEN')
    await fill(labeled('Value 1'), '!secret $TOKEN')
    await click('Add Variable name')
    await fill(labeled('Variable name 2'), 'UNUSED')
    await click('Remove row 2')
    assert.equal(document.querySelector('input[aria-label="Variable name 2"]'), null)
    await click('JSON')
    assert.equal(
      JSON.parse(input('mcp-json').value).command,
      'npx',
      'real form input remains editable JSON'
    )
    await click('Form')
    await click('Add')
    assert.deepEqual(saved().source, {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'docs', 'two words'],
      env: { TOKEN: '$!secret $$TOKEN' }
    })
    assert.equal(saved().name, 'docs')
    assert.equal(closed, 1)

    await mount()
    const config = {
      command: 'uvx',
      args: ['docs', '/two words', ''],
      env: { TOKEN: '${TOKEN}' },
      timeout: 15000,
      exposure: 'direct',
      description: 'Custom notes'
    }
    await paste(input('mcp-name'), JSON.stringify({ mcpServers: { pasted: config } }))
    assert.equal(writes.length, 0, 'paste never writes')
    assert.equal(input('mcp-name').value, 'pasted')
    assert.ok(input('mcp-command').value.includes('"/two words"'))
    assert.equal(labeled('Value 1').value, '${TOKEN}')
    const before = input('mcp-command').value
    await paste(input('mcp-command'), '{"mcpServers":')
    assert.ok(
      document
        .querySelector('[role="alert"]')
        ?.textContent?.includes('Cannot read the pasted MCP configuration')
    )
    assert.equal(input('mcp-command').value, before)
    await paste(
      input('mcp-command'),
      JSON.stringify({ nameWouldChange: { command: 'bad', args: [42] } })
    )
    assert.equal(
      input('mcp-name').value,
      'pasted',
      'a failed conversion never partially updates the name'
    )
    assert.equal(input('mcp-command').value, before)
    const plain = await paste(input('mcp-command'), 'normal argument')
    assert.equal(plain.defaultPrevented, false)
    await click('Add')
    assert.deepEqual(saved().source, { ...config, type: 'stdio' })

    await mount()
    await fill(input('mcp-name'), 'remote')
    await click('HTTP')
    await fill(input('mcp-url'), 'https://example.com/mcp')
    await click('Add Header name')
    await fill(labeled('Header name 1'), 'X-API-Key')
    await fill(labeled('Value 1'), '!credential $TOKEN')
    await click('Add')
    assert.deepEqual(saved().source, {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-API-Key': '$!credential $$TOKEN' }
    })

    await mount()
    await fill(input('mcp-name'), 'named')
    await paste(
      input('mcp-name'),
      JSON.stringify({
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${TOKEN}' },
        oauth: { scope: 'read' },
        timeout: 9000
      })
    )
    assert.equal(input('mcp-name').value, 'named', 'a bare configuration retains the entered name')
    assert.equal(button('HTTP').getAttribute('data-state'), 'on')
    await click(jsonButton)
    assert.equal(button('JSON').getAttribute('data-state'), 'on')
    assert.equal(button('Form').getAttribute('data-state'), 'off')
    assert.equal(JSON.parse(input('mcp-json').value).oauth.scope, 'read')
    assert.equal(
      (await paste(input('mcp-json'), '{"url":"https://other.com"}')).defaultPrevented,
      false,
      'JSON editor keeps native paste'
    )
    await click('Form')
    assert.equal(labeled('Value 1').value, 'Bearer ${TOKEN}')
    await click('Add')
    assert.equal((saved().source.oauth as { scope: string }).scope, 'read')

    await mount()
    const many = {
      mcpServers: { a: { command: 'npx', args: ['docs'] }, b: { url: 'https://example.com/mcp' } }
    }
    await paste(input('mcp-name'), JSON.stringify(many))
    assert.deepEqual(JSON.parse(input('mcp-json').value), many)
    assert.equal(writes.length, 0)
    await click('Form')
    assert.ok(
      document.querySelector('[role="alert"]')!.textContent?.includes('one server at a time')
    )
    assert.ok(document.getElementById('mcp-json'))
    assert.equal(
      button('JSON').getAttribute('data-state'),
      'on',
      'a failed conversion keeps the previous mode selected'
    )
    assert.equal(button('Form').getAttribute('data-state'), 'off')
    await click('Add')
    assert.deepEqual(saved().source, many)
    assert.equal(closed, 1)

    await mount()
    await paste(input('mcp-name'), JSON.stringify({ existing: { command: 'npx', args: ['docs'] } }))
    await click('Add')
    assert.equal(writes.length, 0, 'same-name paste cannot bypass replacement confirmation')
    assert.equal(closed, 0)
    assert.ok(button('Add').disabled)
    await act(async () => {
      document.querySelector<HTMLButtonElement>('#mcp-replace')!.click()
    })
    await click('Add')
    assert.deepEqual(saved().replaced, ['existing'])

    await mount({
      server: {
        name: 'keep',
        config: {
          command: 'uvx',
          args: ['docs', '/two words'],
          env: { TOKEN: '!old-expression' },
          description: 'Keep notes',
          timeout: 5000
        },
        authenticated: false
      }
    })
    assert.ok(document.getElementById('mcp-json'))
    assert.equal(
      JSON.parse(input('mcp-json').value).command,
      'uvx',
      'existing configuration is not a placeholder'
    )
    assert.equal(input('mcp-name').readOnly, true)
    await click('Form')
    await paste(
      input('mcp-command'),
      JSON.stringify({ renamed: { command: 'npx', args: ['new'], timeout: 6000 } })
    )
    assert.equal(input('mcp-name').value, 'keep')
    await click('Save')
    assert.equal(saved().name, 'keep')
    assert.deepEqual(saved().replaced, ['keep'])
    assert.equal(saved().source.timeout, 6000)

    await mount()
    await click(jsonButton)
    await fill(input('mcp-json'), '{}')
    await click('Add')
    assert.equal(writes.length, 0)
    assert.equal(closed, 0)
    assert.ok(
      document
        .querySelector('[role="alert"]')!
        .textContent?.includes('No server configuration to import')
    )

    const recipe: McpMarketServer = {
      id: 'recipe',
      name: 'recipe',
      title: 'Recipe',
      description: 'Recipe description',
      featured: true,
      icon: 'https://example.com/icon.png',
      config: { url: 'https://example.com/mcp' },
      inputs: [{ key: 'TOKEN', where: 'header', label: 'Token', required: true, secret: true }]
    }
    await mount({ recipe })
    assert.equal(document.getElementById('mcp-name'), null)
    assert.equal(document.querySelector('[data-slot="toggle-group"]'), null)
    assert.equal(button('Add').disabled, true)
    assert.equal(
      (await paste(input('mcp-input-TOKEN'), '{"url":"https://other.com"}')).defaultPrevented,
      false,
      'recipe credential paste is not hijacked'
    )
    await fill(input('mcp-input-TOKEN'), 'token')
    await click('Add')
    assert.equal(saved().icon, recipe.icon)
    assert.equal(saved().name, 'recipe')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--add-mcp-fixture')) {
  await fixture()
} else {
  test('manual MCP sheet supports quoted commands, key/value rows and safe paste without Agent selection', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--add-mcp-fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timer = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }, 14_000)
}
