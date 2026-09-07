import { utilityProcess } from 'electron'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export function runBranchNamer(
  text: string,
  model: { provider: string; id: string } | null,
  signal: AbortSignal
): Promise<string> {
  if (!model) return Promise.reject(new Error('请先在设置中配置默认模型'))
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
    const abort = () => finish(new Error('分支命名已取消'))
    const timer = setTimeout(() => finish(new Error('分支命名超时，保留 UUID 分支')), 120_000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout?.resume()
    child.stderr?.resume()
    child.once('spawn', () => {
      if (!settled) child.postMessage({ text, provider: model.provider, modelId: model.id })
    })
    child.once('message', (message: { branch?: string; error?: string }) => {
      if (typeof message?.branch === 'string') finish(undefined, message.branch)
      else finish(new Error(message?.error || '临时 Pi 进程返回无效结果'))
    })
    child.once('exit', (code) => finish(new Error(`临时 Pi 进程退出 (${code})`)))
    if (signal.aborted) abort()
  })
}
