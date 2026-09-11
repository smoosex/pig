import { useEffect, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { stripPastedTextAttachments } from '../../../../shared/pasted-text'
import { api, type PromptStreamingBehavior } from '../../ipc/api'
import { useSessionsStore } from '../../stores/sessions'
import { exportPathArg } from './commands'
import { composerUserMessage } from './document'
import type { useComposerEditor } from './useComposerEditor'
import type { PastedImage, useComposerImages } from './useComposerImages'

interface FailedDraft {
  content: JSONContent
  images: PastedImage[]
}

interface SubmissionOptions {
  sessionId: string | null
  document: ReturnType<typeof useComposerEditor>
  attachments: ReturnType<typeof useComposerImages>
}

/** Keep failed submissions recoverable without replacing text typed while a request was pending. */
export function useComposerSubmission({ sessionId, document, attachments }: SubmissionOptions) {
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [failedDrafts, setFailedDrafts] = useState<Record<string, FailedDraft[]>>({})
  const exporting = useRef(new Set<string>())
  const recoverable = sessionId ? failedDrafts[sessionId] : undefined

  function report(target: string, cause: unknown): void {
    setErrors((current) => ({ ...current, [target]: cause instanceof Error ? cause.message : String(cause) }))
  }

  function restore(): void {
    if (!sessionId || !recoverable?.length || !document.editor || document.editor.isDestroyed) return
    const current = document.getDraft()
    const content = recoverable.flatMap((draft) => draft.content.content ?? [])
    if (current.text || current.attachments.length) content.push(...(document.editor.getJSON().content ?? []))
    document.restore({ type: 'doc', content })
    attachments.restore(recoverable.flatMap((draft) => draft.images))
    setFailedDrafts((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }

  useEffect(() => {
    if (recoverable?.length && !document.getDraft().text && attachments.getImages().length === 0) restore()
  }, [recoverable, document.draft, attachments.images, sessionId])

  async function send(streamingBehavior: PromptStreamingBehavior = 'followUp'): Promise<void> {
    if (!sessionId || !document.editor || exporting.current.has(sessionId)) return
    const serialized = document.getDraft()
    const images = attachments.getImages()
    const hasAttachments = serialized.attachments.length > 0
    const trimmed = serialized.text.trim()
    if (!trimmed && !hasAttachments && images.length === 0) return
    const state = useSessionsStore.getState()
    const runtime = state.runtime[sessionId]
    if (!runtime) return
    const instanceId = runtime.instanceId
    const isCurrent = () => useSessionsStore.getState().runtime[sessionId]?.instanceId === instanceId
    const streaming = state.runtime[sessionId]?.isStreaming ?? false
    setErrors((current) => ({ ...current, [sessionId]: undefined }))

    if (!streaming && (trimmed === '/export' || trimmed.startsWith('/export ')) && !hasAttachments) {
      exporting.current.add(sessionId)
      try {
        const result = await api.exportSession(sessionId, exportPathArg(trimmed))
        if (result && useSessionsStore.getState().activeSessionId === sessionId && document.getDraft() === serialized) {
          document.clear()
        }
      } catch (error) {
        if (isCurrent()) report(sessionId, error)
      } finally {
        exporting.current.delete(sessionId)
      }
      return
    }

    const saved = { content: document.editor.getJSON(), images }
    const payload = images.map(({ mimeType, data }) => ({ mimeType, data }))
    const titleText = hasAttachments ? stripPastedTextAttachments(serialized.text, serialized.attachments).trim() : trimmed
    const title = titleText.slice(0, 500) || (hasAttachments ? 'Pasted text' : images.length > 0 ? '图片' : '')
    const text = hasAttachments ? serialized.text : trimmed
    const optimistic = composerUserMessage(text, payload, serialized.attachments)
    if (!streaming) state.beginPrompt(sessionId, optimistic)
    if (title) state.previewSessionTitle(sessionId, title)
    document.clear()
    attachments.clear()

    let cwd: string
    try {
      const prepared = await api.prepareSession(sessionId)
      if (!isCurrent()) return
      cwd = prepared.cwd
      if (prepared.created) {
        void useSessionsStore.getState().refreshCwd(cwd).catch((error) => {
          if (isCurrent()) report(sessionId, error)
        })
      }
      await api.prompt(
        sessionId,
        text,
        payload.length > 0 ? payload : undefined,
        hasAttachments ? serialized.attachments : undefined,
        streaming ? streamingBehavior : undefined
      )
    } catch (error) {
      if (!isCurrent()) return
      const current = useSessionsStore.getState()
      const runtime = current.runtime[sessionId]
      const unaccepted = streaming || runtime?.pendingUserMessage
      if (unaccepted) {
        if (!streaming) current.rollbackPrompt(sessionId)
        setFailedDrafts((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), saved] }))
      }
      report(sessionId, error)
      return
    }

    // A projection refresh failure must not roll back a prompt already accepted by Pi.
    if (!isCurrent()) return
    const current = useSessionsStore.getState()
    const consumedCommand = !streaming && current.runtime[sessionId]?.pendingUserMessage
    if (consumedCommand) current.rollbackPrompt(sessionId)
    const results = await Promise.allSettled([
      useSessionsStore.getState().refreshCwd(cwd),
      useSessionsStore.getState().loadControls(sessionId),
      ...(consumedCommand ? [useSessionsStore.getState().hydrateTurns(sessionId)] : [])
    ])
    const failed = results.find((result) => result.status === 'rejected')
    if (isCurrent() && failed?.status === 'rejected') report(sessionId, failed.reason)
  }

  async function abort(): Promise<void> {
    if (!sessionId) return
    try {
      await api.abort(sessionId)
    } catch (error) {
      report(sessionId, error)
    }
  }

  return { send, abort, error: sessionId ? errors[sessionId] : undefined, canRestore: Boolean(recoverable?.length), restore }
}
