/** The composer's background process button: hidden when empty, one popover for all, stop and remove. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { BackgroundProcessInfo, BackgroundProcessUpdate } from '../src/shared/processes'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  const errors: string[] = []
  mock.module('sonner', () => ({ toast: { error: (message: string) => errors.push(message) } }))
  let push: ((update: BackgroundProcessUpdate) => void) | undefined
  const calls: string[][] = []
  window.api = {
    processes: {
      list: async () => [],
      stop: async (sessionId: string, id: string) => { calls.push(['stop', sessionId, id]) },
      remove: async (sessionId: string, id: string) => { calls.push(['remove', sessionId, id]); throw new Error('nope') },
      onChanged: (listener: typeof push) => { push = listener; return () => {} }
    }
  } as unknown as typeof window.api
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ locale: 'en' })
  const { ProcessStatus } = await import('../src/renderer/src/components/composer/ProcessStatus')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(TooltipProvider, null, React.createElement(ProcessStatus, { sessionId: 'one' }))))
  const button = () => document.querySelector<HTMLButtonElement>('[data-process-status]')
  assert.equal(button(), null, 'no processes, no button')

  const item = (id: string, status: BackgroundProcessInfo['status'], extra: Partial<BackgroundProcessInfo> = {}): BackgroundProcessInfo => ({
    id, command: `cmd ${id}`, cwd: '/repo', pid: 1, status, startedAt: 0, exitCode: null, signal: null, output: [], ...extra
  })
  await act(async () => push!({ sessionId: 'two', processes: [item('proc-9', 'running')] }))
  assert.equal(button(), null, 'another session does not show here')
  await act(async () => push!({ sessionId: 'one', processes: [
    item('proc-1', 'running', { name: 'dev server', output: ['ready'] }),
    item('proc-2', 'failed', { endedAt: 3000, exitCode: 2 })
  ] }))
  assert.equal(button()?.dataset.running, 'true')
  assert.equal(button()?.getAttribute('aria-label'), 'Background processes: Running x 1 | Failed x 1')
  assert.ok(document.querySelector('[data-process-problem]'))

  await act(async () => { button()!.click() })
  const rows = [...document.querySelectorAll<HTMLElement>('[data-process-row]')]
  assert.deepEqual(rows.map((row) => row.dataset.processRow), ['proc-1', 'proc-2'])
  assert.match(rows[0]!.textContent!, /dev server/)
  assert.match(rows[1]!.textContent!, /proc-2 · Failed · 3s · Exit code 2/)
  await act(async () => { rows[0]!.querySelector<HTMLButtonElement>('[aria-label="Show output"]')!.click() })
  assert.equal(rows[0]!.querySelector('pre')?.textContent, 'ready')
  await act(async () => { rows[0]!.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!.click() })
  await act(async () => { rows[1]!.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!.click() })
  assert.deepEqual(calls, [['stop', 'one', 'proc-1'], ['remove', 'one', 'proc-2']])
  assert.deepEqual(errors, ['Background process action failed'])

  await act(async () => push!({ sessionId: 'one', processes: [] }))
  assert.equal(button(), null, 'clearing every record hides the button')
  await act(async () => root.unmount())
}

if (process.argv.includes('--process-status-fixture')) await fixture()
else test('the background process button mirrors its session and stops or removes rows', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--process-status-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, err || out)
}, 15_000)
