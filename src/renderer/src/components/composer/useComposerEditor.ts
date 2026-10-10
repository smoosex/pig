import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useEditor } from '@tiptap/react'
import { selectionToInsertionEnd, type JSONContent } from '@tiptap/core'
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { createPastedTextFilename, isLongPastedText, normalizeNewlines, utf8ByteLength } from '../../../../shared/pasted-text'
import { useT } from '../../hooks/useT'
import { PastedTextNode } from '../PastedTextNode'
import { EMPTY_COMPOSER, serializeComposerDocument, textToComposerDocument } from './document'
import { clipboardImages } from './useComposerImages'
import { useComposerDraftsStore } from '../../stores/composer-drafts'

interface ComposerEditorOptions {
  sessionId: string | null
  isActive?: boolean
  onKeyDown: (event: KeyboardEvent) => boolean
  onPasteImages: (files: File[]) => Promise<void>
}

/** Newlines become hard breaks so blank lines survive; the only deliberate transform is CRLF → LF. */
function plainTextSlice(schema: Schema, text: string): Slice {
  const content: ProseMirrorNode[] = []
  text.split('\n').forEach((line, index) => {
    if (index > 0) content.push(schema.nodes.hardBreak.create())
    if (line) content.push(schema.text(line))
  })
  return new Slice(Fragment.fromArray(content), 0, 0)
}

function insertPastedText(view: EditorView, text: string, at?: number): void {
  const { schema } = view.state
  const normalized = normalizeNewlines(text)
  const slice = isLongPastedText(normalized)
    ? Slice.maxOpen(Fragment.from(schema.nodes.pastedText.create({
        id: crypto.randomUUID(),
        text: normalized,
        byteSize: utf8ByteLength(normalized),
        filename: createPastedTextFilename()
      })))
    : plainTextSlice(schema, normalized)
  const { tr } = view.state
  if (at == null) {
    view.dispatch(tr.replaceSelection(slice).scrollIntoView())
    return
  }
  // A drop lands where the pointer was, not where the caret was, so the caret has to follow the
  // inserted content: mapping alone leaves it behind and the focus() below would light it up there.
  const startLength = tr.steps.length
  tr.replace(at, at, slice)
  selectionToInsertionEnd(tr, startLength, -1)
  view.dispatch(tr.scrollIntoView())
}

/** Keeps Tiptap, clipboard input, and IME handling behind one editor boundary. */
export function useComposerEditor(options: ComposerEditorOptions) {
  const t = useT()
  const [draft, setDraft] = useState(EMPTY_COMPOSER)
  const currentDraft = useRef(draft)
  const callbacks = useRef(options)
  const composing = useRef(false)
  const compositionFrame = useRef<number | null>(null)
  callbacks.current = options

  const editor = useEditor({
    // ProseMirror joins blocks with a blank line when it writes text/plain to the clipboard, which
    // would add one newline per paragraph on the way back in. The draft's own form is a single '\n'.
    coreExtensionOptions: { clipboardTextSerializer: { blockSeparator: '\n' } },
    extensions: [
      // The composer is a plain-text field: every node and mark that could render or carry
      // formatting is off, so neither input rules nor a stray HTML path can add any.
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        underline: false
      }),
      Placeholder.configure({ placeholder: '⌘L to focus chat' }),
      PastedTextNode
    ],
    content: textToComposerDocument(''),
    onUpdate: ({ editor: nextEditor }) => {
      const next = serializeComposerDocument(nextEditor.getJSON())
      currentDraft.current = next
      setDraft(next)
      const sessionId = callbacks.current.sessionId
      if (sessionId) useComposerDraftsStore.getState().setContent(sessionId, nextEditor.getJSON())
    },
    editorProps: {
      attributes: {
        'data-slot': 'input-group-control',
        'aria-label': t('composer.messageLabel'),
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
        },
        drop: (view, event) => {
          if (view.dragging) return false
          const drag = event as DragEvent
          const dropped = drag.dataTransfer?.getData('text/plain') ?? ''
          if (!dropped || (drag.dataTransfer?.files.length ?? 0) > 0) return false
          const at = view.posAtCoords({ left: drag.clientX, top: drag.clientY })?.pos ?? view.state.selection.from
          event.preventDefault()
          insertPastedText(view, dropped, at)
          view.focus()
          return true
        }
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || composing.current || event.keyCode === 229) return false
        return callbacks.current.onKeyDown(event)
      },
      handlePaste: (view, event) => {
        const data = event.clipboardData
        const pastedText = data?.getData('text/plain') ?? ''
        const markup = Boolean(data?.getData('text/html'))
        const files = clipboardImages(event)
        if (pastedText) {
          event.preventDefault()
          insertPastedText(view, pastedText)
        } else if (markup) {
          // Markup with no text behind it (styled wrappers, images): nothing worth importing.
          event.preventDefault()
        }
        if (files.length > 0) {
          if (!pastedText) event.preventDefault()
          void callbacks.current.onPasteImages(files)
        }
        return Boolean(pastedText || markup || files.length > 0)
      }
    }
  })

  const clear = useCallback(() => {
    currentDraft.current = EMPTY_COMPOSER
    setDraft(EMPTY_COMPOSER)
    editor?.commands.clearContent(false)
    const sessionId = callbacks.current.sessionId
    if (sessionId) useComposerDraftsStore.getState().setContent(sessionId, textToComposerDocument(''))
  }, [editor])

  const replaceText = useCallback((text: string) => {
    editor?.commands.setContent(textToComposerDocument(text))
  }, [editor])

  const restore = useCallback((content: JSONContent) => {
    if (!editor?.isDestroyed) editor?.commands.setContent(content)
  }, [editor])

  const restoreBashPrefix = useCallback(() => {
    if (!editor || editor.isDestroyed) return
    const { state, view } = editor
    const transaction = state.tr.insertText('!', 1)
    transaction.setSelection(TextSelection.between(
      transaction.doc.resolve(transaction.mapping.map(state.selection.anchor, 1)),
      transaction.doc.resolve(transaction.mapping.map(state.selection.head, 1))
    ))
    view.dispatch(transaction)
  }, [editor])

  useLayoutEffect(() => {
    const content = (options.sessionId
      ? useComposerDraftsStore.getState().drafts[options.sessionId]?.content
      : undefined) ?? textToComposerDocument('')
    editor?.commands.setContent(content, { emitUpdate: false })
    const next = serializeComposerDocument(content)
    currentDraft.current = next
    setDraft(next)
    editor?.setEditable(Boolean(options.sessionId))
  }, [options.sessionId, editor])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (callbacks.current.isActive === false) return
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

  return { editor, draft, getDraft: () => currentDraft.current, clear, replaceText, restore, restoreBashPrefix }
}
