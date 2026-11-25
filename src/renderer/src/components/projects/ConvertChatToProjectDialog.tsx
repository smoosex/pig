/**
 * Modal dialog for converting a standalone Chat into a dedicated Project directory:
 * - Pre-fills folder name from the chat title and defaults location to `$HOME/pig_projects`
 * - Uses Pig's in-app `PathPickerDialog` to browse custom parent locations
 * - Lets the user choose whether to migrate the conversation's Pi JSONL session history
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { FolderOpen, LoaderCircle } from 'lucide-react'
import type { ConvertChatToProjectResult } from '../../../../shared/api'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import { failureMessage } from '../../lib/ipc-error'
import { isComposingKey } from '../../lib/shortcuts'
import { useSessionsStore } from '../../stores/sessions'
import { isPlaceholderSessionTitle } from '../../stores/sessions/session-title'
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
import { Switch } from '../ui/switch'
import { PathPickerDialog } from './PathPickerDialog'

function suggestProjectFolderName(title: string, sessionId: string): string {
  const trimmed = title.trim()
  const fallback = `chat-${sessionId.slice(0, 8)}`
  if (!trimmed || isPlaceholderSessionTitle(trimmed)) return fallback
  const sanitized = trimmed
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64)
  return sanitized || fallback
}

function joinPreviewPath(parentDir: string, folderName: string): string {
  const base = parentDir.trim().replace(/[/\\]+$/, '')
  const leaf = folderName.trim()
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  if (!base) return leaf
  if (!leaf) return `${base}${sep}`
  return `${base}${sep}${leaf}`
}

export function ConvertChatToProjectDialog({
  onConverted
}: {
  onConverted: (
    result: ConvertChatToProjectResult,
    options: { transferSession: boolean; targetSessionId: string }
  ) => void | Promise<void>
}) {
  const t = useT()
  const id = useId()
  const target = useSessionsStore((s) => s.convertChatDialog)
  const closeDialog = useSessionsStore((s) => s.closeConvertChatDialog)
  const convertChatToProject = useSessionsStore((s) => s.convertChatToProject)

  const [folderName, setFolderName] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [browseStartDir, setBrowseStartDir] = useState<string | undefined>(undefined)
  const [transferSession, setTransferSession] = useState(true)
  const [pickingParent, setPickingParent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) {
      setPickingParent(false)
      setSubmitting(false)
      setError(null)
      return
    }
    setFolderName(suggestProjectFolderName(target.title, target.sessionId))
    setTransferSession(true)
    setError(null)
    let cancelled = false
    void api
      .getDefaultProjectsLocation()
      .then((loc) => {
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
    const targetSessionId = target.sessionId
    const shouldTransfer = transferSession
    try {
      const result = await convertChatToProject({
        chatCwd: target.chatCwd,
        parentDir: parentDir.trim(),
        folderName: folderName.trim(),
        transferSession: shouldTransfer
      })
      await onConverted(result, { transferSession: shouldTransfer, targetSessionId })
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('sessions.convertDialog.title')}</DialogTitle>
            <DialogDescription>{t('sessions.convertDialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>{t('sessions.convertDialog.folderName')}</Label>
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
                placeholder={t('sessions.convertDialog.folderNamePlaceholder')}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-parent`}>{t('sessions.convertDialog.parentDir')}</Label>
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
                  placeholder={t('sessions.convertDialog.parentDirPlaceholder')}
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
                  {t('sessions.convertDialog.chooseParent')}
                </Button>
              </div>
              <p className="truncate font-mono text-[11px] text-muted-foreground" title={previewPath}>
                {t('sessions.convertDialog.targetPreview', { path: previewPath })}
              </p>
            </div>

            <label
              htmlFor={`${id}-transfer`}
              className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-glass-border bg-glass-prompt-foreground/3 p-3 solid:border-border solid:bg-muted/30"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs font-medium text-foreground">
                  {t('sessions.convertDialog.transferSession')}
                </span>
                <span className="text-[11px] leading-relaxed text-muted-foreground">
                  {t('sessions.convertDialog.transferSessionDescription')}
                </span>
              </div>
              <Switch
                id={`${id}-transfer`}
                checked={transferSession}
                disabled={submitting}
                onCheckedChange={setTransferSession}
                className="mt-0.5 shrink-0"
              />
            </label>

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
              {t(submitting ? 'sessions.convertDialog.submitting' : 'sessions.convertDialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pickingParent ? (
        <PathPickerDialog
          initialPath={browseStartDir}
          title={t('sessions.convertDialog.pickerTitle')}
          description={t('sessions.convertDialog.pickerDescription')}
          confirmLabel={t('sessions.convertDialog.pickerConfirm')}
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
