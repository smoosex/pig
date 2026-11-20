import { Activity, useEffect, useMemo, useRef } from 'react'
import { EditorContent } from '@tiptap/react'
import { motion, useReducedMotion } from 'motion/react'
import { Folder, GitBranch } from 'lucide-react'
import { chatColumn } from '../chat/layout'
import { cn } from '../lib/utils'
import { useT } from '../hooks/useT'
import { Button } from './ui/button'
import { Popover, PopoverAnchor } from './ui/popover'
import { FollowUpQueue } from './FollowUpQueue'
import { ImagePreview } from './ImagePreview'
import { ApprovalPrompt, useApprovalPrompt } from './composer/ApprovalPrompt'
import { CompactionStatus } from './composer/CompactionStatus'
import { ComposerImages } from './composer/ComposerImages'
import { ComposerToolbar } from './composer/ComposerToolbar'
import { MentionSuggestions } from './composer/MentionSuggestions'
import { FileMentionContext } from './FileMentionChip'
import { ReviewFeedback } from './composer/ReviewFeedback'
import { RetryNotice } from './composer/RetryNotice'
import { SlashSuggestions } from './composer/SlashSuggestions'
import { SteerHint } from './composer/SteerHint'
import { useWorkspaceVisible } from './WorkspaceLayout'
import { useComposer } from './composer/useComposer'
import { ComposerSurface, composerTextLayout } from './composer/ComposerSurface'
import { TAB_REFERENCE_DROP } from './composer/tab-reference'
import { tabMentions, type TabMention } from './composer/tab-mentions'
import { useSessionsStore } from '../stores/sessions'

