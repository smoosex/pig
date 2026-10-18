/** Shared button surfaces are checked in isolation from renderer module mocks. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture(): Promise<void> {
  const { buttonVariants } = await import('../src/renderer/src/components/ui/button')
  const tokens = (variant: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link') =>
    new Set(buttonVariants({ variant }).split(/\s+/))
  for (const variant of ['outline', 'secondary'] as const) {
    const classes = tokens(variant)
    for (const token of ['bg-glass-button-background', 'border-glass-button-border', 'bg-[image:var(--glass-button-sheen)]', 'shadow-glass-button', 'hover:shadow-glass-button-hover', 'aria-expanded:shadow-glass-button-hover', 'solid:bg-none', 'solid:shadow-none', 'solid:hover:shadow-none', 'solid:aria-expanded:shadow-none', 'text-glass-prompt-foreground', 'hover:bg-glass-button-hover-background', 'aria-expanded:bg-glass-button-hover-background']) {
      assert.ok(classes.has(token), `${variant}: ${token}`)
    }
  }
  assert.ok(tokens('outline').has('solid:bg-background'))
  assert.ok(tokens('outline').has('solid:dark:bg-input/30'))
  assert.ok(tokens('secondary').has('solid:bg-secondary'))
  assert.ok(tokens('default').has('bg-primary'))
  assert.ok(tokens('default').has('bg-clip-border'), 'primary fills its transparent border like the review badge, without a pale rim')
  assert.ok(tokens('default').has('solid:bg-clip-padding'))
  assert.ok(tokens('default').has('text-primary-foreground'))
  assert.ok(tokens('default').has('shadow-glass-primary-button'))
  assert.ok(tokens('default').has('solid:shadow-none'))
  assert.ok(!tokens('default').has('bg-[image:var(--glass-button-sheen)]'), 'primary keeps its semantic fill rather than the neutral sheen')
  for (const variant of ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const) {
    assert.ok(![...tokens(variant)].some((token) => token.includes('backdrop-')), `${variant} must not sample native-material-backed surfaces by default`)
  }
  const { cn } = await import('../src/renderer/src/lib/utils')
  const primary = new Set(cn(buttonVariants({ variant: 'default' })).split(/\s+/))
  assert.ok(primary.has('bg-clip-border'))
  assert.ok(!primary.has('bg-clip-padding'), 'class merging removes the base padding-only clip')
  const ghost = tokens('ghost')
  assert.ok(ghost.has('hover:bg-glass-button-hover-background'))
  assert.ok(ghost.has('aria-[haspopup]:aria-expanded:bg-glass-button-hover-background'), 'only open popup triggers fill; expanded disclosures stay flat')
  assert.ok(![...ghost].some((token) => token.includes('shadow-glass-button') || token.includes('glass-button-sheen')), 'ghost stays flat')
  assert.ok(![...ghost].some((token) => token.startsWith('bg-') && token !== 'bg-clip-padding'), 'ghost stays transparent at rest')
  assert.ok(![...tokens('link')].some((token) => token.includes('blur') || (token.startsWith('bg-') && token !== 'bg-clip-padding')))
}

if (process.argv.includes('--fixture')) await fixture()
else test('buttons share glass surfaces while preserving semantic variants and solid styling', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, output, errors] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
  ])
  assert.equal(code, 0, errors || output)
})
