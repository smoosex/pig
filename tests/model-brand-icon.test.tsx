import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionModelInfo } from '../src/shared/api'
import { ModelBrandIcon } from '../src/renderer/src/components/composer/ModelBrandIcon'

function model(provider: string): SessionModelInfo {
  return {
    provider,
    providerName: provider,
    id: 'model',
    name: 'Model',
    contextWindow: 1,
    reasoning: false
  }
}

test('the selected composer model uses a monochrome provider icon', () => {
  const anthropic = renderToStaticMarkup(<ModelBrandIcon model={model('anthropic')} />)
  expect(anthropic).toContain('data-brand="anthropic"')
  expect(anthropic).toContain('fill="currentColor"')

  const vertex = renderToStaticMarkup(<ModelBrandIcon model={model('google-vertex')} />)
  expect(vertex).toContain('data-brand="googlecloud"')
})

test('an unknown provider retains the generic model icon', () => {
  const markup = renderToStaticMarkup(<ModelBrandIcon model={model('private-provider')} />)
  expect(markup).not.toContain('data-brand=')
  expect(markup).toContain('lucide-cpu-ai')
})
