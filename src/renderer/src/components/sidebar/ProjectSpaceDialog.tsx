/**
 * Unified Pig-styled modal for creating, renaming, changing the icon of, or confirming
 * deletion of a Project Space.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import {
  PROJECT_SPACE_ICONS,
  fallbackSpaceId,
  resolveProjectSpaceId,
  type ProjectSpaceIcon
} from '../../../../shared/project-spaces'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import {
  spaceDisplayName,
  suggestNextSpaceName,
  useProjectSpacesStore
} from '../../stores/project-spaces'
import { useSessionsStore } from '../../stores/sessions'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { inputSurface } from '../ui/input-surface'
import { SpaceGlyph } from './space-icons'

export function ProjectSpaceDialog() {
  const t = useT()
  const dialog = useProjectSpacesStore((s) => s.dialog)
  const spaces = useProjectSpacesStore((s) => s.spaces)
  const assignments = useProjectSpacesStore((s) => s.assignments)
  const busy = useProjectSpacesStore((s) => s.busy)
  const error = useProjectSpacesStore((s) => s.error)
  const closeDialog = useProjectSpacesStore((s) => s.closeDialog)
  const createSpace = useProjectSpacesStore((s) => s.createSpace)
  const updateSpace = useProjectSpacesStore((s) => s.updateSpace)
  const removeSpace = useProjectSpacesStore((s) => s.removeSpace)
  const projects = useSessionsStore((s) => s.projects)

  const [name, setName] = useState('')
  const [icon, setIcon] = useState<ProjectSpaceIcon>('dot')
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const targetSpace =
    dialog && dialog.mode !== 'create'
      ? spaces.find((space) => space.id === dialog.spaceId)
      : undefined

  useEffect(() => {
    if (!dialog) return
    if (dialog.mode === 'create') {
      setName(suggestNextSpaceName(spaces, t))
      setIcon('dot')
      setIconPickerOpen(false)
    } else if (dialog.mode === 'rename' && targetSpace) {
      setName(spaceDisplayName(targetSpace, t))
      setIcon(targetSpace.icon ?? 'dot')
      setIconPickerOpen(false)
    } else if (dialog.mode === 'icon' && targetSpace) {
      setName(spaceDisplayName(targetSpace, t))
      setIcon(targetSpace.icon ?? 'dot')
      setIconPickerOpen(true)
    }
    if (dialog.mode === 'create' || dialog.mode === 'rename') {
      const frame = requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
      return () => cancelAnimationFrame(frame)
    }
    return undefined
  }, [dialog])

  if (!dialog) return null

  if (dialog.mode === 'delete') {
    if (!targetSpace) return null
    const remaining = spaces.filter((space) => space.id !== targetSpace.id)
    const fallback = remaining.find((space) => space.id === fallbackSpaceId(remaining)) ?? remaining[0]
    const projectCount = projects.filter(
      (project) => resolveProjectSpaceId({ spaces, assignments }, project.cwd) === targetSpace.id
    ).length
    return (
      <Dialog open onOpenChange={(open) => !open && !busy && closeDialog()}>
        <DialogContent confirmation showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t('spaces.deleteTitle', { name: spaceDisplayName(targetSpace, t) })}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t('spaces.deleteBody', {
                count: projectCount,
                target: spaceDisplayName(fallback, t)
              })}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={closeDialog}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void removeSpace(targetSpace.id).catch(() => {})}
            >
              {t('spaces.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  const isCreate = dialog.mode === 'create'
  const isRename = dialog.mode === 'rename'
  const isIconOnly = dialog.mode === 'icon'
  const trimmedName = name.trim()
  const canSubmit = !busy && (isIconOnly || trimmedName.length > 0)

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    if (isCreate) {
      void createSpace({
        name: trimmedName,
        icon: icon === 'dot' ? undefined : icon,
        moveProjectCwd: dialog.moveProjectCwd
      }).catch(() => {})
      return
    }
    if (!targetSpace) return
    if (isRename) {
      void updateSpace({ id: targetSpace.id, name: trimmedName }).catch(() => {})
      return
    }
    void updateSpace({
      id: targetSpace.id,
      icon: icon === 'dot' ? null : icon
    }).catch(() => {})
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && closeDialog()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {isCreate
                ? t('spaces.create')
                : isRename
                  ? t('spaces.renameTitle')
                  : t('spaces.changeIconTitle')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {isCreate
                ? t('spaces.create')
                : isRename
                  ? t('spaces.renameTitle')
                  : t('spaces.changeIconTitle')}
            </DialogDescription>
          </DialogHeader>

          {!isIconOnly ? (
            <div className="grid gap-1.5">
              <label htmlFor="space-name-input" className="text-xs text-muted-foreground">
                {t('spaces.nameLabel')}
              </label>
              <Input
                id="space-name-input"
                ref={inputRef}
                value={name}
                maxLength={80}
                placeholder={t('spaces.namePlaceholder')}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          ) : null}

          {isCreate || isIconOnly ? (
            <div className="grid gap-2">
              {isCreate ? (
                <button
                  type="button"
                  aria-expanded={iconPickerOpen}
                  disabled={busy}
                  onClick={() => setIconPickerOpen((prev) => !prev)}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-lg border px-2.5 text-xs text-foreground transition-colors',
                    inputSurface
                  )}
                >
                  {icon === 'dot' ? (
                    <Sparkles className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <span className="flex size-3 items-center justify-center text-foreground">
                      <SpaceGlyph icon={icon} active />
                    </span>
                  )}
                  <span className="flex-1 truncate text-left">
                    {t('spaces.chooseIcon')}
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      'size-3 shrink-0 text-muted-foreground transition-transform duration-150',
                      iconPickerOpen && 'rotate-180'
                    )}
                  />
                </button>
              ) : null}

              {iconPickerOpen || isIconOnly ? (
                <div
                  role="radiogroup"
                  aria-label={t('spaces.chooseIcon')}
                  className="grid grid-cols-8 gap-0.5 rounded-lg border border-glass-border bg-glass-prompt-foreground/4 p-1 solid:border-border solid:bg-muted/40"
                >
                  {PROJECT_SPACE_ICONS.map((candidate) => {
                    const selected = icon === candidate
                    return (
                      <button
                        key={candidate}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={candidate === 'dot' ? t('spaces.defaultIcon') : candidate}
                        title={candidate === 'dot' ? t('spaces.defaultIcon') : undefined}
                        disabled={busy}
                        onClick={() => setIcon(candidate)}
                        className={cn(
                          'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-glass-prompt-foreground/8 hover:text-foreground solid:hover:bg-accent solid:hover:text-accent-foreground',
                          selected &&
                            'bg-primary/15 text-primary ring-1 ring-primary/40 hover:bg-primary/20 hover:text-primary solid:bg-primary/15 solid:text-primary'
                        )}
                      >
                        <SpaceGlyph icon={candidate} active />
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={closeDialog}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isCreate ? t('spaces.createConfirm') : t('spaces.saveConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
