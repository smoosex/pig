/**
 * GUI workflow for custom providers and models in Settings -> Providers:
 * corrupt-file lock + reload, creating a provider with `/models` discovery, adding a model manually,
 * and confirming provider deletion.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type {
  CustomModelInput,
  CustomModelsState,
  CustomProviderInput,
  DiscoveredRemoteModel,
  DiscoverModelsInput
} from '../src/shared/custom-models'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

  let state: CustomModelsState = {
    providers: [],
    error: 'Failed to parse models.json: Unexpected token',
    runtimeError: null
  }
  const savedProviders: CustomProviderInput[] = []
  const savedModels: Array<{ providerId: string; model: CustomModelInput | CustomModelInput[] }> = []
  const removedProviders: string[] = []
  const discoveryInputs: DiscoverModelsInput[] = []

  window.api = {
    supportsGlass: false,
    onSettingsChanged: () => () => {},
    onSettingsSurface: () => () => {},
    getCustomModels: async () => state,
    discoverCustomModels: async (input: DiscoverModelsInput): Promise<DiscoveredRemoteModel[]> => {
      discoveryInputs.push(input)
      return [
        {
          id: 'qwen3-coder:32b',
          name: 'Qwen3 Coder 32B',
          contextWindow: 131072,
          maxTokens: 32768,
          reasoning: true
        }
      ]
    },
    saveCustomProvider: async (input: CustomProviderInput): Promise<CustomModelsState> => {
      savedProviders.push(input)
      state = {
        providers: [
          {
            id: input.id,
            name: input.name ?? input.id,
            api: input.api,
            baseUrl: input.baseUrl,
            authMode: input.authMode,
            hasSavedKey: input.authMode === 'api_key',
            authHeader: input.authHeader,
            headers: [],
            configured: true,
            models: (input.models ?? []).map((m) => ({
              id: m.id,
              name: m.name ?? m.id,
              reasoning: m.reasoning,
              vision: m.vision,
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens
            }))
          }
        ],
        error: null,
        runtimeError: null
      }
      return state
    },
    saveCustomModel: async (
      providerId: string,
      model: CustomModelInput | CustomModelInput[]
    ): Promise<CustomModelsState> => {
      savedModels.push({ providerId, model })
      const items = Array.isArray(model) ? model : [model]
      state = {
        ...state,
        providers: state.providers.map((p) =>
          p.id !== providerId
            ? p
            : {
                ...p,
                models: [
                  ...p.models,
                  ...items.map((m) => ({
                    id: m.id,
                    name: m.name ?? m.id,
                    reasoning: m.reasoning,
                    vision: m.vision,
                    contextWindow: m.contextWindow,
                    maxTokens: m.maxTokens
                  }))
                ]
              }
        )
      }
      return state
    },
    removeCustomProvider: async (providerId: string): Promise<CustomModelsState> => {
      removedProviders.push(providerId)
      state = {
        ...state,
        providers: state.providers.filter((p) => p.id !== providerId)
      }
      return state
    },
    removeCustomModel: async () => state
  } as unknown as typeof window.api

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ locale: 'en' })
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { CustomProvidersSection } = await import(
    '../src/renderer/src/components/settings/CustomProvidersSection'
  )

  const setInputValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  }

  const findButtonByText = (label: string, scope: ParentNode = document): HTMLButtonElement => {
    const match = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === label
    )
    assert.ok(match, `expected button "${label}"`)
    return match
  }

  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  await act(async () => {
    root.render(React.createElement(TooltipProvider, null, React.createElement(CustomProvidersSection)))
  })

  // 1. Corrupt models.json blocks add button until reloaded cleanly.
  assert.match(host.textContent ?? '', /Failed to parse models\.json/)
  assert.equal(findButtonByText('Add custom provider', host).disabled, true)

  state = { providers: [], error: null, runtimeError: null }
  await act(async () => {
    findButtonByText('Reload', host).click()
  })
  assert.equal(findButtonByText('Add custom provider', host).disabled, false)

  // 2. Open Add custom provider dialog, switch to keyless local mode, fetch /models, and save.
  await act(async () => {
    findButtonByText('Add custom provider', host).click()
  })

  const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
  assert.ok(dialog, 'custom provider dialog opened')

  await act(async () => {
    setInputValue(dialog.querySelector<HTMLInputElement>('#custom-provider-id')!, 'ollama')
    setInputValue(dialog.querySelector<HTMLInputElement>('#custom-provider-name')!, 'Local Ollama')
    setInputValue(dialog.querySelector<HTMLInputElement>('#custom-provider-url')!, 'http://localhost:11434/v1')
    findButtonByText('No key', dialog).click()
  })

  await act(async () => {
    findButtonByText('Fetch from endpoint', dialog).click()
  })
  assert.equal(discoveryInputs.length, 1)
  assert.equal(discoveryInputs[0]!.baseUrl, 'http://localhost:11434/v1')

  const modelCheckbox = dialog.querySelector<HTMLButtonElement>('[data-slot="checkbox"]')
  assert.ok(modelCheckbox, 'discovered model checkbox rendered')
  await act(async () => {
    modelCheckbox.click()
  })

  await act(async () => {
    findButtonByText('Save', dialog).click()
  })

  assert.equal(savedProviders.length, 1)
  assert.equal(savedProviders[0]!.id, 'ollama')
  assert.equal(savedProviders[0]!.authMode, 'none')
  assert.equal(savedProviders[0]!.models?.length, 1)
  assert.equal(savedProviders[0]!.models?.[0]?.id, 'qwen3-coder:32b')
  assert.match(host.textContent ?? '', /Local Ollama/)
  assert.match(host.textContent ?? '', /Qwen3 Coder 32B/)

  // 3. Add a manual model via CustomModelDialog.
  await act(async () => {
    findButtonByText('Add model', host).click()
  })
  const modelDialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
  assert.ok(modelDialog, 'custom model dialog opened')

  await act(async () => {
    setInputValue(modelDialog.querySelector<HTMLInputElement>('#custom-model-id')!, 'deepseek-r1:14b')
    modelDialog.querySelector<HTMLButtonElement>('#custom-model-reasoning')!.click()
  })
  await act(async () => {
    findButtonByText('Save', modelDialog).click()
  })
  assert.equal(savedModels.length, 1)
  assert.equal((savedModels[0]!.model as CustomModelInput).id, 'deepseek-r1:14b')
  assert.equal((savedModels[0]!.model as CustomModelInput).reasoning, true)
  assert.match(host.textContent ?? '', /deepseek-r1:14b/)

  // 4. Delete provider through confirmation AlertDialog.
  const deleteBtn = host.querySelector<HTMLButtonElement>('[aria-label="Delete provider Local Ollama"]')
  assert.ok(deleteBtn)
  await act(async () => {
    deleteBtn.click()
  })
  const alertDialog = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')
  assert.ok(alertDialog)
  await act(async () => {
    findButtonByText('Delete', alertDialog).click()
  })
  assert.deepEqual(removedProviders, ['ollama'])

  await act(async () => root.unmount())
}

if (process.argv.includes('--custom-providers-ui-fixture')) {
  await fixture()
} else {
  test('custom providers UI: reload broken config, fetch and save provider, add model, and delete', async () => {
    const { exitCode, stdout, stderr } = await runSelf(
      import.meta.path,
      ['--custom-providers-ui-fixture'],
      { timeoutMs: 12_000 }
    )
    assert.equal(exitCode, 0, stderr || stdout)
  }, 15_000)
}
