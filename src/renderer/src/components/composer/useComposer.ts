import { useEffect } from 'react'
import { useSessionsStore, selectActiveSessionCwd, selectActiveSessionId } from '../../stores/sessions'
import { useSettingsStore } from '../../stores/settings'
import { useComposerEditor } from './useComposerEditor'
import { useComposerImages } from './useComposerImages'
import { useFileMentions } from './useFileMentions'
import { useSlashCommands } from './useSlashCommands'
import { useComposerSubmission } from './useComposerSubmission'

/** Coordinates a draft with the active Pi session; editor and attachment state stay local. */
export function useComposer(draftCwd?: string, draftSessionId?: string | null) {
  const activeSessionId = useSessionsStore(selectActiveSessionId)
  const sessionId = activeSessionId ?? draftSessionId ?? null
  const isDraftSession = Boolean(!activeSessionId && draftCwd && draftSessionId)
  const isStreaming = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.isStreaming ?? false) : false)
  const queuedEditText = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.queuedEditText ?? null) : null)
  const clearQueuedEditText = useSessionsStore((s) => s.clearQueuedEditText)
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)
  // The home composer and the tab it becomes are the same session, so the slot key is that
  // session's id on both sides; keying the home by cwd alone would clear the editor on promote.
  const draftKey = sessionId ?? (draftCwd ? `draft:${draftCwd}` : null)
  const attachments = useComposerImages(draftKey)
  const document = useComposerEditor({ sessionId: draftKey, onKeyDown: handleKeyDown, onPasteImages: attachments.add })
  const { editor, draft, replaceText } = document
  const submission = useComposerSubmission({ sessionId, draftCwd, isDraftSession, document, attachments })
  const commands = useSlashCommands(sessionId, draft.text, (command) => {
    replaceText(`/${command.name} `)
    editor?.commands.focus('end')
  })
  // A draft is its own workspace; a tab reads the workspace off the session behind it.
  const activeCwd = useSessionsStore(selectActiveSessionCwd)
  const mentionCwd = (isDraftSession ? draftCwd : activeCwd) ?? draftCwd ?? null
  const mentions = useFileMentions({ resetKey: sessionId, cwd: mentionCwd, editor, disabled: commands.open })
  const hasDraft = Boolean(draft.text.trim() || draft.attachments.length > 0 || attachments.images.length > 0)

  useEffect(() => {
    if (!editor || !sessionId || queuedEditText == null) return
    replaceText(queuedEditText)
    clearQueuedEditText(sessionId)
    editor.commands.focus()
  }, [sessionId, clearQueuedEditText, editor, queuedEditText, replaceText])

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (commands.handleKeyDown(event)) return true
    if (mentions.handleKeyDown(event)) return true
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

  return { sessionId, isDraftSession, isStreaming, editor, hasDraft, commands, mentions, attachments, ...submission }
}
