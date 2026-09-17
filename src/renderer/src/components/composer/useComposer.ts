import { useEffect } from 'react'
import { useSessionsStore } from '../../stores/sessions'
import { useSettingsStore } from '../../stores/settings'
import { useComposerEditor } from './useComposerEditor'
import { useComposerImages } from './useComposerImages'
import { useSlashCommands } from './useSlashCommands'
import { useComposerSubmission } from './useComposerSubmission'

/** Coordinates a draft with the active Pi session; editor and attachment state stay local. */
export function useComposer(draftCwd?: string, draftSessionId?: string | null) {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const sessionId = activeSessionId ?? draftSessionId ?? null
  const isDraftSession = Boolean(!activeSessionId && draftCwd && draftSessionId)
  const isStreaming = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.isStreaming ?? false) : false)
  const queuedEditText = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.queuedEditText ?? null) : null)
  const clearQueuedEditText = useSessionsStore((s) => s.clearQueuedEditText)
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)
  const draftKey = activeSessionId ?? (draftCwd ? `draft:${draftCwd}` : null)
  const attachments = useComposerImages(draftKey)
  const document = useComposerEditor({ sessionId: draftKey, onKeyDown: handleKeyDown, onPasteImages: attachments.add })
  const { editor, draft, replaceText } = document
  const submission = useComposerSubmission({ sessionId, draftCwd, isDraftSession, document, attachments })
  const commands = useSlashCommands(sessionId, draft.text, (command) => {
    replaceText(`/${command.name} `)
    editor?.commands.focus('end')
  })
  const hasDraft = Boolean(draft.text.trim() || draft.attachments.length > 0 || attachments.images.length > 0)

  useEffect(() => {
    if (!editor || !sessionId || queuedEditText == null) return
    replaceText(queuedEditText)
    clearQueuedEditText(sessionId)
    editor.commands.focus()
  }, [sessionId, clearQueuedEditText, editor, queuedEditText, replaceText])

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (commands.handleKeyDown(event)) return true
    if (
      event.key === 'Tab' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey &&
      isStreaming && hasDraft
    ) {
      event.preventDefault()
      void submission.send('steer')
      return true
    }
    if (event.key !== 'Enter') return false
    const sendNow = sendShortcut === 'enter' ? !event.shiftKey : event.shiftKey
    if (!sendNow) return false
    event.preventDefault()
    void submission.send()
    return true
  }

  return { sessionId, isDraftSession, isStreaming, editor, hasDraft, commands, attachments, ...submission }
}
