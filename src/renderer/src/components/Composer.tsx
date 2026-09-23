import { useRef, useState } from 'react'
import { BorderBeam } from '@smoose/border-beam'
import { EditorContent } from '@tiptap/react'
import { Folder, GitBranch } from 'lucide-react'
import { chatColumn } from '../chat/layout'
import { cn } from '../lib/utils'
import { useT } from '../hooks/useT'
import { InputGroup } from './ui/input-group'
import { Button } from './ui/button'
import { Popover, PopoverAnchor } from './ui/popover'
import { FollowUpQueue } from './FollowUpQueue'
import { ImagePreview } from './ImagePreview'
import { ComposerImages } from './composer/ComposerImages'
import { ComposerToolbar } from './composer/ComposerToolbar'
import { MentionSuggestions } from './composer/MentionSuggestions'
import { SlashSuggestions } from './composer/SlashSuggestions'
import { SteerHint } from './composer/SteerHint'
import { useComposer } from './composer/useComposer'
import { useComposerAppearance } from './composer/useComposerAppearance'

/** Composes the input surface; session commands and editor lifecycle live in hooks. */
export function Composer({
  draftCwd,
  draftSessionId,
  workspace
}: {
  draftCwd?: string
  draftSessionId?: string | null
  workspace?: { project: string; branch: string } | null
} = {}) {
  const t = useT()
  const { sessionId, isDraftSession, isStreaming, editor, hasDraft, commands, mentions, attachments, send, abort, error, canRestore, restore } = useComposer(draftCwd, draftSessionId)
  const appearance = useComposerAppearance()
  const [focused, setFocused] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  return (
    <div className={cn(chatColumn, 'relative isolate shrink-0 pb-3.5')}>
      <FollowUpQueue key={sessionId ?? 'none'} sessionId={sessionId} />
      <Popover open={commands.open || mentions.open} onOpenChange={(open) => { if (!open) { commands.dismiss(); mentions.dismiss() } }}>
        <PopoverAnchor asChild>
          <div ref={boxRef} className="relative rounded-2xl shadow-md">
            <SteerHint visible={isStreaming && hasDraft && !commands.open && !mentions.open} />
            <div className="relative z-10">
              <BorderBeam size="md" {...appearance} active={focused || isStreaming} className="w-full">
                <InputGroup
                  className="min-h-[min(8rem,calc(100dvh-6rem))] max-h-[min(16rem,calc(100dvh-6rem))] overflow-hidden rounded-2xl border-[0.5px] border-border bg-composer-background has-disabled:bg-composer-background has-disabled:opacity-100 has-[[data-slot=input-group-control]:focus-visible]:border-border has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-composer-background dark:has-disabled:bg-composer-background"
                  onFocus={() => setFocused(true)}
                  onBlur={(event) => {
                    const next = event.relatedTarget
                    if (next instanceof Node && event.currentTarget.contains(next)) return
                    setFocused(false)
                  }}
                >
                  <div className="min-h-0 w-full flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    <EditorContent
                      editor={editor}
                      className="min-h-16 w-full shrink-0 px-3.5 pt-3 text-sm leading-snug [&_.ProseMirror]:min-h-16 [&_.ProseMirror]:outline-none [&_.ProseMirror_p]:m-0 [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror:focus_.is-editor-empty:first-child::before]:hidden"
                    />
                    <ComposerImages images={attachments.images} onPreview={attachments.setPreview} onRemove={attachments.remove} />
                    {attachments.error ? <p role="alert" className="px-3.5 pb-1.5 text-xs text-destructive">{attachments.error}</p> : null}
                    {error ? <p role="alert" className="px-3.5 pb-1.5 text-xs text-destructive">{error}</p> : null}
                    {canRestore ? (
                      <Button type="button" variant="link" size="xs" className="mx-2.5 mb-1.5" onClick={restore}>
                        {t('composer.restoreDraft')}
                      </Button>
                    ) : null}
                  </div>
                  <ComposerToolbar
                    sessionId={sessionId}
                    isStreaming={isStreaming}
                    hasDraft={hasDraft}
                    isDraftSession={isDraftSession}
                    onSend={send}
                    onAbort={abort}
                  />
                </InputGroup>
              </BorderBeam>
            </div>
          </div>
        </PopoverAnchor>
        {commands.open ? <SlashSuggestions commands={commands} anchorRef={boxRef} /> : null}
        {mentions.open ? <MentionSuggestions mentions={mentions} anchorRef={boxRef} /> : null}
      </Popover>
      {workspace ? (
        <div className="flex min-w-0 items-center gap-5 px-3.5 pt-2 text-xs text-muted-foreground">
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
    </div>
  )
}
