/** The outline script runs serialized in an isolated world; this evaluates the serialized source in a DOM. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

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
    const child = Bun.spawn([process.execPath, import.meta.path, '--snapshot-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, stderr || stdout)
  })
}
