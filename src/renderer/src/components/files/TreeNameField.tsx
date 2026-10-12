/**
 * The row a name is typed into: the field a new entry is made from, and the field a row is renamed in.
 *
 * It is a row of the tree rather than a dialog over it, so it stands exactly where the thing will be — a
 * new entry at the top of the directory it is being made in, a rename on the row itself — which is what
 * makes it obvious which directory the name lands in.
 *
 * The row keeps the icons its neighbours have, so the field lands under the names it belongs with rather
 * than beside them: a chevron where a folder row would have one, the gap a chevron would leave where a
 * file row has none, and the icon of whatever is being named.
 *
 * Enter commits and Escape abandons. So does a click somewhere else, and that is the part worth being
 * careful about: a menu hands the focus back to the row it was opened from a moment after it closes,
 * which lands on a field the reader is still looking at. Losing the focus is therefore not the same as
 * being left, and the two are told apart by what the reader did — a reader who means to leave reaches for
 * the pointer or the Tab key, and a menu handing focus back does neither.
 *
 * A composition is none of those things either: while an input method is still assembling a name, the Enter
 * that picks a candidate is the IME's and not the reader's, and taking it as a commit would send half a
 * name and close the field under them.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, File as FileIcon, Folder } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { Input } from '../ui/input'
import { FileTypeIcon } from './FileTypeIcon'

export function TreeNameField({
  initial,
  depth,
  /** Whether what is being named is a folder, which is what its row's icons say. */
  directory,
  /** The row being renamed, so its own file icon can stand in the field's row. */
  path,
  onCommit,
  onCancel
}: {
  initial: string
  depth: number
  directory: boolean
  path?: string
  onCommit: (name: string, unchanged: boolean) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const t = useT()
  /**
   * The field settles exactly once. Every way out unmounts it, and an unmount blurs a focused field, so
   * without this the blur would carry out a second, stale decision on its way past.
   */
  const settled = useRef(false)
  const ref = useRef<HTMLInputElement | null>(null)
  /**
   * Whether the reader has reached for the pointer or the Tab key since the field appeared.
   *
   * This is what tells a click away from a menu handing the focus back. The menu returns it to the row it
   * was opened from just after it closes — after this field has already taken it — so the hand-back
   * arrives as the field losing focus to something the reader never aimed at. A reader leaving always
   * reaches for the pointer or Tab first, and the menu's hand-back does neither, so that is the honest
   * difference between the two.
   */
  const reached = useRef(false)

  /**
   * The field takes the focus and starts on the name rather than the extension, the way every file
   * manager treats a rename.
   */
  useLayoutEffect(() => {
    const field = ref.current
    if (!field) return
    field.focus()
    const cut = initial ? field.value.lastIndexOf('.') : -1
    field.setSelectionRange(0, cut > 0 ? cut : field.value.length)
  }, [initial])

  /**
   * Holds the keyboard until the reader asks for something else.
   *
   * A menu gives the focus back to the row it was opened from a moment after it closes, and it does that
   * after this field has taken the focus — so waiting a turn and taking it again is a race, and one this
   * would lose as often as win. Watching the focus instead is not a race at all: whatever else takes it
   * while the reader has done nothing yet is the app tidying up after itself, and the field simply takes
   * it back. The moment they reach for the pointer or Tab, this stops and the field behaves normally.
   */
  useLayoutEffect(() => {
    const noteReach = (event: Event) => {
      if ((event as KeyboardEvent).key === 'Tab') reached.current = true
    }
    const markReached = () => {
      reached.current = true
    }
    const holdKeyboard = (event: Event) => {
      // Taking the focus back fires this again; there is nothing to do when the field already has it.
      if (event.target === ref.current) return
      if (reached.current || settled.current) return
      ref.current?.focus()
    }
    document.addEventListener('pointerdown', markReached, true)
    document.addEventListener('keydown', noteReach, true)
    document.addEventListener('focusin', holdKeyboard, true)
    return () => {
      document.removeEventListener('pointerdown', markReached, true)
      document.removeEventListener('keydown', noteReach, true)
      document.removeEventListener('focusin', holdKeyboard, true)
    }
  }, [])

  const commit = () => {
    if (settled.current) return
    settled.current = true
    const trimmed = name.trim()
    // An empty name is not a name: there is nothing to make and nothing to rename.
    if (!trimmed) {
      onCancel()
      return
    }
    onCommit(trimmed, trimmed === initial)
  }

  const cancel = () => {
    if (settled.current) return
    settled.current = true
    onCancel()
  }

  return (
    <div
      className="relative flex w-full items-center gap-1.5 rounded-sm py-1 pr-1"
      style={{ paddingInlineStart: `${4 + depth * 12}px` }}
    >
      {directory ? (
        <ChevronRight className="size-3.5 shrink-0" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      {directory ? (
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
      ) : path ? (
        <FileTypeIcon path={path} className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <Input
        ref={ref}
        value={name}
        // A rename names itself; a field for a new entry has no name yet, so it says what it is for.
        aria-label={initial || t(directory ? 'file.newFolderLabel' : 'file.newFileLabel')}
        spellCheck={false}
        onChange={(event) => setName(event.target.value)}
        // The tree's own keyboard walks rows; while a field is open the arrows belong to the text.
        onKeyDown={(event) => {
          // An input method's Enter picks a candidate rather than finishing the name.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancel()
          }
          event.stopPropagation()
        }}
        onBlur={() => {
          // The focus leaving is not the reader leaving: a menu gives it back to the row it was opened
          // from without the reader reaching for anything, and that must not end the field.
          if (!reached.current) return
          commit()
        }}
        className="h-5 min-w-0 flex-1 rounded-xs px-1 py-0 text-xs md:text-xs"
      />
    </div>
  )
}
