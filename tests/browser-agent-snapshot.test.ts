/** The outline script runs serialized in an isolated world; this evaluates the serialized source in a DOM. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess.ts'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  const { snapshotPage } = await import('../src/main/browser/agent-snapshot')
  document.body.innerHTML = `
    <header><nav aria-label="Primary"><a href="/docs">Docs</a></nav></header>
    <main>
      <h1>Welcome</h1>
      <p>Click <b>here</b> now. <span>Then <a href="/next">continue</a> later.</span></p>
      <form>
        <label for="email">Email</label><input id="email" value="me@example.com">
        <label>Password <input type="password" value="hunter2"></label>
        <input type="checkbox" aria-label="Remember" checked>
        <select aria-label="Plan"><option>Free</option><option selected>Pro</option></select>
        <button disabled>Sign in</button>
      </form>
      <div style="display:none"><button>Ghost</button></div>
      <div aria-hidden="true">Secret banner</div>
      <img alt="Logo"><img alt="">
      <iframe></iframe>
      <script>ignored()</script>
    </main>`
  // The tool serializes the function; evaluating its source proves it has no module dependencies.
  const run = new Function(`return (${snapshotPage.toString()})(${10_000})`) as () => ReturnType<typeof snapshotPage>
  const page = run()
  const lines = page.text.split('\n')
  const expected = [
    '- banner',
    '  - navigation "Primary"',
    '    - link "Docs" [ref=e1] href="/docs"',
    '- main',
    '  - heading "Welcome" [level=1]',
    '  - text: Click here now.',
    '  - text: Then',
    '  - link "continue" [ref=e2] href="/next"',
    '  - text: later.',
    '  - form',
    '    - text: Email',
    '    - textbox "Email" [ref=e3] value="me@example.com"',
    '    - text: Password',
    '    - textbox "Password" [ref=e4] value=(hidden)',
    '    - checkbox "Remember" [checked] [ref=e5]',
    '    - combobox "Plan" [ref=e6] value="Pro"',
    '    - button "Sign in" [disabled] [ref=e7]',
    '  - img "Logo"',
    '  - iframe (content not included)'
  ]
  assert.deepEqual(lines, expected)
  assert.ok(!page.text.includes('hunter2'), 'password values never leave the page')
  assert.ok(!page.text.includes('Ghost') && !page.text.includes('Secret'), 'hidden content is skipped')
  assert.equal(page.refs, 7)
  assert.equal(page.truncated, false)
  const refs = (globalThis as unknown as { __pigAgentRefs: Map<string, Element> }).__pigAgentRefs
  assert.equal(refs.get('e3'), document.getElementById('email'), 'refs resolve to the outlined elements')

  document.body.innerHTML = '<p>Before <span>Shown <b>bold</b><span hidden>SECRET</span><span aria-hidden="true">ARIA_SECRET</span><span style="display:none">CSS_SECRET</span><script>code()</script><style>style()</style></span> after.</p>'
  const filtered = run()
  assert.equal(filtered.text, '- text: Before Shown bold after.', 'inline descendants use the same hidden and script filters without breaking sentences')

  document.body.innerHTML = '<input type="file" aria-label="Visible upload" multiple accept="image/*"><div hidden><span id="secret-label">HIDDEN_SECRET</span><input type="file" aria-label="Hidden upload" aria-labelledby="secret-label"></div><div role="button" id="upload-host">Custom upload</div>'
  const fileInput = document.querySelector('input')!
  Object.defineProperty(fileInput, 'value', { value: 'C:\\fakepath\\SECRET_FILE.txt' })
  const shadow = document.getElementById('upload-host')!.attachShadow({ mode: 'open' })
  shadow.innerHTML = '<input type="file" style="display:none" aria-label="Shadow upload">'
  const uploadPage = run()
  assert.ok(uploadPage.text.includes('button "Visible upload" [ref=e1] [type=file] [multiple] [accept="image/*"]'))
  assert.ok(uploadPage.text.includes('"Hidden upload"') && uploadPage.text.includes('[upload-only]'))
  assert.ok(uploadPage.text.includes('"Shadow upload"'))
  assert.ok(!uploadPage.text.includes('SECRET'), 'file values and unrelated hidden content stay out of upload metadata')
  const uploadRefs = (globalThis as unknown as { __pigAgentRefs: Map<string, Element> }).__pigAgentRefs
  assert.ok([...uploadRefs.values()].includes(shadow.querySelector('input')!))

  document.body.innerHTML = '<div tabindex="0">Focusable menu</div><span onclick="void 0">Inline action</span><div id="handler">Assigned action</div><div role="menuitem">Menu item</div><div role="button">Parent<span>label</span><button>Nested action</button></div><div hidden tabindex="0">Hidden action</div>'
  ;(document.getElementById('handler') as HTMLElement).onclick = () => {}
  const custom = run()
  assert.match(custom.text, /interactive "Focusable menu" \[ref=e1\]/)
  assert.match(custom.text, /interactive "Inline action" \[ref=e2\]/)
  assert.match(custom.text, /interactive "Assigned action" \[ref=e3\]/)
  assert.match(custom.text, /menuitem "Menu item" \[ref=e4\]/)
  assert.match(custom.text, /button "Nested action" \[ref=e6\]/)
  assert.ok(!custom.text.includes('text: label') && !custom.text.includes('Hidden action'))

  document.body.innerHTML = '<p>' + 'visible text '.repeat(100) + '</p>'
  const small = snapshotPage(120)
  assert.equal(small.truncated, true)
  assert.ok(small.text.length <= 160)
  assert.ok(!(globalThis as unknown as { __pigAgentRefs: Map<string, Element> }).__pigAgentRefs.has('e7'), 'a new snapshot replaces old refs')
  await GlobalRegistrator.unregister()
}

if (process.argv[2] === '--snapshot-fixture') {
  await fixture()
} else {
  test('browser agent snapshot outlines roles, names, values and refs without hidden or secret content', async () => {
    const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--snapshot-fixture'])
    assert.equal(code, 0, stderr || stdout)
  })
}
