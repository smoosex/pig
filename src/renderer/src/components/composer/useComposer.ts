import { useEffect, useLayoutEffect, useState } from 'react'
import { useSessionsStore, selectActiveSessionCwd, selectActiveSessionId } from '../../stores/sessions'
import { useSettingsStore } from '../../stores/settings'
import { matchesShortcut } from '../../lib/shortcuts'
import { useComposerEditor } from './useComposerEditor'
import { useComposerImages } from './useComposerImages'
import { useFileMentions } from './useFileMentions'
import { useSlashCommands } from './useSlashCommands'
import { useComposerSubmission } from './useComposerSubmission'
import { useComposerDraftsStore } from '../../stores/composer-drafts'
import { useSystemUIStore } from '../../stores/system-ui'

/** Coordinates session-owned drafts with pane-local editors and attachment previews. */
export function useComposer(
  draftCwd?: string,
  draftSessionId?: string | null,
  explicitSessionId?: string | null,
  isActive = true
) {
  const activeSessionId = useSessionsStore(selectActiveSessionId)
  const effectiveActiveSessionId = (explicitSessionId != null && explicitSessionId !== '') ? explicitSessionId : activeSessionId
  const sessionId = effectiveActiveSessionId ?? draftSessionId ?? null
  const isDraftSession = Boolean(!effectiveActiveSessionId && draftCwd && draftSessionId)
  const reviewReturning = useSystemUIStore((state) => !!sessionId && !!state.returningReviewSessions[sessionId])
  // Sending into a branch while Pi summarizes or switches it would race the new leaf.
  const navigating = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.isNavigatingBranch ?? false) : false)
  const inputDisabled = reviewReturning || navigating
  const isStreaming = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.isStreaming ?? false) : false)
  const queuedEditText = useSessionsStore((s) => sessionId ? (s.runtime[sessionId]?.queuedEditText ?? null) : null)
  const clearQueuedEditText = useSessionsStore((s) => s.clearQueuedEditText)
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)
  // The home composer and the tab it becomes are the same session, so the slot key is that
  // session's id on both sides; keying the home by cwd alone would clear the editor on promote.
  const draftKey = sessionId ?? (draftCwd ? `draft:${draftCwd}` : null)
  const attachments = useComposerImages(draftKey)
  const document = useComposerEditor({ sessionId: draftKey, isActive, disabled: inputDisabled, onKeyDown: handleKeyDown, onPasteImages: attachments.add })
  const { editor, draft, replaceText } = document
  const restoreVersion = useComposerDraftsStore((state) => draftKey
    ? state.drafts[draftKey]?.restoreVersion ?? 0 : 0)
  const [bashModeKey, setBashModeKey] = useState<string | null>(() =>
    draftKey && useComposerDraftsStore.getState().drafts[draftKey]?.bashMode ? draftKey : null)
  const [dismissedBashKey, setDismissedBashKey] = useState<string | null>(() =>
    draftKey && useComposerDraftsStore.getState().drafts[draftKey]?.bashDismissed ? draftKey : null)
  useLayoutEffect(() => {
    setBashModeKey(draftKey && useComposerDraftsStore.getState().drafts[draftKey]?.bashMode ? draftKey : null)
    setDismissedBashKey(draftKey && useComposerDraftsStore.getState().drafts[draftKey]?.bashDismissed ? draftKey : null)
  }, [draftKey, restoreVersion])
  const enteringBash = Boolean(
    draftKey && draft.text.startsWith('!') && draft.attachments[0]?.start !== 0 &&
    bashModeKey !== draftKey && dismissedBashKey !== draftKey
  )
  const bashMode = (bashModeKey === draftKey && draftKey !== null) || enteringBash
  useLayoutEffect(() => {
    // Hydration ran earlier in layout effects; this render can still describe the previous session.
    if (!enteringBash || !editor || document.getDraft() !== draft) return
    setBashModeKey(draftKey)
    if (draftKey) useComposerDraftsStore.getState().setBashMode(draftKey, true)
    editor.chain().deleteRange({ from: 1, to: 2 }).run()
  }, [draftKey, editor, enteringBash, draft])
  useEffect(() => {
    if (document.getDraft() !== draft || draft.text.startsWith('!')) return
    setDismissedBashKey(null)
    if (draftKey && useComposerDraftsStore.getState().drafts[draftKey]?.bashDismissed) {
      useComposerDraftsStore.getState().setBashMode(draftKey, false)
    }
  }, [draft, draftKey])
  const submission = useComposerSubmission({
    sessionId, draftCwd, isDraftSession, document, attachments, bashMode,
    onBashSubmitted: () => {
      setBashModeKey(null)
      if (draftKey) useComposerDraftsStore.getState().setBashMode(draftKey, false)
    }
  })
  const commands = useSlashCommands(sessionId, draft.text, (command) => {
    replaceText(`/${command.name} `)
    editor?.commands.focus('end')
  }, bashMode || inputDisabled)
  // A draft is its own workspace; a tab reads the workspace off the session behind it.
  const activeCwd = useSessionsStore((state) => explicitSessionId
    ? state.openTabs.find((tab) => tab.id === explicitSessionId)?.cwd ?? null
    : selectActiveSessionCwd(state))
  const mentionCwd = (isDraftSession ? draftCwd : activeCwd) ?? draftCwd ?? null
  const mentions = useFileMentions({ resetKey: sessionId, cwd: mentionCwd, editor, disabled: commands.open || bashMode || inputDisabled })
  const hasDraft = Boolean(draft.text.trim() || draft.attachments.length > 0 || attachments.images.length > 0)

  useEffect(() => {
    if (!editor || !sessionId || queuedEditText == null) return
    replaceText(queuedEditText)
    clearQueuedEditText(sessionId)
    editor.commands.focus()
  }, [sessionId, clearQueuedEditText, editor, queuedEditText, replaceText])

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (inputDisabled) return false
    // The editor is already focused; consuming it keeps a bound Enter combination from sending.
    if (matchesShortcut(event, 'composer.focus')) {
      event.preventDefault()
      return true
    }
    if (bashMode && event.key === 'Escape') {
      event.preventDefault()
      setDismissedBashKey(draftKey)
      setBashModeKey(null)
      if (draftKey) useComposerDraftsStore.getState().setBashMode(draftKey, false, true)
      document.restoreBashPrefix()
      return true
    }
    if (commands.handleKeyDown(event)) return true
    if (mentions.handleKeyDown(event)) return true
    if (
      event.key === 'Tab' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey &&
      isStreaming && hasDraft && !bashMode
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

  return { sessionId, isDraftSession, isStreaming, inputDisabled, bashMode, canRunBash: Boolean((enteringBash ? draft.text.slice(1) : draft.text).trim()), editor, hasDraft, commands, mentions, attachments, ...submission }
}
