import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  messages,
  normalizeLocale,
  parseLocaleSetting,
  resolveLocale,
  translate,
  type MessageKey
} from '../src/shared/i18n'

function keyPaths(tree: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'string' ? [path] : keyPaths(value as Record<string, unknown>, path)
  })
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

function valueAt(tree: Record<string, unknown>, path: string): string {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree) as string
}

describe('locale resolution', () => {
  test('matches the system language on its primary subtag', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-TW')).toBe('zh-CN')
    expect(normalizeLocale('en-GB')).toBe('en')
    expect(normalizeLocale('EN')).toBe('en')
    expect(normalizeLocale(' fr-FR ')).toBe(null)
    expect(normalizeLocale('')).toBe(null)
    expect(normalizeLocale(null)).toBe(null)
  })

  test('falls back to the default locale for languages pig does not ship', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(resolveLocale('system', 'fr-FR')).toBe('en')
    expect(resolveLocale('system', undefined)).toBe('en')
    expect(resolveLocale('system', 'zh-Hans')).toBe('zh-CN')
  })

  test('an explicit choice outranks the system language', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en')
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN')
  })

  test('an unknown stored value means "follow the system"', () => {
    expect(parseLocaleSetting('zh-CN')).toBe('zh-CN')
    expect(parseLocaleSetting('en')).toBe('en')
    expect(parseLocaleSetting('system')).toBe('system')
    expect(parseLocaleSetting('fr')).toBe('system')
    expect(parseLocaleSetting(undefined)).toBe('system')
    expect(isLocale('zh-CN')).toBe(true)
    expect(isLocale('zh')).toBe(false)
  })
})

describe('message tables', () => {
  test('every locale ships exactly the keys the source locale defines', () => {
    const expected = keyPaths(messages['zh-CN'] as unknown as Record<string, unknown>).sort()
    for (const locale of LOCALES) {
      const tree = messages[locale] as unknown as Record<string, unknown>
      expect(keyPaths(tree).sort()).toEqual(expected)
      for (const path of expected) expect(valueAt(tree, path).length).toBeGreaterThan(0)
    }
  })

  test('translations keep the placeholders of the source string', () => {
    const tree = messages['zh-CN'] as unknown as Record<string, unknown>
    for (const path of keyPaths(tree)) {
      const expected = placeholders(valueAt(tree, path))
      for (const locale of LOCALES) {
        expect(placeholders(valueAt(messages[locale] as unknown as Record<string, unknown>, path))).toEqual(expected)
      }
    }
  })
})

describe('translate', () => {
  test('fills placeholders and leaves unknown ones alone', () => {
    expect(translate('zh-CN', 'time.minutesAgo', { n: 5 })).toBe('5分钟前')
    expect(translate('en', 'time.minutesAgo', { n: 5 })).toBe('5 min ago')
    expect(translate('en', 'settings.languageSystemWith', { language: 'English' })).toBe('System (English)')
    expect(translate('zh-CN', 'settings.languageSystemWith')).toBe('跟随系统（{language}）')
    expect(translate('zh-CN', 'settings.languageSystemWith', { other: 'x' })).toBe('跟随系统（{language}）')
  })

  test('an unknown key renders as itself rather than blank', () => {
    expect(translate('en', 'nope.missing' as MessageKey)).toBe('nope.missing')
  })
})

describe('main-process copy', () => {
  test('errors and the export title follow the locale setting', async () => {
    const { applyLocaleSetting, currentLocale, t: mainT } = await import('../src/main/i18n')
    const before = currentLocale()
    try {
      applyLocaleSetting('en')
      expect(mainT('error.gitRequired')).toBe('Initialize Git first')
      expect(mainT('sessions.export')).toBe('Export session')
      expect(mainT('naming.processExit', { code: 3 })).toBe('The temporary pi process exited (3)')
      applyLocaleSetting('zh-CN')
      expect(mainT('error.gitRequired')).toBe('请先初始化 Git')
      expect(mainT('sessions.export')).toBe('导出会话')
      expect(mainT('naming.processExit', { code: 3 })).toBe('临时 Pi 进程退出 (3)')
    } finally {
      applyLocaleSetting(before)
    }
  })
})