/** Composes the input surface; session commands and editor lifecycle live in hooks. */
export function Composer({
  draftCwd,
  draftSessionId,
  explicitSessionId,
  isActive: paneActive = true,
  centered = false,
  workspace
}: {
  centered?: boolean
  draftCwd?: string
  draftSessionId?: string | null
  explicitSessionId?: string | null
  isActive?: boolean
  workspace?: { project: string; branch: string } | null
} = {}) {
  const t = useT()
  const visible = useWorkspaceVisible()
  const isActive = paneActive && visible
  const { sessionId, isDraftSession, isStreaming, inputDisabled, bashMode, canRunBash, editor, hasDraft, commands, mentions, attachments, send, abort, error, canRestore, restore } = useComposer(draftCwd, draftSessionId, explicitSessionId, isActive)
  const mentionContext = useMemo(() => ({ cwd: mentions.cwd, sessionId: sessionId ?? null }), [mentions.cwd, sessionId])
  const boxRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  const approval = useApprovalPrompt(sessionId)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onDrop = (event: Event) => {
      if (!editor || inputDisabled || bashMode || approval !== undefined) return
      const { reference, x, y } = (event as CustomEvent<{ reference: TabMention; x: number; y: number }>).detail
      const { openTabs, chatDraft } = useSessionsStore.getState()
      if (!tabMentions(openTabs, sessionId, mentions.cwd, chatDraft?.sessionId)
        .some((item) => item.kind === reference.kind && item.id === reference.id)) return
      const position = editor.view.posAtCoords({ left: x, top: y })?.pos ?? editor.state.selection.from
      editor.chain().focus().insertContentAt(position, [{ type: 'tabMention', attrs: reference }, { type: 'text', text: ' ' }]).run()
    }
    box.addEventListener(TAB_REFERENCE_DROP, onDrop)
    return () => box.removeEventListener(TAB_REFERENCE_DROP, onDrop)
  }, [editor, inputDisabled, bashMode, approval, sessionId, mentions.cwd])
  // Answering hands the keyboard back to the prompt it replaced.
  const hadApproval = useRef(false)
  useEffect(() => {
    if (hadApproval.current && !approval && isActive) editor?.commands.focus()
    hadApproval.current = approval !== undefined
  }, [approval, editor, isActive])
  // A home draft keeps its id when it becomes a tab, so an unchanged id means the same conversation got its first
  // message. A changed id is a tab switch: the transcript appears at once, and the box must not trail behind it.
  const renderedSessionId = useRef(sessionId)
  const switchedSession = renderedSessionId.current !== sessionId
  useEffect(() => {
    renderedSessionId.current = sessionId
  }, [sessionId])

  return (
    // Home screens and empty sessions centre the box; only the same session leaving that state glides it to the
    // bottom. Tab switches, queue growth, resizes and pane changes stay instant.
    <motion.div
      layout="position"
      layoutDependency={centered}
      transition={{ duration: reducedMotion || switchedSession ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] }}
      className={cn(chatColumn, '@container/composer-column relative isolate shrink-0 pb-3.5')}
    >
      <Activity mode={visible ? 'visible' : 'hidden'}>
      <FollowUpQueue key={sessionId ?? 'none'} sessionId={sessionId} />
      <CompactionStatus sessionId={sessionId} />
      <RetryNotice sessionId={sessionId} />
      <ReviewFeedback sessionId={sessionId} />
      <ApprovalPrompt sessionId={sessionId} autoFocus={isActive} />
      </Activity>
      {/* Hidden rather than unmounted while a permission request stands in for it, keeping the draft. */}
      <Popover open={visible && !approval && (commands.open || mentions.open)} onOpenChange={(open) => { if (!open) { commands.dismiss(); mentions.dismiss() } }}>
        <PopoverAnchor asChild>
          <ComposerSurface
            ref={boxRef}
            data-tab-reference-target
            hidden={approval !== undefined}
            visible={visible}
            bashMode={bashMode}
            streaming={isStreaming}
            before={<SteerHint visible={!inputDisabled && isStreaming && hasDraft && !bashMode && !commands.open && !mentions.open} />}
            toolbar={(
              <Activity mode={visible ? 'visible' : 'hidden'}>
                <ComposerToolbar
                  sessionId={sessionId}
                  isStreaming={isStreaming}
                  bashMode={bashMode}
                  canRunBash={canRunBash}
                  hasDraft={hasDraft}
                  isDraftSession={isDraftSession}
                  inputDisabled={inputDisabled}
                  onSend={send}
                  onAbort={abort}
                />
              </Activity>
            )}
          >
            {bashMode ? (
              <p role="status" className="px-3.5 pt-3 text-xs text-muted-foreground">
                {t('composer.bashModeHint')}
              </p>
            ) : null}
            <FileMentionContext.Provider value={mentionContext}>
              <EditorContent
                editor={editor}
                className={cn(composerTextLayout, '[&_.ProseMirror]:min-h-16 [&_.ProseMirror]:outline-none [&_.ProseMirror_p]:m-0 [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror:focus_.is-editor-empty:first-child::before]:hidden', bashMode && 'font-mono')}
              />
            </FileMentionContext.Provider>
            <ComposerImages images={attachments.images} onPreview={attachments.setPreview} onRemove={attachments.remove} disabled={inputDisabled} />
            {attachments.error ? <p role="alert" className="px-3.5 pb-1.5 text-xs text-destructive">{attachments.error}</p> : null}
            {error ? <p role="alert" className="px-3.5 pb-1.5 text-xs text-destructive">{error}</p> : null}
            {canRestore ? (
              <Button type="button" variant="link" size="xs" className="mx-2.5 mb-1.5" disabled={inputDisabled} onClick={restore}>
                {t('composer.restoreDraft')}
              </Button>
            ) : null}
          </ComposerSurface>
        </PopoverAnchor>
        {!approval && commands.open ? <SlashSuggestions commands={commands} anchorRef={boxRef} /> : null}
        {!approval && mentions.open ? <MentionSuggestions mentions={mentions} anchorRef={boxRef} /> : null}
      </Popover>
      {/* Where a new conversation will start matters before it exists; inside one the sidebar already says so. */}
      {centered && workspace ? (
        <div data-composer-status className="flex min-h-8 min-w-0 items-center gap-5 px-3.5 pt-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <Folder className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate" title={workspace.project}>{workspace.project}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate" title={workspace.branch}>{workspace.branch}</span>
          </span>
        </div>
      ) : null}
      <ImagePreview src={visible ? attachments.preview : null} onClose={() => attachments.setPreview(null)} />
    </motion.div>
  )
}
