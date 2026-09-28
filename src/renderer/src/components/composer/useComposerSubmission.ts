import { useEffect, useRef, useState } from 'react'
import { t } from '../../lib/i18n'
import type { JSONContent } from '@tiptap/core'
import { stripPastedTextAttachments } from '../../../../shared/pasted-text'
import { api, type PromptStreamingBehavior, type SessionPreviewFallback } from '../../ipc/api'
import { useSessionsStore } from '../../stores/sessions'
import { composerUserMessage, textToComposerDocument } from './document'
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
  bashMode?: boolean
  onBashSubmitted?: () => void
}

export function useComposerSubmission({ sessionId, draftCwd, isDraftSession, document, attachments, bashMode = false, onBashSubmitted }: SubmissionOptions) {
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [failedDrafts, setFailedDrafts] = useState<Record<string, FailedDraft[]>>({})
  const bashInFlight = useRef(new Set<string>())
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
    const target = sessionId
    if (!target || bashInFlight.current.has(target)) return
    const command = bashMode ? serialized.text.trim() : null
    if (command !== null && (!command || hasAttachments || images.length > 0)) {
      if (hasAttachments || images.length > 0) setErrors((current) => ({ ...current, [target]: t('composer.bashAttachments') }))
      return
    }

    const saved = { content: command !== null ? textToComposerDocument(`!${serialized.text}`) : document.editor.getJSON(), images }
    const payload = images.map(({ mimeType, data }) => ({ mimeType, data }))
    const titleText = hasAttachments ? stripPastedTextAttachments(serialized.text, serialized.attachments).trim() : trimmed
    // An attachments/images-only first message has no text to show: the title is a marker the store
    // translates, never a frozen word.
    const fallback: SessionPreviewFallback | undefined = hasAttachments ? 'pastedText' : images.length > 0 ? 'image' : undefined
    const title = titleText.slice(0, 500) || (fallback === 'pastedText' ? t('composer.pastedText') : fallback === 'image' ? t('common.image') : '')
    const text = hasAttachments ? serialized.text : trimmed
    if (command !== null) bashInFlight.current.add(target)

    if (isDraftSession) {
      if (!draftCwd) {
        bashInFlight.current.delete(target)
        return
      }
      try {
        if (!await useSessionsStore.getState().promoteDraft(draftCwd, target)) {
          bashInFlight.current.delete(target)
          return
        }
      } catch (error) {
        bashInFlight.current.delete(target)
        report(errorKey, error)
        return
      }
    }

    if (command !== null) {
      const initial = useSessionsStore.getState().runtime[target]
      if (!initial) {
        bashInFlight.current.delete(target)
        return
      }
      if (initial.isStreaming || initial.bashExecution) {
        bashInFlight.current.delete(target)
        report(target, new Error(t('composer.bashBusy')))
        return
      }
      const instanceId = initial.instanceId
      const isCurrent = () => useSessionsStore.getState().runtime[target]?.instanceId === instanceId
      const id = crypto.randomUUID()
      let begun = false
      let cleared = false
      let result: Awaited<ReturnType<typeof api.executeBash>> | undefined
      let persistedTurnId: string | undefined
      setErrors((current) => ({ ...current, [target]: undefined }))
      try {
        const prepared = await api.prepareSession(target)
        if (!isCurrent()) return
        if (useSessionsStore.getState().runtime[target]?.isStreaming) {
          report(target, new Error(t('composer.bashBusy')))
          return
        }
        if (prepared.created) {
          void useSessionsStore.getState().refreshCwd(prepared.cwd).catch((error) => {
            if (isCurrent()) report(target, error)
          })
        }
        useSessionsStore.getState().beginBash(target, id, command)
        begun = true
        if (document.getDraft() === serialized) {
          document.clear()
          onBashSubmitted?.()
          cleared = true
        }
        useSessionsStore.getState().previewSessionTitle(target, `!${command.slice(0, 499)}`)
        result = await api.executeBash(target, command, id)
        if (!isCurrent()) return
        const results = await Promise.allSettled([
          useSessionsStore.getState().hydrateTurns(target, { keepOlderTurns: true }),
          useSessionsStore.getState().refreshCwd(prepared.cwd)
        ])
        if (results[0].status === 'fulfilled' && results[0].value) {
          const last = useSessionsStore.getState().runtime[target]?.turns.at(-1)
          if (last?.bash?.command === command) persistedTurnId = last.id
        }
        const failed = results.find((item) => item.status === 'rejected')
        if (failed?.status === 'rejected') report(target, failed.reason)
      } catch (error) {
        if (isCurrent()) {
          if (cleared && !result) setFailedDrafts((current) => ({ ...current, [target]: [...(current[target] ?? []), saved] }))
          report(target, error)
        }
      } finally {
        if (begun) useSessionsStore.getState().endBash(target, id, result, persistedTurnId)
        bashInFlight.current.delete(target)
      }
      return
    }

    const state = useSessionsStore.getState()
    const runtime = state.runtime[target]
    if (!runtime) return
    const instanceId = runtime.instanceId
    const isCurrent = () => useSessionsStore.getState().runtime[target]?.instanceId === instanceId
    const streaming = runtime.isStreaming
    setErrors((current) => ({ ...current, [target]: undefined }))

    const optimistic = composerUserMessage(text, payload, serialized.attachments)
    if (!streaming) state.beginPrompt(target, optimistic)
    if (title) state.previewSessionTitle(target, title, fallback)
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
    if (useSessionsStore.getState().runtime[sessionId]?.bashExecution) {
      try {
        await api.abortBash(sessionId)
      } catch (error) {
        report(sessionId, error)
      }
      return
    }
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
