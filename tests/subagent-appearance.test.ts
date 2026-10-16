import { expect, test } from 'bun:test'
import { chooseSubagentAppearance } from '../src/main/subagents/appearance'
import { SUBAGENT_ANIMALS, type SubagentAppearance } from '../src/shared/subagent-appearance'
import type { SubagentInfo } from '../src/shared/api'

async function avatarFixture(): Promise<void> {
  Object.assign(globalThis, { window: { api: {} } })
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { subagentAppearance, subagentColor } = await import('../src/renderer/src/stores/subagents')
  const { SubagentAvatar } = await import('../src/renderer/src/components/subagents/subagent-view')
  const item = { id: 'legacy-child', status: 'completed', appearance: { animal: 'panda', color: 3 } } as SubagentInfo
  const html = renderToStaticMarkup(createElement(SubagentAvatar, { item, className: 'size-4' }))
  expect(html).toContain('lucide-panda')
  expect(html).toContain('text-chart-3')
  expect(html).toContain('right-0 bottom-0 rounded-full p-px size-2')
  expect(html).toContain('lucide-check')
  expect(html).toContain('bg-subagent-completed-background')
  expect(html).toContain('text-subagent-completed-foreground')
  expect(html).not.toContain('ring-')
  for (const statusSize of [6, 8] as const) {
    for (const status of ['running', 'queued', 'completed', 'aborted', 'failed', 'timeout', 'turn_limit', 'interrupted'] as const) {
      const avatar = renderToStaticMarkup(createElement(SubagentAvatar, { item: { ...item, status }, statusSize }))
      expect(avatar).toContain(`right-0 bottom-0 rounded-full p-px ${statusSize === 6 ? 'size-1.5' : 'size-2'}`)
      if (status === 'aborted') {
        expect(avatar).toContain('lucide-circle-stop')
        expect(avatar).not.toContain('fill-current')
      }
      if (['failed', 'timeout', 'turn_limit', 'interrupted'].includes(status)) {
        expect(avatar).toContain('bg-subagent-failed-background text-subagent-failed-foreground')
        expect(avatar).toContain('lucide-x')
      }
    }
  }
  const wrapper = html.slice(0, html.indexOf('>'))
  expect(wrapper).toContain('size-4')
  expect(wrapper).not.toContain('bg-')
  expect(wrapper).not.toContain('rounded-full')
  expect(subagentColor(item)).toBe('bg-chart-3')
  const legacy = { id: 'legacy-child' } as SubagentInfo
  expect(subagentAppearance(legacy)).toEqual(subagentAppearance({ ...legacy }))
  expect(SUBAGENT_ANIMALS).toContain(subagentAppearance(legacy).animal)
}

if (process.argv.includes('--fixture')) await avatarFixture()
else {
  test('completion markers keep white checks with at least 3:1 contrast in both themes and schemes', async () => {
    const luminance = (hex: string) => [1, 3, 5].map((offset) => {
      const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
    for (const palette of ['pig', 'everforest']) {
      const css = await Bun.file(new URL(`../src/renderer/src/themes/theme-${palette}.css`, import.meta.url)).text()
      const blocks = [...css.matchAll(/(html[^{}]+)\{([^{}]+)\}/g)]
      expect(blocks.length).toBe(2)
      for (const [, selector, body] of blocks) {
        const background = body.match(/--subagent-completed-background:\s*(#[\da-f]{6});/)?.[1]
        const foreground = body.match(/--subagent-completed-foreground:\s*(#[\da-f]{6});/)?.[1]
        expect(background).toMatch(/^#[\da-f]{6}$/)
        expect(foreground).toBe('#ffffff')
        const contrast = (luminance(foreground!) + 0.05) / (luminance(background!) + 0.05)
        expect(contrast, `${palette}: ${selector}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  test('animals do not repeat before exhaustion and colors remain balanced', () => {
    const used: SubagentAppearance[] = []
    for (let i = 0; i < 36; i++) {
      const appearance = chooseSubagentAppearance(used)
      if (i < SUBAGENT_ANIMALS.length) expect(used.some((item) => item.animal === appearance.animal)).toBe(false)
      if (i < 7) expect(used.some((item) => item.color === appearance.color)).toBe(false)
      used.push(appearance)
    }
    for (const animal of SUBAGENT_ANIMALS) expect(used.filter((item) => item.animal === animal).length).toBe(3)
  })

  test('animal avatars use theme-colored strokes without a background and inset status marks', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect({ code, output: err || out }).toEqual({ code: 0, output: '' })
    } finally {
      clearTimeout(timer)
    }
  }, 15_000)
}
