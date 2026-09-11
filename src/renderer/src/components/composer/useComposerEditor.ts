import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor } from '@tiptap/react'
import type { JSONContent } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { createPastedTextFilename, isLongPastedText, utf8ByteLength } from '../../../../shared/pasted-text'
import { PastedTextNode } from '../PastedTextNode'
import { EMPTY_COMPOSER, serializeComposerDocument, textToComposerDocument } from './document'
import { clipboardImages } from './useComposerImages'

interface ComposerEditorOptions {
  sessionId: string | null
  onKeyDown: (event: KeyboardEvent) => boolean
  onPasteImages: (files: File[]) => Promise<void>
}

/** Keeps Tiptap, clipboard input, and IME handling behind one editor boundary. */
export function useComposerEditor(options: ComposerEditorOptions) {
  const [draft, setDraft] = useState(EMPTY_COMPOSER)
  const currentDraft = useRef(draft)
  const callbacks = useRef(options)
  const composing = useRef(false)
  const compositionFrame = useRef<number | null>(null)
  callbacks.current = options

  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: '⌘L to focus chat' }), PastedTextNode],
    content: textToComposerDocument(''),
    onUpdate: ({ editor: nextEditor }) => {
      const next = serializeComposerDocument(nextEditor.getJSON())
      currentDraft.current = next
      setDraft(next)
    },
    editorProps: {
      attributes: {
        'data-slot': 'input-group-control',
        'aria-label': '消息',
        'aria-multiline': 'true',
        class: 'min-h-16 outline-none whitespace-pre-wrap break-words'
      },
      handleDOMEvents: {
        compositionstart: () => {
          if (compositionFrame.current != null) cancelAnimationFrame(compositionFrame.current)
          composing.current = true
          return false
        },
        compositionend: () => {
          // Some IMEs dispatch Enter before the composition-end frame completes.
          compositionFrame.current = requestAnimationFrame(() => {
            composing.current = false
            compositionFrame.current = null
          })
          return false
        }
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || composing.current || event.keyCode === 229) return false
        return callbacks.current.onKeyDown(event)
      },
      handlePaste: (view, event) => {
        const pastedText = event.clipboardData?.getData('text/plain') ?? ''
        const files = clipboardImages(event)
        const longText = isLongPastedText(pastedText)
        if (longText) {
          event.preventDefault()
          const node = view.state.schema.nodes.pastedText.create({
            id: crypto.randomUUID(),
            text: pastedText,
            byteSize: utf8ByteLength(pastedText),
            filename: createPastedTextFilename()
          })
          view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
        }
        if (files.length > 0) {
          if (!pastedText) event.preventDefault()
          void callbacks.current.onPasteImages(files)
        }
        return longText || (!pastedText && files.length > 0)
      }
    }
  })

  const clear = useCallback(() => {
    currentDraft.current = EMPTY_COMPOSER
    setDraft(EMPTY_COMPOSER)
    editor?.commands.clearContent(false)
  }, [editor])

  const replaceText = useCallback((text: string) => {
    editor?.commands.setContent(textToComposerDocument(text))
  }, [editor])

  const restore = useCallback((content: JSONContent) => {
    if (!editor?.isDestroyed) editor?.commands.setContent(content)
  }, [editor])

  useEffect(() => {
    clear()
    editor?.setEditable(Boolean(options.sessionId))
  }, [options.sessionId, editor, clear])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        event.key.toLowerCase() !== 'l' || event.isComposing || event.keyCode === 229 ||
        event.defaultPrevented
      ) return
      event.preventDefault()
      if (!event.repeat) editor?.commands.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editor])

  useEffect(() => () => {
    if (compositionFrame.current != null) cancelAnimationFrame(compositionFrame.current)
  }, [])

  return { editor, draft, getDraft: () => currentDraft.current, clear, replaceText, restore }
}
