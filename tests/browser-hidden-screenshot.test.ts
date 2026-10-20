/** Hidden screenshots own only their temporary CDP connection, including concurrent calls and failures. */
import { expect, test } from 'bun:test'
import type { WebContents } from 'electron'
import { captureHiddenPage } from '../src/main/browser/hidden-screenshot'

function fixture(attached = false) {
  const events: string[] = []
  let command = async () => ({ data: 'PNG' })
  const contents = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => { events.push('attach'); attached = true },
      detach: () => { events.push('detach'); attached = false },
      sendCommand: () => { events.push('capture'); return command() }
    }
  } as unknown as WebContents
  return { contents, events, command: (next: typeof command) => { command = next } }
}

test('hidden screenshots leave existing debugger connections attached', async () => {
  const f = fixture(true)
  expect(await captureHiddenPage(f.contents)).toBe('PNG')
  expect(f.events).toEqual(['capture'])
})

test('concurrent screenshots serialize temporary attachment and release on failure', async () => {
  const f = fixture()
  let finish!: (result: { data: string }) => void
  f.command(() => new Promise((resolve) => { finish = resolve }))
  const first = captureHiddenPage(f.contents)
  const second = captureHiddenPage(f.contents)
  expect(f.events).toEqual(['attach', 'capture'])
  f.command(async () => { throw new Error('capture failed') })
  finish({ data: 'FIRST' })
  expect(await first).toBe('FIRST')
  await expect(second).rejects.toThrow('capture failed')
  expect(f.events).toEqual(['attach', 'capture', 'detach', 'attach', 'capture', 'detach'])
  f.command(async () => ({ data: 'NEXT' }))
  expect(await captureHiddenPage(f.contents)).toBe('NEXT')
  f.command(async () => ({ data: '' }))
  await expect(captureHiddenPage(f.contents)).rejects.toThrow('empty')
  expect(f.events.at(-1)).toBe('detach')
})
