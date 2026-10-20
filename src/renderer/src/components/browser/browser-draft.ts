/** Annotation batches become one Markdown text attachment; screenshots append images. Existing draft nodes are kept. */
import type { BrowserAnnotation, BrowserScreenshot } from '../../../../shared/browser'
import { buildBrowserAnnotationsPrompt } from '../../../../shared/browser-annotations'
import { utf8ByteLength } from '../../../../shared/pasted-text'
import { base64Body } from '../../../../shared/session-images'
import type { FailedDraft } from '../../stores/composer-drafts'
import { textToComposerDocument } from '../composer/document'

export { buildBrowserAnnotationsPrompt }

export const BROWSER_MAX_DRAFT_IMAGES = 20
export const BROWSER_MAX_IMAGE_BYTES = 20 * 1024 * 1024

type ExistingDraft = Partial<FailedDraft> | undefined

export function appendBrowserScreenshotDraft(draft: ExistingDraft, screenshot: BrowserScreenshot): FailedDraft {
  const body = base64Body(screenshot.data)
  if (!body || Math.floor(body.length * 3 / 4) > BROWSER_MAX_IMAGE_BYTES) {
    throw new Error('Browser screenshot is empty, invalid or exceeds 20 MB')
  }
  if ((draft?.images?.length ?? 0) >= BROWSER_MAX_DRAFT_IMAGES) {
    throw new Error('A draft can contain at most 20 browser images')
  }
  return {
    content: draft?.content ?? textToComposerDocument(''),
    images: [...(draft?.images ?? []), { id: crypto.randomUUID(), ...screenshot }]
  }
}

export function appendBrowserAnnotationsDraft(draft: ExistingDraft, annotations: BrowserAnnotation[], filename: string): FailedDraft {
  const text = buildBrowserAnnotationsPrompt(annotations)
  const attachment = { type: 'pastedText', attrs: { id: crypto.randomUUID(), text, byteSize: utf8ByteLength(text), filename } }
  const blocks = draft?.content?.content ?? []
  const last = blocks.at(-1)
  // Reuse a trailing empty paragraph so the chip sits where the caret would be.
  const content = last?.type === 'paragraph' && !last.content?.length
    ? [...blocks.slice(0, -1), { type: 'paragraph', content: [attachment] }]
    : [...blocks, { type: 'paragraph', content: [attachment] }]
  return {
    content: { ...(draft?.content ?? { type: 'doc' }), content },
    images: [...(draft?.images ?? [])]
  }
}
