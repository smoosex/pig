/**
 * Modal dialog for physically moving an opened Project directory on disk to a user-defined
 * parent directory + folder name, migrating all Pi JSONL sessions, Git worktrees, spaces,
 * Kanban issues, bookmarks, Bot tasks, and long-term memory.
 * Can be opened from the Sidebar project menu or evoked directly by Bot (`bot_request_move_project`).
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { FolderOpen, LoaderCircle } from 'lucide-react'
import { baseName } from '../../../../shared/paths'
import type { RelocateProjectResult } from '../../../../shared/api'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import { failureMessage } from '../../lib/ipc-error'
import { isComposingKey } from '../../lib/shortcuts'
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
import { Label } from '../ui/label'
import { PathPickerDialog } from './PathPickerDialog'

function parentDirectoryOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (slash < 0) return ''
  return slash === 0 ? '/' : trimmed.slice(0, slash)
}

function joinPreviewPath(parentDir: string, folderName: string): string {
  const base = parentDir.trim().replace(/[/\\]+$/, '')
  const leaf = folderName.trim()
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  if (!base) return leaf
  if (!leaf) return `${base}${sep}`
  return `${base}${sep}${leaf}`
}

export function MoveProjectDialog({
  onMoved
}: {
  onMoved?: (result: RelocateProjectResult) => void | Promise<void>
}) {
  const t = useT()
  const id = useId()
  const target = useSessionsStore((s) => s.moveProjectTarget)
  const openDialog = useSessionsStore((s) => s.openMoveProjectDialog)
  const closeDialog = useSessionsStore((s) => s.closeMoveProjectDialog)
  const moveProject = useSessionsStore((s) => s.moveProject)

  const [folderName, setFolderName] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [browseStartDir, setBrowseStartDir] = useState<string | undefined>(undefined)
  const [pickingParent, setPickingParent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return api.onRequestMoveProject?.((requested) => {
      openDialog(requested)
    })
  }, [openDialog])

  useEffect(() => {
    if (!target) {
      setPickingParent(false)
      setSubmitting(false)
      setError(null)
      return
    }
    const currentFolder = baseName(target.cwd) || target.name
    const currentParent = parentDirectoryOf(target.cwd)
    setFolderName(target.suggestedFolderName?.trim() || currentFolder)
    setError(null)

    if (target.suggestedParentDir?.trim()) {
      const suggested = target.suggestedParentDir.trim()
      setParentDir(suggested)
      setBrowseStartDir(suggested.startsWith('~') ? (currentParent || undefined) : suggested)
      return
    }

    if (currentParent) {
      setParentDir(currentParent)
      setBrowseStartDir(currentParent)
      return
    }

    let cancelled = false
    void api
      .getDefaultProjectsLocation?.()
      ?.then((loc) => {
        if (cancelled) return
        setParentDir(loc.defaultParentDir)
        setBrowseStartDir(loc.parentExists ? loc.defaultParentDir : loc.homeDir)
      })
      .catch(() => {
        if (!cancelled) setParentDir('~/pig_projects')
      })
    return () => {
      cancelled = true
    }
  }, [target])

  const previewPath = useMemo(
    () => joinPreviewPath(parentDir || '~/pig_projects', folderName),
    [parentDir, folderName]
  )

  if (!target) return null

  const canSubmit = !submitting && Boolean(folderName.trim()) && Boolean(parentDir.trim())

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await moveProject({
        oldCwd: target.cwd,
        parentDir: parentDir.trim(),
        folderName: folderName.trim()
      })
      await onMoved?.(result)
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Dialog
        open={!pickingParent}
        onOpenChange={(open) => {
          if (!open && !submitting) closeDialog()
        }}
      >
        <DialogContent className="sm:max-w-md" data-move-project-dialog>
          <DialogHeader>
            <DialogTitle>{t('project.moveDialog.title', { name: target.name })}</DialogTitle>
            <DialogDescription>{t('project.moveDialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>{t('project.moveDialog.folderName')}</Label>
              <Input
                id={`${id}-name`}
                value={folderName}
                disabled={submitting}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  setFolderName(e.currentTarget.value)
                  if (error) setError(null)
                }}
                onKeyDown={(e) => {
                  if (isComposingKey(e.nativeEvent)) return
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleSubmit()
                  }
                }}
                placeholder={t('project.moveDialog.folderNamePlaceholder')}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-parent`}>{t('project.moveDialog.parentDir')}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`${id}-parent`}
                  value={parentDir}
                  disabled={submitting}
                  onChange={(e) => {
                    setParentDir(e.currentTarget.value)
                    if (error) setError(null)
                  }}
                  onKeyDown={(e) => {
                    if (isComposingKey(e.nativeEvent)) return
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleSubmit()
                    }
                  }}
                  placeholder={t('project.moveDialog.parentDirPlaceholder')}
                  className="min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={() => setPickingParent(true)}
                  className="shrink-0"
                >
                  <FolderOpen data-icon="inline-start" />
                  {t('project.moveDialog.chooseParent')}
                </Button>
              </div>
              <div className="flex flex-col gap-0.5 pt-0.5 font-mono text-[11px] text-muted-foreground">
                <p className="truncate" title={target.cwd}>
                  {t('project.moveDialog.currentPath', { path: target.cwd })}
                </p>
                <p className="truncate text-foreground/85" title={previewPath}>
                  {t('project.moveDialog.targetPreview', { path: previewPath })}
                </p>
              </div>
            </div>

            {error ? (
              <p role="alert" className="text-xs break-words text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={closeDialog}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              {submitting ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null}
              {t(submitting ? 'project.moveDialog.submitting' : 'project.moveDialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pickingParent ? (
        <PathPickerDialog
          initialPath={browseStartDir}
          title={t('project.moveDialog.pickerTitle')}
          description={t('project.moveDialog.pickerDescription')}
          confirmLabel={t('project.moveDialog.pickerConfirm')}
          onClose={() => setPickingParent(false)}
          onSelect={(pickedPath) => {
            setParentDir(pickedPath)
            setBrowseStartDir(pickedPath)
            setError(null)
            setPickingParent(false)
          }}
        />
      ) : null}
    </>
  )
}
