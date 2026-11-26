/**
 * Custom providers and models share `~/.pi/agent/models.json` and `auth.json` with the Pi CLI.
 *
 * Exercises the real `ModelRuntime` in an isolated agent directory so credential resolution,
 * catalog availability, round-trip preservation of hand-authored fields, secret masking, corrupt
 * file protection, and `/models` endpoint discovery are verified together.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { mock, test } from 'bun:test'
import { runSelf } from './helpers/subprocess.ts'

async function runFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-custom-models-'))
  const agentDir = join(root, 'agent')
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PIG_DIR = join(root, 'pig')
  process.env.PI_OFFLINE = '1'

  const broadcasts: unknown[] = []
  mock.module('electron', () => ({
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    shell: { openExternal: async () => {} },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => broadcasts.push({ channel, payload })
        }
      }]
    }
  }))

  let receivedAuthHeader: string | undefined
  let receivedCustomHeader: string | undefined
  const server = createServer((req, res) => {
    receivedAuthHeader = req.headers.authorization
    receivedCustomHeader = req.headers['x-gateway-secret'] as string | undefined
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({
        data: [
          {
            id: 'qwen3-coder:30b',
            name: 'Qwen3 Coder 30B',
            context_length: 262144,
            top_provider: { max_completion_tokens: 32768 },
            supported_parameters: ['reasoning'],
            architecture: { input_modalities: ['text', 'image'] }
          },
          {
            id: 'nomic-embed'
          }
        ]
      }))
      return
    }
    if (req.url === '/v1beta/models') {
      res.end(JSON.stringify({
        models: [
          {
            name: 'models/gemini-local-pro',
            displayName: 'Gemini Local Pro',
            inputTokenLimit: 1000000,
            outputTokenLimit: 65536,
            thinking: true,
            supportedGenerationMethods: ['generateContent']
          },
          {
            name: 'models/text-embedding-004',
            supportedGenerationMethods: ['embedContent']
          }
        ]
      }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}/v1`

  try {
    const {
      discoverCustomModels,
      getCustomModels,
      removeCustomModel,
      removeCustomProvider,
      saveCustomModel,
      saveCustomProvider
    } = await import('../src/main/pi/custom-models')
    const { currentModelCatalog } = await import('../src/main/pi/model-catalog')
    const { listProviders } = await import('../src/main/pi/providers')

    // 1. Seed a hand-authored models.json with comments and a built-in provider proxy override.
    await rm(agentDir, { recursive: true, force: true })
    await import('node:fs/promises').then((fs) => fs.mkdir(agentDir, { recursive: true }))
    await writeFile(
      join(agentDir, 'models.json'),
      `// Hand-edited comment\n{\n  "$schema": "https://pi.dev/schemas/models.schema.json",\n  "providers": {\n    "anthropic": {\n      "baseUrl": "https://proxy.example.com/anthropic"\n    },\n    "handcrafted": {\n      "baseUrl": "${baseUrl}",\n      "api": "openai-completions",\n      "apiKey": "sk-inline-secret",\n      "compat": { "thinkingFormat": "qwen" },\n      "headers": { "X-Gateway-Secret": "top-secret-header", "X-Env": "$TEST_HEADER_ENV" },\n      "models": [\n        {\n          "id": "hand-model",\n          "reasoning": true,\n          "samplingParams": { "temperature": 0.6 }\n        }\n      ]\n    }\n  }\n}\n`,
      'utf-8'
    )

    const initial = await getCustomModels()
    assert.equal(initial.error, null)
    assert.equal(initial.providers.length, 1, 'built-in provider overrides are excluded from custom provider list')
    assert.equal(initial.providers[0]!.id, 'handcrafted')
    assert.equal(initial.providers[0]!.hasSavedKey, true)
    assert.equal('apiKey' in initial.providers[0]!, false, 'raw API keys never cross the view contract')
    assert.deepEqual(initial.providers[0]!.headers, [
      { name: 'X-Gateway-Secret', hasSavedValue: true },
      { name: 'X-Env', envVar: 'TEST_HEADER_ENV', hasSavedValue: true }
    ])

    // Built-in providers list excludes custom providers so ProvidersPane never duplicates them.
    const builtinList = await listProviders()
    assert.equal(builtinList.some((p) => p.id === 'handcrafted'), false)
    assert.equal(builtinList.some((p) => p.id === 'anthropic'), true)

    // Reject colliding with built-in provider IDs.
    await assert.rejects(
      saveCustomProvider({
        id: 'openai',
        api: 'openai-completions',
        baseUrl,
        authMode: 'none',
        authHeader: false
      }),
      /built-in Pi provider/
    )

    // 2. Edit handcrafted provider & model while keeping saved secrets and hand-authored compat/samplingParams.
    await saveCustomProvider({
      previousId: 'handcrafted',
      id: 'handcrafted',
      name: 'Handcrafted Gateway',
      api: 'openai-completions',
      baseUrl,
      authMode: 'api_key',
      authHeader: true,
      headers: [
        { name: 'X-Gateway-Secret', keepSaved: true },
        { name: 'X-Env', value: '$TEST_HEADER_ENV' }
      ]
    })
    await saveCustomModel('handcrafted', {
      previousId: 'hand-model',
      id: 'hand-model',
      name: 'Hand Model Edited',
      reasoning: true,
      vision: true,
      contextWindow: 64000,
      maxTokens: 8192
    })

    const savedDisk = JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf-8'))
    assert.equal(savedDisk.providers.anthropic.baseUrl, 'https://proxy.example.com/anthropic', 'built-in override preserved')
    assert.deepEqual(savedDisk.providers.handcrafted.compat, { thinkingFormat: 'qwen' }, 'provider compat preserved')
    assert.equal(savedDisk.providers.handcrafted.apiKey, 'sk-inline-secret', 'untouched inline key preserved')
    assert.equal(savedDisk.providers.handcrafted.headers['X-Gateway-Secret'], 'top-secret-header', 'saved header preserved')
    assert.deepEqual(savedDisk.providers.handcrafted.models[0].samplingParams, { temperature: 0.6 }, 'model samplingParams preserved')
    assert.deepEqual(savedDisk.providers.handcrafted.models[0].input, ['text', 'image'])

    // 3. Discover remote models using stored provider credentials without sending secrets from renderer.
    const discovered = await discoverCustomModels({
      providerId: 'handcrafted',
      api: 'openai-completions',
      baseUrl,
      authMode: 'api_key'
    })
    assert.equal(receivedAuthHeader, 'Bearer sk-inline-secret')
    assert.equal(receivedCustomHeader, 'top-secret-header')
    assert.equal(discovered.length, 2)
    assert.deepEqual(discovered[0], {
      id: 'qwen3-coder:30b',
      name: 'Qwen3 Coder 30B',
      contextWindow: 262144,
      maxTokens: 32768,
      reasoning: true,
      vision: true
    })

    // Also verify Google Gemini /v1beta/models discovery filters embedding-only models and strips `models/`.
    const geminiDiscovered = await discoverCustomModels({
      api: 'google-generative-ai',
      baseUrl: `http://127.0.0.1:${port}`,
      authMode: 'api_key',
      apiKey: 'gemini-key'
    })
    assert.deepEqual(geminiDiscovered, [
      {
        id: 'gemini-local-pro',
        name: 'Gemini Local Pro',
        contextWindow: 1000000,
        maxTokens: 65536,
        reasoning: true
      }
    ])

    // 4. Create a new API-key provider: key goes to auth.json, not plaintext models.json, and models join catalog.
    await saveCustomProvider({
      id: 'my-gateway',
      name: 'My Gateway',
      api: 'openai-completions',
      baseUrl,
      authMode: 'api_key',
      apiKey: 'sk-stored-in-auth-json',
      authHeader: false,
      models: [
        {
          id: 'qwen3-coder:30b',
          name: 'Qwen3 Coder 30B',
          reasoning: true,
          vision: true,
          contextWindow: 262144,
          maxTokens: 32768
        }
      ]
    })

    const afterNew = JSON.parse(await readFile(join(agentDir, 'models.json'), 'utf-8'))
    assert.equal(afterNew.providers['my-gateway'].apiKey, undefined, 'new API keys are stored in auth.json, not models.json')
    const authDisk = JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf-8'))
    assert.equal(authDisk['my-gateway']?.key, 'sk-stored-in-auth-json')

    // 5. Create a keyless local provider (Ollama style) and verify both custom providers publish to ModelCatalog.
    await saveCustomProvider({
      id: 'ollama-local',
      name: 'Local Ollama',
      api: 'openai-completions',
      baseUrl,
      authMode: 'none',
      authHeader: false,
      models: [
        {
          id: 'llama3.3:70b',
          reasoning: false,
          vision: false,
          contextWindow: 128000,
          maxTokens: 16384
        }
      ]
    })

    const catalog = await currentModelCatalog()
    const customCatalogIds = catalog.models
      .filter((m) => ['handcrafted', 'my-gateway', 'ollama-local'].includes(m.provider))
      .map((m) => `${m.provider}/${m.id}`)
      .sort()
    assert.deepEqual(customCatalogIds, [
      'handcrafted/hand-model',
      'my-gateway/qwen3-coder:30b',
      'ollama-local/llama3.3:70b'
    ])
    assert.ok(broadcasts.some((b) => (b as { channel: string }).channel === 'models:changed'))

    // Removing a model and a provider cleans up both models.json and auth.json credentials.
    await removeCustomModel('ollama-local', 'llama3.3:70b')
    await removeCustomProvider('my-gateway')
    const authAfterRemove = JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf-8'))
    assert.equal(authAfterRemove['my-gateway'], undefined, 'stored credential removed with provider')

    // 6. Corrupt models.json must surface an error and refuse writes without overwriting the broken file.
    const brokenContent = '{"providers": { broken json'
    await writeFile(join(agentDir, 'models.json'), brokenContent, 'utf-8')
    const brokenState = await getCustomModels()
    assert.match(String(brokenState.error), /Failed to parse models\.json/)
    await assert.rejects(
      saveCustomProvider({
        id: 'another',
        api: 'openai-completions',
        baseUrl,
        authMode: 'none',
        authHeader: false
      }),
      /Failed to parse models\.json/
    )
    assert.equal(await readFile(join(agentDir, 'models.json'), 'utf-8'), brokenContent, 'corrupt file is never overwritten')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--custom-models-fixture') {
  await runFixture()
} else {
  test('custom providers & models: persistence, secret masking, catalog sync, discovery, and corrupt-file safety', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--custom-models-fixture'], {
      timeoutMs: 15_000
    })
    assert.equal(exitCode, 0, stderr || stdout)
  })
}
