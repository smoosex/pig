import { memo, useState } from 'react'
import { FileText } from 'lucide-react'
import { composePromptText, formatPastedTextSize } from '../../../../shared/pasted-text'
import type { PigImageContent, PigUserMessage, TextContent } from '../../pi/types'
import { turnImageSrc, type AnswerBlock } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Bubble, BubbleContent } from '../ui/bubble'
import { Button } from '../ui/button'
import { Message, MessageContent } from '../ui/message'
import { ImagePreview } from '../ImagePreview'
import { MarkdownText } from '../MarkdownText'
import { PastedTextChip } from '../PastedTextChip'
import { PastedTextPreview } from '../PastedTextPreview'
import { UserMessageActions } from './UserMessageActions'

function userText(message: PigUserMessage): string {
  if (message.pastedText) return message.pastedText.body
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function userImages(message: PigUserMessage): PigImageContent[] {
  if (typeof message.content === 'string') return []
  return message.content.filter((b): b is PigImageContent => b.type === 'image')
}

function InlinePastedText({
  segments
}: {
  segments: NonNullable<PigUserMessage['pastedText']>['segments']
}) {
  if (!segments) return null
  return (
    <div className="whitespace-pre-wrap break-words">
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <PastedTextChip
            key={segment.attachment.id}
            attachment={segment.attachment}
            className="mx-0.5"
          />
        )
      )}
    </div>
  )
}

export const UserBubble = memo(function UserBubble({
  message,
  sessionId,
  turnId
}: {
  message: PigUserMessage
  sessionId?: string
  turnId?: string
}) {
  const t = useT()
  const images = userImages(message).flatMap((image, i) => {
    const src = turnImageSrc(image)
    return src ? [{ key: i, src }] : []
  })
  const text = userText(message)
  const textAttachments = message.pastedText?.attachments ?? []
  const segments = message.pastedText?.segments
  const copyText = message.pastedText && !segments
    ? composePromptText(message.pastedText.body, textAttachments)
    : text
  const [preview, setPreview] = useState<string | null>(null)
  const hasTextBubble = Boolean(segments) || text.length > 0 || textAttachments.length > 0

  return (
    <Message align="end" className="group/user-message mb-4" data-turn-user="">
      <MessageContent className="w-fit max-w-9/10 gap-1.5">
        {images.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map(({ key, src }) => {
              return (
                <Button
                  key={key}
                  type="button"
                  variant="ghost"
                  className="block h-auto rounded-md p-0 hover:bg-transparent"
                  aria-label={t('composer.previewImage')}
                  onClick={() => setPreview(src)}
                >
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-10 max-w-16 cursor-pointer rounded-md object-cover"
                  />
                </Button>
              )
            })}
          </div>
        ) : null}
        {hasTextBubble ? (
          <Bubble align="end" className="max-w-full *:data-[slot=bubble-content]:bg-glass-popover-background *:data-[slot=bubble-content]:bg-[image:var(--glass-popover-sheen)] *:data-[slot=bubble-content]:text-glass-prompt-foreground *:data-[slot=bubble-content]:shadow-glass-bubble *:data-[slot=bubble-content]:transition-[background-color,box-shadow] *:data-[slot=bubble-content]:duration-200 *:data-[slot=bubble-content]:motion-reduce:transition-none solid:*:data-[slot=bubble-content]:bg-user-message-background solid:*:data-[slot=bubble-content]:bg-none solid:*:data-[slot=bubble-content]:text-user-message-foreground solid:*:data-[slot=bubble-content]:shadow-none">
            <BubbleContent
              className={cn(
                'flex max-w-full flex-col gap-2',
                (segments || textAttachments.length > 0) && 'border-border'
              )}
            >
              {segments ? <InlinePastedText segments={segments} /> : null}
              {!segments ? textAttachments.map((attachment) => (
                <PastedTextPreview
                  key={attachment.id}
                  text={attachment.text}
                  byteSize={attachment.byteSize}
                  title={attachment.filename}
                >
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto w-full min-w-0 max-w-full justify-start gap-2 rounded-lg px-2.5 py-2 text-left font-normal whitespace-normal"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <FileText data-icon="inline-start" />
                        <span>{attachment.filename ?? t('composer.pastedText')}</span>
                      </span>
                      <span className="line-clamp-3 max-h-15 block overflow-hidden whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {attachment.text}
                      </span>
                      <span className="mt-1 block text-[10px] text-muted-foreground">
                        UTF-8 {formatPastedTextSize(attachment.byteSize)}
                      </span>
                    </span>
                  </Button>
                </PastedTextPreview>
              )) : null}
              {!segments && text ? <div className="whitespace-pre-wrap">{text}</div> : null}
            </BubbleContent>
          </Bubble>
        ) : null}
        <UserMessageActions text={copyText} timestamp={message.timestamp} sessionId={sessionId} turnId={turnId} />
        <ImagePreview src={preview} onClose={() => setPreview(null)} />
      </MessageContent>
    </Message>
  )
})

export const Answer = memo(function Answer({ blocks, errorMessage }: { blocks: AnswerBlock[]; errorMessage?: string }) {
  if (blocks.length === 0 && !errorMessage) return null
  return (
    <Message align="start" className="mb-4">
      <MessageContent className="w-fit max-w-9/10 gap-1.5 px-1">
        {blocks.map((block, i) => {
          if (block.type === 'text') return <MarkdownText key={i} text={block.text} />
          const src = turnImageSrc(block.image)
          if (!src) return null
          return (
            <img
              key={i}
              className="my-1.5 block max-w-90 rounded-lg"
              src={src}
              loading="lazy"
              decoding="async"
              alt=""
            />
          )
        })}
        {errorMessage ? <div className="mt-1.5 text-xs text-destructive">{errorMessage}</div> : null}
      </MessageContent>
    </Message>
  )
})
