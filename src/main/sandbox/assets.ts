/** Helpers executed by the OS need physical paths; shell commands cannot see Electron's virtual asar. */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

export function sandboxAssets(): Pick<SandboxRuntimeConfig, 'javaAgentJarPath' | 'seccomp'> {
  const root = dirname(dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'))))
    .replace(/\.asar([\\/])/, '.asar.unpacked$1')
  return {
    javaAgentJarPath: join(root, 'vendor', 'java-proxy-agent', 'srt-proxy-agent.jar'),
    ...(process.platform === 'linux' ? { seccomp: { applyPath: join(root, 'vendor', 'seccomp', process.arch, 'apply-seccomp') } } : {})
  }
}
