import { expect, mock, test } from 'bun:test'
import type { SessionCapability, SessionToolProvider } from '../src/shared/session-capabilities'

mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
const { groupPluginTools } = await import('../src/main/pi/session-capabilities')

const tool = (id: string, provider: SessionToolProvider, enabled = true, overridden = false): SessionCapability =>
  ({ id, name: id, provider, enabled, defaultEnabled: true, overridden })

test("Pi's tools stay individual while each plugin becomes one switch over all of its tools", () => {
  const browser = { kind: 'pig', id: 'pig-browser', name: 'Browser' } as const
  const rows = groupPluginTools([
    tool('read', { kind: 'pi' }),
    tool('browser_tabs', browser),
    tool('spawn', { kind: 'pig', id: 'pig-subagent', name: 'Subagents' }),
    tool('browser_open', browser, false, true),
    tool('custom', { kind: 'plugin', id: '/custom/browser.ts', name: 'Browser' })
  ])
  expect(rows.map((row) => [row.id, row.tools])).toEqual([
    ['read', undefined],
    ['plugin:pig:pig-browser', ['browser_tabs', 'browser_open']],
    ['plugin:pig:pig-subagent', ['spawn']],
    ['plugin:plugin:/custom/browser.ts', ['custom']]
  ])
  expect(rows[1]).toMatchObject({ name: 'Browser', provider: browser, enabled: false, defaultEnabled: true, overridden: true })
  expect(rows[2]).toMatchObject({ enabled: true, overridden: false })
})

test('same-named plugins from different sources retain independent group IDs and tool preferences', () => {
  const first = { kind: 'plugin', id: '/one/tools/index.ts', name: 'tools' } as const
  const second = { kind: 'plugin', id: '/two/tools/index.ts', name: 'tools' } as const
  const rows = groupPluginTools([
    tool('one_read', first),
    tool('two_read', second, false, true),
    tool('one_write', first)
  ])
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ id: 'plugin:plugin:/one/tools/index.ts', name: 'tools', tools: ['one_read', 'one_write'], enabled: true, overridden: false })
  expect(rows[1]).toMatchObject({ id: 'plugin:plugin:/two/tools/index.ts', name: 'tools', tools: ['two_read'], enabled: false, overridden: true })
  const renamed = groupPluginTools([tool('one_read', { ...first, name: 'Renamed' })])
  expect(renamed[0]!.id).toBe(rows[0]!.id)
})
