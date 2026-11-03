/** Native schema inference and detached plugin resolution must survive SDK upgrades. */
import { expect, expectTypeOf, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, int, obj, oneOf, opt, str, type Static } from '@earendil-works/pi-schema'
import { DefaultResourceLoader, SettingsManager, defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

const parameters = obj({ path: str(), mode: oneOf(['text', 'binary']), offset: opt(int({ minimum: 0 })) })
type Input = { path: string; mode: 'text' | 'binary'; offset?: number }

test('native schemas retain parameter inference in tool definitions and registration', async () => {
  expectTypeOf<Static<typeof parameters>>().toEqualTypeOf<Input>()
  const tool = defineTool({
    name: 'schema_probe', label: 'Schema probe', description: 'Schema inference fixture', parameters,
    async execute(_id, params) {
      expectTypeOf(params).toEqualTypeOf<Input>()
      return { content: [{ type: 'text' as const, text: params.path }], details: undefined }
    }
  })
  const result = await tool.execute('call', { path: 'a.ts', mode: 'text' }, undefined, undefined, {} as never)
  expect(result.content).toEqual([{ type: 'text', text: 'a.ts' }])
  // Typecheck the generic registration boundary too, without creating an agent or sending a request.
  const register = (pi: ExtensionAPI) => pi.registerTool({
    name: 'registered_probe', label: 'Registered probe', description: 'Registration inference fixture', parameters,
    async execute(_id, params) {
      expectTypeOf(params).toEqualTypeOf<Input>()
      return { content: [], details: undefined }
    }
  })
  register({ registerTool: () => {} } as unknown as ExtensionAPI)
})

test('detached plugins resolve native schema builders and optional formats through SDK aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-native-schema-'))
  try {
    const path = join(root, 'extension.ts')
    await writeFile(path, `
import { compile, obj, str } from '@earendil-works/pi-schema'
import { formats } from '@earendil-works/pi-schema/formats'
export default function (pi) {
  const parameters = obj({ id: str({ format: 'uuid' }) })
  const validator = compile(parameters, { formats })
  if (validator.check({ id: 'invalid' })) throw new Error('Formats were not loaded')
  pi.registerTool({
    name: 'detached_probe', label: 'Detached probe', description: 'Detached alias fixture', parameters,
    async execute(_id, params) { return { content: [{ type: 'text', text: params.id }], details: undefined } }
  })
}
`)
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [path]
    })
    await loader.reload()
    expect(loader.getExtensions().errors).toEqual([])
    const definition = loader.getExtensions().extensions.find(extension => extension.path === path)!.tools.get('detached_probe')!.definition
    const validator = compile(definition.parameters)
    expect(validator.check({ id: 'fixture' })).toBe(true)
    expect(validator.check({ id: 'fixture', unexpected: true })).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
