import { useEffect, useMemo, useRef, useState } from 'react'
import { BorderBeam } from '@smoose/border-beam'
import { EditorContent } from '@tiptap/react'
import { motion, useReducedMotion } from 'motion/react'
import { Folder, GitBranch } from 'lucide-react'
import { chatColumn } from '../chat/layout'
import { cn } from '../lib/utils'
import { useT } from '../hooks/useT'
import { useSettingsStore } from '../stores/settings'
import { InputGroup } from './ui/input-group'
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
import { RetryNotice } from './composer/RetryNotice'
import { SlashSuggestions } from './composer/SlashSuggestions'
import { SteerHint } from './composer/SteerHint'
import { useComposer } from './composer/useComposer'
import { useComposerAppearance } from './composer/useComposerAppearance'
import { TAB_REFERENCE_DROP } from './composer/tab-reference'
import type { TabMention } from './composer/tab-mentions'

/** Composes the input surface; session commands and editor lifecycle live in hooks. */
export function Composer({
  draftCwd,
  draftSessionId,
  explicitSessionId,
  isActive = true,
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
  const { sessionId, isDraftSession, isStreaming, inputDisabled, bashMode, canRunBash, editor, hasDraft, commands, mentions, attachments, send, abort, error, canRestore, restore } = useComposer(draftCwd, draftSessionId, explicitSessionId, isActive)
  const appearance = useComposerAppearance()
  const mentionContext = useMemo(() => ({ cwd: mentions.cwd, sessionId: sessionId ?? null }), [mentions.cwd, sessionId])
  const beamBorderEnabled = useSettingsStore((s) => s.beamBorderEnabled)
  const [focused, setFocused] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  const approval = useApprovalPrompt(sessionId)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onDrop = (event: Event) => {
      if (!editor || inputDisabled || bashMode || approval !== undefined) return
      const { reference, x, y } = (event as CustomEvent<{ reference: TabMention; x: number; y: number }>).detail
      if (reference.kind === 'session' && reference.id === sessionId) return
      const position = editor.view.posAtCoords({ left: x, top: y })?.pos ?? editor.state.selection.from
      editor.chain().focus().insertContentAt(position, [{ type: 'tabMention', attrs: reference }, { type: 'text', text: ' ' }]).run()
    }
    box.addEventListener(TAB_REFERENCE_DROP, onDrop)
    return () => box.removeEventListener(TAB_REFERENCE_DROP, onDrop)
  }, [editor, inputDisabled, bashMode, approval, sessionId])
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
      <FollowUpQueue key={sessionId ?? 'none'} sessionId={sessionId} />
      <CompactionStatus sessionId={sessionId} />
      <RetryNotice sessionId={sessionId} />
      <ApprovalPrompt sessionId={sessionId} autoFocus={isActive} />
      {/* Hidden rather than unmounted while a permission request stands in for it, keeping the draft. */}
      <Popover open={!approval && (commands.open || mentions.open)} onOpenChange={(open) => { if (!open) { commands.dismiss(); mentions.dismiss() } }}>
        <PopoverAnchor asChild>
          <div ref={boxRef} data-tab-reference-target hidden={approval !== undefined} className="relative rounded-2xl shadow-glass-card solid:shadow-md">
            <SteerHint visible={!inputDisabled && isStreaming && hasDraft && !bashMode && !commands.open && !mentions.open} />
            <div className="relative z-10">
              <BorderBeam size={bashMode ? 'pulse-inner' : 'md'} {...appearance} active={beamBorderEnabled && (bashMode || focused || isStreaming)} className="w-full">
                <InputGroup
                  className="@container/composer min-h-[min(8rem,calc(100dvh-6rem))] max-h-[min(16rem,calc(100dvh-6rem))] overflow-hidden rounded-2xl border-[0.5px] border-glass-border solid:border-border bg-glass-composer-background/60! bg-(image:--glass-popover-sheen) shadow-glass-card-edge solid:bg-composer-background! solid:bg-none solid:shadow-none text-glass-prompt-foreground solid:text-foreground has-disabled:opacity-100 has-[[data-slot=input-group-control]:focus-visible]:border-glass-border solid:has-[[data-slot=input-group-control]:focus-visible]:border-border has-[[data-slot=input-group-control]:focus-visible]:ring-0 transition-[background-color,border-color] duration-200 ease-in-out motion-reduce:transition-none"
                  onFocus={() => setFocused(true)}
                  onBlur={(event) => {
                    const next = event.relatedTarget
                    if (next instanceof Node && event.currentTarget.contains(next)) return
                    setFocused(false)
                  }}
                >
                  <div className="min-h-0 w-full flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {bashMode ? (
                      <p role="status" className="px-3.5 pt-3 text-xs text-muted-foreground">
                        {t('composer.bashModeHint')}
                      </p>
                    ) : null}
                    <FileMentionContext.Provider value={mentionContext}>
                      <EditorContent
                        editor={editor}
                        className={cn('min-h-16 w-full shrink-0 px-3.5 pt-3 text-sm leading-snug [&_.ProseMirror]:min-h-16 [&_.ProseMirror]:outline-none [&_.ProseMirror_p]:m-0 [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror:focus_.is-editor-empty:first-child::before]:hidden', bashMode && 'font-mono')}
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
                  </div>
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
                </InputGroup>
              </BorderBeam>
            </div>
          </div>
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
      <ImagePreview src={attachments.preview} onClose={() => attachments.setPreview(null)} />
    </motion.div>
  )
}
