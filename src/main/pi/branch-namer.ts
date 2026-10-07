import { utilityProcess } from 'electron'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { t } from '../i18n'
import { getDefaultSessionSettings } from './model-settings'

/**
 * The branch name for a task, using the app's default model.
 * Shared by the first-prompt path and an explicit retry, so both name with the same settings.
 */
export function nameWorktreeBranch(task: string, signal: AbortSignal): Promise<string> {
  return getDefaultSessionSettings().then((settings) => runBranchNamer(task, settings.model, signal))
}

export function runBranchNamer(
  text: string,
  model: { provider: string; id: string } | null,
  signal: AbortSignal
): Promise<string> {
  if (!model) return Promise.reject(new Error(t('naming.skipped')))
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(fileURLToPath(new URL('./branch-namer-worker.js', import.meta.url)), [], {
      serviceName: 'Pig branch naming', cwd: homedir(), stdio: 'pipe'
    })
    let settled = false
    const finish = (error?: Error, branch?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      child.kill()
      if (error) reject(error)
      else resolve(branch!)
    }
    const abort = () => finish(new Error(t('naming.cancelled')))
    const timer = setTimeout(() => finish(new Error(t('naming.timeout'))), 120_000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout?.resume()
    child.stderr?.resume()
    child.once('spawn', () => {
      if (!settled) child.postMessage({ text, provider: model.provider, modelId: model.id })
    })
    child.once('message', (message: { branch?: string; error?: string }) => {
      if (typeof message?.branch === 'string') finish(undefined, message.branch)
      else finish(new Error(message?.error || t('naming.invalidResult')))
    })
    child.once('exit', (code) => finish(new Error(t('naming.processExit', { code: code ?? '' }))))
    if (signal.aborted) abort()
  })
}
