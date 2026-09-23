/**
 * Locale contract and lookup shared by main, preload, and renderer.
 *
 * The dictionary is plain data, so both processes translate the same way; only the place a locale
 * comes from differs (main reads PigSettings, the renderer mirrors it in a store). Keys are dotted
 * paths into `zh`, typechecked by `Paths`, and `{name}` placeholders come from `translate` params.
 */
import { en } from './en'
import { zh, type Messages } from './zh'

export type { Messages } from './zh'

export const LOCALES = ['zh-CN', 'en'] as const
export type Locale = (typeof LOCALES)[number]
/** `system` follows the OS language at resolve time; anything else is an explicit choice. */
export type LocaleSetting = 'system' | Locale

/** Where an unsupported system language lands. */
export const DEFAULT_LOCALE: Locale = 'en'

export const messages: Record<Locale, Messages> = { 'zh-CN': zh, en }

type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`
}[keyof T & string]

export type MessageKey = Paths<Messages>
export type MessageParams = Record<string, string | number>
/** What `useT` returns: pure formatters take this so they stay free of store imports. */
export type Translate = (key: MessageKey, params?: MessageParams) => string

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export function parseLocaleSetting(value: unknown): LocaleSetting {
  return isLocale(value) ? value : 'system'
}

/** Matches on the primary subtag, so zh-Hans-CN and zh-TW both land on the shipped zh-CN. */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  const primary = value?.trim().toLowerCase().split('-')[0]
  if (!primary) return null
  return LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === primary) ?? null
}

export function resolveLocale(setting: LocaleSetting, system: string | null | undefined): Locale {
  return setting === 'system' ? normalizeLocale(system) ?? DEFAULT_LOCALE : setting
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const text = messageOf(messages[locale], key)
  if (text === undefined) return key
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name]
    return value === undefined ? placeholder : String(value)
  })
}

function messageOf(tree: Messages, key: string): string | undefined {
  let node: unknown = tree
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}
