import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useResizeSettle } = await import('../src/renderer/src/hooks/useResizeSettle')

  let currentSettling = false
  let triggerEnd: () => void = () => {}

  function TestComponent() {
    const { settling, handleAnimationEnd } = useResizeSettle(50)
    currentSettling = settling
    return h('div', {
      'data-settling': String(settling),
      onAnimationEnd: handleAnimationEnd,
      ref: (el) => {
        if (el) {
          triggerEnd = () => {
            const ev = new Event('animationend', { bubbles: true })
            Object.defineProperty(ev, 'currentTarget', { value: el })
            Object.defineProperty(ev, 'target', { value: el })
            el.dispatchEvent(ev)
          }
        }
      }
    })
  }

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(h(TestComponent))
    })

    assert.equal(currentSettling, false, 'initially not settling')

    // Simulate window resize
    await act(async () => {
      window.innerWidth = 1000
      window.innerHeight = 800
      window.dispatchEvent(new Event('resize'))
    })

    assert.equal(currentSettling, false, 'not settling immediately during resize')

    // Wait for debounce
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80))
    })

    assert.equal(currentSettling, true, 'settling after debounce expires')

    // Trigger animation end on current target
    await act(async () => {
      triggerEnd()
    })

    assert.equal(currentSettling, false, 'resets after animation ends')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else
  test('useResizeSettle triggers settling on resize and resets after animation end', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timer = setTimeout(() => child.kill(), 6000)
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, err || out)
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }, 8000)
