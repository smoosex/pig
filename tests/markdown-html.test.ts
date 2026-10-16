/** Files may lay themselves out with HTML; chat output never renders it, and neither lets scripts through. */
import { expect, test } from 'bun:test'

const readme = [
  '<p align="center"><img src="logo.png" width="80" onerror="alert(1)"></p>',
  '',
  '<details><summary>More</summary>',
  '',
  'hidden <b>bold</b>',
  '',
  '</details>',
  '',
  '<script>alert(1)</script><iframe src="https://x.test"></iframe>',
  '<a href="javascript:alert(1)" style="color:red">bad</a>',
  '',
  'Inline $x^2$ math',
  '',
  '![dot](data:image/png;base64,AA==) <img src="data:image/gif;base64,R0=="> <img src="data:text/html,x">',
  '',
  'Note[^1]',
  '',
  '[^1]: The footnote.'
].join('\n')

async function runFixture(): Promise<void> {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  // The renderer module graph is shared per process, so it is loaded only inside this child.
  const { MarkdownText } = await import('../src/renderer/src/components/MarkdownText')
  const html = renderToStaticMarkup(createElement(MarkdownText, { text: readme, allowHtml: true }))
  expect(html).toContain('<p class="mb-2 whitespace-pre-wrap last:mb-0 text-center"><img src="logo.png" width="80"')
  expect(html).toContain('<details><summary>More</summary>')
  expect(html).toContain('<b>bold</b>')
  for (const unsafe of ['<script', 'alert(1)', '<iframe', 'onerror', 'javascript:', 'color:red']) expect(html).not.toContain(unsafe)
  expect(html).toContain('class="katex"')
  expect(html).toContain('src="data:image/png;base64,AA=="')
  expect(html).toContain('src="data:image/gif;base64,R0=="')
  expect(html).not.toContain('data:text/html')
  // Footnote links point at sanitized ids, which the preview's anchor handler looks up by id.
  expect(html).toContain('href="#fn-1"')
  expect(html).toContain('id="user-content-fn-1"')
  expect(html).toContain('id="user-content-fnref-1"')
  expect(html).not.toContain('user-content-user-content-')
  const chat = renderToStaticMarkup(createElement(MarkdownText, { text: 'hi <b>bold</b>' }))
  expect(chat).toContain('&lt;b&gt;bold&lt;/b&gt;')
}

if (process.argv[2] === '--markdown-html-fixture') {
  await runFixture()
} else {
  test('a file preview renders sanitized HTML while chat markdown still shows it as text', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--markdown-html-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stdout + stderr).toBe(0)
  })
}
