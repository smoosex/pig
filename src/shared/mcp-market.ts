/** Expand a selected recipe without executing commands; main validates the resulting configuration. */
import type { McpConfig, McpMarketServer } from './tool-settings'
// Catalog data and password fields are literal values, not Pi's shell/env expression syntax.
export function literalMcpValue(value: string): string {
  return value.replaceAll('$', () => '$$').replace(/^!/, '$!')
}
export function fillMarketConfig(
  server: McpMarketServer,
  values: Record<string, string>
): McpConfig {
  const config = structuredClone(server.config)
  for (const field of server.inputs) {
    const value = values[field.key]?.trim()
    if (!value) {
      if (field.required) throw new Error(`${field.label} is required`)
      continue
    }
    if (field.where === 'env' && 'command' in config)
      config.env = { ...config.env, [field.key]: literalMcpValue(value) }
    if (field.where === 'header' && 'url' in config)
      config.headers = {
        ...config.headers,
        [field.key]: literalMcpValue((field.format || '{}').replace('{}', value))
      }
    if (field.where === 'arg' && 'command' in config)
      config.args = config.args?.map((arg) => arg.replace(`{${field.key}}`, value))
    if (field.where === 'url' && 'url' in config)
      config.url = config.url.replace(`{${field.key}}`, encodeURIComponent(value))
  }
  return config
}
