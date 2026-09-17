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
  draftCwd?: string
  isDraftSession?: boolean
  document: ReturnType<typeof useComposerEditor>
  attachments: ReturnType<typeof useComposerImages>
}

export function useComposerSubmission({ sessionId, draftCwd, isDraftSession, document, attachments }: SubmissionOptions) {
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [failedDrafts, setFailedDrafts] = useState<Record<string, FailedDraft[]>>({})
  const exporting = useRef(new Set<string>())
  const stopEpochs = useRef(new Map<string, number>())
  const recoverable = sessionId ? failedDrafts[sessionId] : undefined
  const errorKey = sessionId ?? (draftCwd ? `draft:${draftCwd}` : '')

  function stopEpoch(target: string): number {
    return stopEpochs.current.get(target) ?? 0
  }

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
    if (!document.editor) return
    const serialized = document.getDraft()
    const images = attachments.getImages()
    const hasAttachments = serialized.attachments.length > 0
    const trimmed = serialized.text.trim()
    if (!trimmed && !hasAttachments && images.length === 0) return

    const saved = { content: document.editor.getJSON(), images }
    const payload = images.map(({ mimeType, data }) => ({ mimeType, data }))
    const titleText = hasAttachments ? stripPastedTextAttachments(serialized.text, serialized.attachments).trim() : trimmed
    const title = titleText.slice(0, 500) || (hasAttachments ? 'Pasted text' : images.length > 0 ? '图片' : '')
    const text = hasAttachments ? serialized.text : trimmed
    const target = sessionId
    if (!target) return

    if (isDraftSession) {
      if (!draftCwd) return
      try {
        if (!await useSessionsStore.getState().promoteProjectDraft(draftCwd, target)) return
      } catch (error) {
        report(errorKey, error)
        return
      }
    }

    if (exporting.current.has(target)) return
    const state = useSessionsStore.getState()
    const runtime = state.runtime[target]
    if (!runtime) return
    const instanceId = runtime.instanceId
    const isCurrent = () => useSessionsStore.getState().runtime[target]?.instanceId === instanceId
    const streaming = runtime.isStreaming
    setErrors((current) => ({ ...current, [target]: undefined }))

    if (!streaming && (trimmed === '/export' || trimmed.startsWith('/export ')) && !hasAttachments) {
      exporting.current.add(target)
      try {
        const result = await api.exportSession(target, exportPathArg(trimmed))
        if (result && useSessionsStore.getState().activeSessionId === target && document.getDraft() === serialized) {
          document.clear()
        }
      } catch (error) {
        if (isCurrent()) report(target, error)
      } finally {
        exporting.current.delete(target)
      }
      return
    }

    const optimistic = composerUserMessage(text, payload, serialized.attachments)
    if (!streaming) state.beginPrompt(target, optimistic)
    if (title) state.previewSessionTitle(target, title)
    document.clear()
    attachments.clear()

    const startedAt = stopEpoch(target)
    let cwd: string
    try {
      const prepared = await api.prepareSession(target)
      if (!isCurrent()) return
      if (stopEpoch(target) !== startedAt) {
        if (!streaming) useSessionsStore.getState().rollbackPrompt(target)
        setFailedDrafts((current) => ({ ...current, [target]: [...(current[target] ?? []), saved] }))
        return
      }
      cwd = prepared.cwd
      if (prepared.created) {
        void useSessionsStore.getState().refreshCwd(cwd).catch((error) => {
          if (isCurrent()) report(target, error)
        })
      }
      await api.prompt(
        target,
        text,
        payload.length > 0 ? payload : undefined,
        hasAttachments ? serialized.attachments : undefined,
        streaming ? streamingBehavior : undefined
      )
    } catch (error) {
      if (!isCurrent()) return
      const current = useSessionsStore.getState()
      const activeRuntime = current.runtime[target]
      const unaccepted = streaming || activeRuntime?.pendingUserMessage
      if (unaccepted) {
        if (!streaming) current.rollbackPrompt(target)
        setFailedDrafts((current) => ({ ...current, [target]: [...(current[target] ?? []), saved] }))
      }
      report(target, error)
      return
    }

    if (!isCurrent()) return
    const current = useSessionsStore.getState()
    const consumedCommand = !streaming && current.runtime[target]?.pendingUserMessage
    if (consumedCommand) current.rollbackPrompt(target)
    const results = await Promise.allSettled([
      useSessionsStore.getState().refreshCwd(cwd),
      useSessionsStore.getState().loadControls(target),
      ...(consumedCommand ? [useSessionsStore.getState().hydrateTurns(target, { keepOlderTurns: true })] : [])
    ])
    const failed = results.find((result) => result.status === 'rejected')
    if (isCurrent() && failed?.status === 'rejected') report(target, failed.reason)
  }

  async function abort(): Promise<void> {
    if (!sessionId) return
    stopEpochs.current.set(sessionId, stopEpoch(sessionId) + 1)
    try {
      await api.abort(sessionId)
    } catch (error) {
      report(sessionId, error)
    }
  }

  return {
    send,
    abort,
    error: errorKey ? errors[errorKey] : undefined,
    canRestore: Boolean(recoverable?.length),
    restore
  }
}
