/** Synthetic files and child-isolated DOM/CDP exercise upload boundaries without Electron or user data. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { uploadBrowserFiles } from '../src/main/browser/agent-upload'
import { withBrowserDebugger } from '../src/main/browser/browser-debugger'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'https://example.test' })
  const directory = await mkdtemp(join(tmpdir(), 'pig-upload-test-'))
  try {
    const file = join(directory, 'explicit.txt')
    const other = join(directory, 'other.txt')
    const link = join(directory, 'link.txt')
    await writeFile(file, 'synthetic')
    await writeFile(other, 'synthetic second')
    await symlink(file, link)
    const canonical = await realpath(file)
    const refs = new Map<string, Element>()
    Object.assign(globalThis, { __pigAgentRefs: refs })
    const nodes = new Map<number, Node>()
    let nextId = 1
    const idFor = (node: Node) => {
      for (const [id, value] of nodes) if (value === node) return id
      const id = nextId++
      nodes.set(id, node)
      return id
    }
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const scripts: string[] = []
    let attached = false, attaches = 0, detaches = 0, checks = 0
    let current = true
    let hook: ((method: string) => Promise<void> | void) | undefined
    let scriptHook: (() => Promise<void>) | undefined
    let overrideNode: Record<string, unknown> | undefined
    const contents = {
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: async (world: number, source: { code: string }[]) => {
        assert.equal(world, 1207)
        scripts.push(source[0].code)
        await scriptHook?.()
        try { return await new Function(`return ${source[0].code}`)() }
        catch { throw new Error('Generic Electron script failure') }
      },
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; attaches++ },
        detach: () => { attached = false; detaches++ },
        sendCommand: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          await hook?.(method)
          if (method === 'DOM.getDocument') return { root: { backendNodeId: idFor(document) } }
          if (method === 'DOM.describeNode') {
            assert.deepEqual([params.depth, params.pierce], [1, true])
            const target = nodes.get(params.backendNodeId as number)!
            const element = target as Element
            // Like CDP: children include text nodes; shadow roots are listed separately.
            const node = {
              backendNodeId: idFor(target), nodeType: target.nodeType, nodeName: target.nodeName, localName: element.localName ?? '',
              attributes: element.attributes ? Array.from(element.attributes).flatMap(attribute => [attribute.name, attribute.value]) : undefined,
              children: Array.from(target.childNodes).map(child => ({ backendNodeId: idFor(child), nodeType: child.nodeType, nodeName: child.nodeName, localName: (child as Element).localName ?? '' })),
              shadowRoots: element.shadowRoot ? [{ backendNodeId: idFor(element.shadowRoot), shadowRootType: 'open' }] : []
            }
            return { node: overrideNode && element.localName === 'input' ? overrideNode : node }
          }
          if (method === 'DOM.setFileInputFiles') return {}
          throw new Error(`Unexpected command ${method}`)
        }
      }
    } as unknown as WebContents
    const guard = () => { checks++; if (!current) throw new Error('document/control changed') }
    const run = (files: readonly string[] = [file], ref = 'e1', signal?: AbortSignal) => uploadBrowserFiles(contents, ref, files, signal, guard)
    const reset = (markup = '<input type="file" hidden style="display:none">') => {
      document.body.innerHTML = markup
      refs.clear()
      const input = document.querySelector('input') as HTMLInputElement
      if (input) refs.set('e1', input)
      calls.length = 0
      scripts.length = 0
      hook = undefined
      scriptHook = undefined
      overrideNode = undefined
      current = true
      return input
    }
    reset()
    assert.equal(await run([link]), undefined)
    assert.deepEqual(calls.at(-1), { method: 'DOM.setFileInputFiles', params: { backendNodeId: idFor(refs.get('e1')!), files: [canonical] } })
    assert.equal(scripts.length, 2)
    assert.equal(scripts.some(code => code.includes(directory)), false, 'paths never enter page code')
    assert.equal(document.querySelector('input')!.attributes.length, 3, 'no marker attributes')
    assert.equal(checks > 12, true)
    assert.equal(attaches, detaches)
    for (const files of [[], Array(21).fill(file), ['relative.txt'], [directory], [join(directory, 'missing')]]) {
      reset()
      await assert.rejects(run(files))
      assert.equal(calls.length, 0)
    }
    for (const [markup, error] of [
      ['<input>', /input\[type=file\]/],
      ['<input type="file" disabled>', /disabled/],
      ['<fieldset disabled><input type="file"></fieldset>', /disabled/],
      ['<input type="file" webkitdirectory>', /Directory/],
      ['<input type="file" aria-disabled="true">', /disabled/]
    ] as const) {
      const input = reset(markup)
      if (markup.startsWith('<fieldset')) {
        // HappyDOM does not implement inherited fieldset :disabled; Chromium does.
        const matches = input.matches.bind(input)
        Object.defineProperty(input, 'matches', { value: (selector: string) => selector === ':disabled' || matches(selector) })
      }
      await assert.rejects(run(), error)
      assert.equal(calls.length, 0, 'structured validation fails before CDP lookup')
    }
    reset()
    await assert.rejects(run([file, other]), /exactly one/)
    reset('<input type="file" multiple>')
    await run(Array(20).fill(file))
    assert.equal((calls.at(-1)!.params.files as string[]).length, 20)
    reset()
    await assert.rejects(run([file], 'missing'), /stale/)
    const foreign = document.implementation.createHTMLDocument('foreign frame')
    foreign.body.innerHTML = '<input type="file">'
    refs.set('e1', foreign.querySelector('input')!)
    await assert.rejects(run(), /stale/)

    reset('<section></section>')
    const shadow = document.querySelector('section')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<div></div><div><input type="file"></div>'
    const nested = shadow.querySelector('div')!.attachShadow({ mode: 'open' })
    nested.innerHTML = '<input type="file">'
    refs.set('e1', nested.querySelector('input')!)
    await run()
    assert.equal(calls.at(-1)!.params.backendNodeId, idFor(refs.get('e1')!), 'nested open shadow roots resolve to the ref')
    // A deeper same-shape input earlier in tree order must not win over the ref (selector matching would pick it).
    reset('<section></section>')
    const decoy = document.querySelector('section')!.attachShadow({ mode: 'open' })
    decoy.innerHTML = 'text <span><div><input type="file"></div></span> <div><input type="file"></div>'
    refs.set('e1', decoy.children[1]!.querySelector('input')!)
    await run()
    assert.equal(calls.at(-1)!.params.backendNodeId, idFor(refs.get('e1')!), 'exact child positions bind the original input')
    reset('<section></section>')
    const closed = document.querySelector('section')!.attachShadow({ mode: 'closed' })
    closed.innerHTML = '<input type="file">'
    refs.set('e1', closed.querySelector('input')!)
    await assert.rejects(run(), /open shadow/)

    for (const mutation of ['replacement', 'move', 'reorder', 'disabled', 'directory', 'type'] as const) {
      const input = reset('<div><input type="file"></div><div></div>')
      hook = method => {
        if (method !== 'DOM.describeNode') return
        if (mutation === 'replacement') input.replaceWith(input.cloneNode())
        if (mutation === 'move') document.querySelectorAll('div')[1].append(input)
        if (mutation === 'reorder') input.before(document.createElement('input'))
        if (mutation === 'disabled') input.disabled = true
        if (mutation === 'directory') input.setAttribute('webkitdirectory', '')
        if (mutation === 'type') input.type = 'text'
      }
      await assert.rejects(run(), /stale|moved|no longer exists|disabled|Directory|input\[type=file\]/)
      assert.equal(calls.some(call => call.method === 'DOM.setFileInputFiles'), false)
    }
    reset()
    overrideNode = { backendNodeId: -1, nodeType: 1, nodeName: 'BUTTON', localName: 'input', attributes: ['type', 'file'] }
    await assert.rejects(run(), /CDP target/)
    reset()
    hook = method => { if (method === 'DOM.describeNode') throw new Error('CDP failed') }
    await assert.rejects(run(), /CDP failed/)
    reset()
    hook = method => { if (method === 'DOM.describeNode') current = false }
    await assert.rejects(run(), /document\/control changed/)
    assert.equal(calls.some(call => call.method === 'DOM.setFileInputFiles'), false)
    reset()
    attached = true
    const previousDetaches = detaches
    await run()
    assert.equal(attached, true)
    assert.equal(detaches, previousDetaches, 'existing debugger ownership is preserved')
    attached = false

    // Cancel at each asynchronous page/CDP stage; late resolve/reject cannot release ownership early.
    for (const stage of ['script', 'DOM.getDocument', 'DOM.describeNode', 'DOM.setFileInputFiles']) {
      for (const lateReject of [false, true]) {
        reset()
        const controller = new AbortController()
        let enter!: () => void, finish!: () => void, fail!: (error: Error) => void
        const entered = new Promise<void>(resolve => { enter = resolve })
        const pending = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
        let paused = false
        const pause = async () => { if (!paused) { paused = true; enter(); await pending } }
        if (stage === 'script') scriptHook = pause
        else hook = method => method === stage ? pause() : undefined
        const uploading = run([file], 'e1', controller.signal)
        await entered
        controller.abort(new Error('upload stopped'))
        await assert.rejects(uploading, /upload stopped/)
        let nextRan = false
        const next = withBrowserDebugger(contents, async () => { nextRan = true })
        await Promise.resolve()
        assert.equal(nextRan, false, 'cancelled underlying work still owns the queue')
        assert.equal(attached, true)
        const commandsAtAbort = calls.length
        if (lateReject) fail(new Error('late underlying failure'))
        else finish()
        await next
        assert.equal(calls.length, commandsAtAbort, 'no new CDP input after cancellation')
        assert.equal(attached, false)
      }
    }
    reset()
    const aborted = new AbortController()
    aborted.abort(new Error('already stopped'))
    await assert.rejects(run([file], 'e1', aborted.signal), /already stopped/)
    assert.equal(calls.length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--upload-fixture')) await fixture()
else test('browser uploads validate explicit files, original refs, shadow paths and cancellation ownership', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--upload-fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, stderr || stdout)
})
