/** Expand a selected recipe without executing commands; main validates the resulting configuration. */
import type { McpConfig, McpMarketServer } from './tool-settings'

/**
 * What makes two listings the same server, for de-duplication and for matching a saved server back
 * to the recipe it came from: its address, or its command plus package without the version.
 */
export function mcpConfigIdentity(config: McpConfig): string {
  if ('url' in config) return config.url.replace(/\/$/, '')
  const args = config.args ?? []
  if (config.command === 'docker') return `docker:${dockerImage(args)}`
  const pkg = packageArg(args).replace(/@[^/@]+$/, '')
  return `${config.command}:${pkg}`
}

/** `docker run` options whose value is a separate argument, so that value is not the image. */
const DOCKER_VALUE_OPTIONS = new Set([
  '-e',
  '--env',
  '--env-file',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '--name',
  '-u',
  '--user',
  '-w',
  '--workdir',
  '-h',
  '--hostname',
  '--entrypoint',
  '-m',
  '--memory',
  '--cpus',
  '--network',
  '--net',
  '--add-host',
  '--label',
  '-l',
  '--log-driver',
  '--platform',
  '--pull',
  '--restart',
  '--mount',
  '--tmpfs',
  '--ulimit',
  '--security-opt',
  '--cap-add',
  '--cap-drop',
  '--device',
  '--dns',
  '--gpus',
  '--shm-size',
  '--ipc',
  '--pid'
])

/**
 * The image a container starts, which is the first argument after `run` that is neither an option
 * nor an option's value. Reading a bare non-option argument instead would name the image after the
 * value of the preceding option: Pig writes `docker run -i --rm -e <NAME> <image>` for Registry OCI
 * entries, and an env var name there would give every such server the same identity.
 */
function dockerImage(args: string[]): string {
  for (let i = args.indexOf('run') + 1; i < args.length; i++) {
    if (!args[i].startsWith('-')) return args[i]
    // `--env=NAME` carries its value inline, so only a separate option consumes the next argument.
    if (!args[i].includes('=') && DOCKER_VALUE_OPTIONS.has(args[i])) i++
  }
  return ''
}

function packageArg(args: string[]): string {
  return args.find((value) => !value.startsWith('-') && value !== 'run') ?? ''
}

// Catalog data and password fields are literal values, not Pi's shell/env expression syntax.
export function literalMcpValue(value: string): string {
  return value.replaceAll('$', () => '$$').replace(/^!/, '$!')
}
/**
 * The command line or URL a listing writes, for inspection before it is added. Input placeholders
 * (`{dir}`, `{arg0}`) stay visible: the value is unknown until the form is filled, and the raw text
 * is what the listing actually declares.
 */
export function marketInvocation(server: McpMarketServer): string {
  return 'url' in server.config
    ? server.config.url
    : [server.config.command, ...(server.config.args ?? [])].join(' ')
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
  }
  return config
}
