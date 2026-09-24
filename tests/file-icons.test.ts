import { expect, test } from 'bun:test'
import { fileIconName } from '../src/renderer/src/lib/file-icons'
import { extensions, fileNames } from '../src/renderer/src/lib/file-icons.generated'

test('named files win over their generic extensions', () => {
  expect(fileIconName('src/package.json')).toBe('nodejs')
  expect(fileIconName('README.md')).toBe('readme')
  expect(fileIconName('.gitignore')).toBe('git')
  expect(fileIconName('bun.lock')).toBe('bun')
})

test('case-sensitive file names and directory-specific names remain reachable', () => {
  for (const [name, icon] of Object.entries(fileNames)) {
    if (name !== name.toLowerCase()) expect(fileIconName(`src/${name}`)).toBe(icon)
  }
  expect(fileIconName('project\\.github\\FUNDING.yml')).toBe('github-sponsors')
  expect(fileIconName('project/.config/graphqlrc.json')).toBe(fileNames['.config/graphqlrc.json'])
  expect(fileIconName('docs/README.md')).toBe('readme')
})

test('compound extensions win over their last segment', () => {
  expect(fileIconName('src/types.d.ts')).toBe('typescript-def')
  expect(fileIconName('src/main.TSX')).toBe('react_ts')
  expect(fileIconName('src\\main.ts')).toBe('typescript')
})

test('case-sensitive extension associations remain reachable', () => {
  for (const [extension, icon] of Object.entries(extensions)) {
    if (extension !== extension.toLowerCase()) {
      expect(fileIconName(`src/example.${extension}`)).toBe(icon)
    }
  }
  expect(fileIconName('foo.tmLanguage')).toBe('xml')
  expect(fileIconName('foo.YAML-tmLanguage')).toBe('yaml')
})

test('unknown files fall back to the generic file icon', () => {
  expect(fileIconName('no-such-extension.pigpig')).toBeNull()
  expect(fileIconName('no-extension')).toBeNull()
})
