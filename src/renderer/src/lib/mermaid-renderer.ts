let ready: Promise<typeof import('mermaid')> | undefined
let queue: Promise<unknown> = Promise.resolve()
let nextId = 0

/** Mermaid's configuration is global, so initialization and rendering share one queue. */
export function renderMermaid(code: string, dark: boolean, signal: AbortSignal): Promise<string> {
  const result = queue.then(async () => {
    signal.throwIfAborted()
    ready ??= import('mermaid').catch((error) => {
      ready = undefined
      throw error
    })
    const { default: mermaid } = await ready
    signal.throwIfAborted()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default'
    })
    const { svg } = await mermaid.render(`pig-mermaid-${++nextId}`, code)
    signal.throwIfAborted()
    return svg
  })
  queue = result.catch(() => {})
  return result
}
