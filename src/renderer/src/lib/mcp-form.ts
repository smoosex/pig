/** Manual MCP form conversion. Shell-looking text is split into argv, never executed by a shell. */
import type { Translate } from '../../../shared/i18n'
import { literalMcpValue } from '../../../shared/mcp-market'

export interface McpFormPair {
  key: string
  value: string
  configured?: string
}
export interface McpManualForm {
  transport: 'stdio' | 'http'
  commandLine: string
  url: string
  env: McpFormPair[]
  headers: McpFormPair[]
}

export function parseMcpCommand(line: string, t: Translate): { command: string; args: string[] } {
  const words: string[] = []
  let word = ''
  let quote = ''
  let started = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '\\' && quote !== "'") {
      const next = line[i + 1]
      if (
        next &&
        (next === '\\' || next === '"' || (!quote && (next === "'" || /\s/.test(next))))
      ) {
        word += next
        i++
      } else word += char
      started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (quote) throw new Error(t('mcp.commandQuote'))
  if (started) words.push(word)
  return { command: words[0] ?? '', args: words.slice(1) }
}

export function formatMcpCommand(command: string, args: string[]): string {
  if (!command && !args.length) return ''
  return [command, ...args]
    .map((word) =>
      word && !/[\s"'\\]/.test(word)
        ? word
        : `"${word.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    )
    .join(' ')
}

function object(value: unknown, t: Translate): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(t('mcp.configHint'))
  return value as Record<string, unknown>
}

function displayValue(value: string): string {
  return value.replace(/^\$!/, '!').replaceAll('$$', '$')
}

function pairs(value: unknown, t: Translate): McpFormPair[] {
  if (value === undefined) return []
  return Object.entries(object(value, t)).map(([key, raw]) => {
    if (typeof raw !== 'string') throw new Error(t('mcp.pairValueString', { key }))
    return { key, value: displayValue(raw), configured: raw }
  })
}

export function mcpFormFromConfig(config: Record<string, unknown>, t: Translate): McpManualForm {
  if (config.type === 'sse') throw new Error(t('mcp.unsupportedSse'))
  if (config.mcpServers) throw new Error(t('mcp.formSingle'))
  if (typeof config.command !== 'string' && typeof config.url !== 'string')
    throw new Error(t('mcp.configHint'))
  const args = config.args ?? []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error(t('mcp.configHint'))
  return {
    transport: typeof config.command === 'string' ? 'stdio' : 'http',
    commandLine: typeof config.command === 'string' ? formatMcpCommand(config.command, args) : '',
    url: typeof config.url === 'string' ? config.url : '',
    env: pairs(config.env, t),
    headers: pairs(config.headers, t)
  }
}

export function mcpFormPairs(rows: McpFormPair[], t: Translate): Record<string, string> {
  const result = new Map<string, string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (!key && !row.value) continue
    if (!key) throw new Error(t('mcp.pairKeyRequired'))
    if (result.has(key)) throw new Error(t('mcp.duplicateKey', { key }))
    // Existing/JSON-authored values retain Pi's advanced expressions. New values are literal,
    // except a whole ${NAME} which is an explicit request to read an environment variable.
    const value =
      row.configured !== undefined && row.value === displayValue(row.configured)
        ? row.configured
        : /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(row.value)
          ? row.value
          : literalMcpValue(row.value)
    result.set(key, value)
  }
  return Object.fromEntries(result)
}

export function mcpConfigFromForm(
  base: Record<string, unknown>,
  form: McpManualForm,
  t: Translate
): Record<string, unknown> {
  const config = { ...base }
  if (form.transport === 'http') {
    for (const key of ['command', 'args', 'env', 'cwd']) delete config[key]
    Object.assign(config, {
      type: 'http',
      url: form.url.trim(),
      headers: mcpFormPairs(form.headers, t)
    })
  } else {
    for (const key of ['url', 'headers', 'oauth', 'auth']) delete config[key]
    Object.assign(config, {
      type: 'stdio',
      ...parseMcpCommand(form.commandLine, t),
      env: mcpFormPairs(form.env, t)
    })
  }
  return config
}

export function parseMcpPaste(
  text: string,
  t: Translate
):
  | { kind: 'single'; name?: string; config: Record<string, unknown> }
  | { kind: 'multiple'; document: Record<string, unknown> } {
  const raw = object(JSON.parse(text), t)
  if ('command' in raw || 'url' in raw) return { kind: 'single', config: raw }
  const entries = Object.entries(object(raw.mcpServers ?? raw, t))
  if (!entries.length) throw new Error(t('mcp.emptyImport'))
  for (const [, value] of entries) {
    const config = object(value, t)
    if (config.type === 'sse') throw new Error(t('mcp.unsupportedSse'))
    if (typeof config.command !== 'string' && typeof config.url !== 'string')
      throw new Error(t('mcp.configHint'))
  }
  if (entries.length === 1)
    return { kind: 'single', name: entries[0][0], config: object(entries[0][1], t) }
  return { kind: 'multiple', document: raw }
}
