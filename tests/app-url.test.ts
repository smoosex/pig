import { expect, test } from 'bun:test'
import { createAppUrlCheck, installNavigationGuard } from '../src/main/app-url'

const rendererHtml = '/Applications/Pig.app/Contents/Resources/app.asar/out/renderer/index.html'
const fileUrl = 'file:///Applications/Pig.app/Contents/Resources/app.asar/out/renderer/index.html'

test('packaged builds only accept the bundled renderer entry', () => {
  const isAppUrl = createAppUrlCheck({ rendererHtml })
  expect(isAppUrl(fileUrl)).toBe(true)
  expect(isAppUrl('file:///etc/passwd')).toBe(false)
  expect(isAppUrl('file:///Applications/Pig.app/Contents/Resources/app.asar/out/renderer/other.html')).toBe(false)
  // The scheme that serves session images is an origin of its own, and its payloads are data.
  expect(isAppUrl('pig-image://session/session-1/entry-1/0')).toBe(false)
  expect(isAppUrl('https://example.com')).toBe(false)
  expect(isAppUrl('not a url')).toBe(false)
})

test('dev builds accept the dev server origin and nothing else', () => {
  const isAppUrl = createAppUrlCheck({
    devServer: 'http://localhost:5173',
    rendererHtml
  })
  expect(isAppUrl('http://localhost:5173/')).toBe(true)
  expect(isAppUrl('http://localhost:5173/index.html?hot=1')).toBe(true)
  expect(isAppUrl('http://localhost:51730/')).toBe(false)
  expect(isAppUrl('http://localhost.evil.com:5173/')).toBe(false)
  expect(isAppUrl('https://localhost:5173/')).toBe(false)
  // The bundled entry stays the app in dev too, so it is always accepted.
  expect(isAppUrl(fileUrl)).toBe(true)
  expect(isAppUrl('file:///etc/passwd')).toBe(false)
  expect(isAppUrl('pig-image://session/session-1/entry-1/0')).toBe(false)
})

test('the guard blocks every navigation and redirect outside the app', () => {
  const handlers = new Map<string, (event: { preventDefault: () => void }, url: string) => void>()
  const webContents = {
    on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault: () => void }, url: string) => void) {
      handlers.set(event, listener)
    }
  }
  const isAppUrl = createAppUrlCheck({ rendererHtml })
  installNavigationGuard(webContents, isAppUrl)
  expect([...handlers.keys()]).toEqual(['will-navigate', 'will-redirect'])

  for (const handler of handlers.values()) {
    let blocked = 0
    const event = { preventDefault: () => { blocked++ } }
    handler(event, 'pig-image://session/session-1/entry-1/0')
    handler(event, 'https://example.com')
    expect(blocked).toBe(2)
    handler(event, fileUrl)
    expect(blocked).toBe(2)
  }
})
