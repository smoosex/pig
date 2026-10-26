import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  defaultShortcut,
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFINITIONS,
  shortcutProblem,
  type ShortcutActionId,
  type ShortcutGroup,
  type ShortcutPatch,
  type ShortcutProblem
} from '../../../../shared/shortcuts'
import type { SendShortcut } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { eventAccelerator, IS_MAC, setShortcutRecording, shortcutLabel, useShortcutBindings } from '../../lib/shortcuts'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../stores/settings'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { Kbd, KbdGroup } from '../ui/kbd'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SettingsCard, SettingsRow } from './SettingsFields'

const GROUPS: ShortcutGroup[] = ['global', 'tabs', 'composer', 'file', 'terminal', 'projectPicker']

/** What the recorder shows: a rejected key keeps recording, a conflict waits for the user's choice. */
type Attempt = { accelerator: string; problem: ShortcutProblem }

function Keys({ accelerator }: { accelerator: string }) {
  return (
    <KbdGroup>
      {shortcutLabel(accelerator).map((part, index) => <Kbd key={index}>{part}</Kbd>)}
    </KbdGroup>
  )
}

function ShortcutRow({ id }: { id: ShortcutActionId }) {
  const t = useT()
  const bindings = useShortcutBindings()
  const setShortcuts = useSettingsStore((s) => s.setShortcuts)
  const [recording, setRecording] = useState(false)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const current = bindings[id]
  const fallback = defaultShortcut(id, IS_MAC)
  const name = t(`shortcuts.actions.${id}`)
  // A hand-edited file can hold a conflict the recorder would have refused.
  const existing = current ? shortcutProblem(id, current, bindings) : null

  const save = (patch: ShortcutPatch) => {
    setAttempt(null)
    void setShortcuts(patch)
  }

  useEffect(() => {
    if (!recording) return
    setShortcutRecording(true)
    // Capture on window, registered after every other listener: it swallows the key before the
    // settings page's Escape or any shortcut sees it. Those also check the recording flag.
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.isComposing || event.keyCode === 229 || event.repeat) return
      const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      if (bare && event.code === 'Escape') {
        setRecording(false)
        setAttempt(null)
        return
      }
      if (bare && (event.code === 'Backspace' || event.code === 'Delete')) {
        setRecording(false)
        save({ [id]: null })
        return
      }
      const accelerator = eventAccelerator(event)
      if (!accelerator) return
      if (accelerator === current) {
        setRecording(false)
        setAttempt(null)
        return
      }
      const problem = shortcutProblem(id, accelerator, bindings)
      if (!problem) {
        setRecording(false)
        save({ [id]: accelerator })
        return
      }
      setAttempt({ accelerator, problem })
      if (problem.kind === 'conflict') setRecording(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      setShortcutRecording(false)
    }
  }, [recording, bindings, current, id])

  const problem = attempt?.problem ?? existing
  const description = !problem
    ? recording ? t('shortcuts.recordHint') : ''
    : problem.kind === 'conflict'
      ? t('shortcuts.conflict', { action: t(`shortcuts.actions.${problem.with}`) })
      : t(problem.kind === 'reserved' ? 'shortcuts.reserved' : 'shortcuts.needsModifier')

  return (
    <SettingsRow title={name} description={description}>
      <div className="flex items-center gap-1">
        {attempt?.problem.kind === 'conflict' ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setAttempt(null)}>{t('common.cancel')}</Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => save({ [id]: attempt.accelerator, [(attempt.problem as { with: ShortcutActionId }).with]: null })}
            >
              {t('shortcuts.replace')}
            </Button>
          </>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          aria-label={t('shortcuts.edit', { action: name })}
          aria-pressed={recording}
          className={cn('min-w-28 justify-center', recording && 'ring-2 ring-ring', problem && 'text-destructive')}
          onClick={() => {
            setAttempt(null)
            setRecording((value) => !value)
          }}
          onBlur={() => setRecording(false)}
        >
          {recording ? (
            attempt ? <Keys accelerator={attempt.accelerator} /> : <span className="text-muted-foreground">{t('shortcuts.record')}</span>
          ) : attempt ? (
            <Keys accelerator={attempt.accelerator} />
          ) : current ? (
            <Keys accelerator={current} />
          ) : (
            <span className="text-muted-foreground">{t('shortcuts.unset')}</span>
          )}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('shortcuts.reset')}
              className={cn(current === fallback && 'invisible')}
              onClick={() => save({ [id]: 'default' })}
            >
              <RotateCcw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {fallback ? t('shortcuts.resetTo', { key: shortcutLabel(fallback).join(IS_MAC ? '' : '+') }) : t('shortcuts.reset')}
          </TooltipContent>
        </Tooltip>
      </div>
    </SettingsRow>
  )
}

function SendShortcutRow() {
  const t = useT()
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)
  const setSendShortcut = useSettingsStore((s) => s.setSendShortcut)
  return (
    <SettingsRow
      title={t('settings.sendShortcut')}
      description={t('settings.sendShortcutDescription', { key: sendShortcut === 'enter' ? 'Shift+Enter' : 'Enter' })}
    >
      <Select value={sendShortcut} onValueChange={(value) => void setSendShortcut(value as SendShortcut)}>
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          <SelectGroup>
            <SelectItem value="enter">Enter</SelectItem>
            <SelectItem value="shift-enter">Shift+Enter</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </SettingsRow>
  )
}

export function ShortcutsPane() {
  const t = useT()
  const overrides = useSettingsStore((s) => s.shortcuts)
  const setShortcuts = useSettingsStore((s) => s.setShortcuts)
  const [confirmReset, setConfirmReset] = useState(false)

  return (
    <div className="flex flex-col gap-8">
      {GROUPS.map((group) => (
        <div key={group}>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t(`shortcuts.groups.${group}`)}
            </p>
            {group === 'global' ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={Object.keys(overrides).length === 0}
                onClick={() => setConfirmReset(true)}
              >
                <RotateCcw data-icon="inline-start" />
                {t('shortcuts.resetAll')}
              </Button>
            ) : null}
          </div>
          <SettingsCard>
            {group === 'composer' ? <SendShortcutRow /> : null}
            {SHORTCUT_ACTIONS.filter((id) => SHORTCUT_DEFINITIONS[id].group === group).map((id) => (
              <ShortcutRow key={id} id={id} />
            ))}
          </SettingsCard>
        </div>
      ))}
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('shortcuts.resetAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('shortcuts.resetAllDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void setShortcuts(Object.fromEntries(SHORTCUT_ACTIONS.map((id) => [id, 'default'])))}
            >
              {t('shortcuts.resetAll')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
