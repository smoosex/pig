import type { RestoredSessionPrompt } from '../../ipc/api'
import { restoredPromptToComposerDocument } from '../../components/composer/document'
import { useComposerDraftsStore } from '../composer-drafts'

export function restorePromptDraft(sessionId: string, prompt: RestoredSessionPrompt): void {
  useComposerDraftsStore.getState().restoreDraft(sessionId, {
    content: restoredPromptToComposerDocument(prompt.text, prompt.textAttachments, prompt.fileMentions),
    images: prompt.images.map((image) => ({ ...image, id: crypto.randomUUID() }))
  })
}
