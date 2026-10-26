import type { ShortcutActionId } from '../../../shared/shortcuts'
import { IS_MAC, shortcutLabel, useShortcut } from '../lib/shortcuts'
import { Kbd } from './ui/kbd'

/** The action's current key for a tooltip; nothing when the user disabled it. */
export function ShortcutKbd({ action }: { action: ShortcutActionId }) {
  const accelerator = useShortcut(action)
  if (!accelerator) return null
  return <Kbd className="bg-transparent!">{shortcutLabel(accelerator).join(IS_MAC ? ' ' : '+')}</Kbd>
}
