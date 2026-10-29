import { useEffect, useRef, useState } from 'react'
import { api } from '../ipc/api'
import { useT } from '../hooks/useT'
import { describeQuitActivity, type QuitConfirmRequest } from '../../../shared/quit'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

type QuitAsk = Extract<QuitConfirmRequest, { type: 'ask' }>

/** Main asks here before quitting over running work; any way of closing the dialog except confirming cancels. */
export function QuitConfirm() {
  const t = useT()
  const [request, setRequest] = useState<QuitAsk | null>(null)
  // Kept apart from the request so the text stays put while the dialog fades out.
  const [open, setOpen] = useState(false)
  // The confirm click and the dialog's close both answer; only the first one counts.
  const pendingId = useRef<string | null>(null)

  const answer = (confirmed: boolean) => {
    const requestId = pendingId.current
    if (!requestId) return
    pendingId.current = null
    void api.replyQuitConfirm(requestId, confirmed)
    setOpen(false)
  }

  useEffect(() => api.onQuitConfirm((next) => {
    if (next.type === 'dismiss') {
      if (pendingId.current !== next.requestId) return
      pendingId.current = null
      setOpen(false)
      return
    }
    if (pendingId.current) void api.replyQuitConfirm(pendingId.current, false)
    pendingId.current = next.requestId
    setRequest(next)
    setOpen(true)
  }), [])

  // Acked after the commit that renders the dialog, so main knows it is actually on screen.
  useEffect(() => {
    if (open && request && pendingId.current === request.requestId) void api.ackQuitConfirm(request.requestId)
  }, [open, request])

  return (
    <Dialog open={open} onOpenChange={(open) => { if (!open) answer(false) }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">{t('quit.title')}</DialogTitle>
          <DialogDescription className="text-xs">{request && describeQuitActivity(request.activity, t)}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => answer(false)}>{t('common.cancel')}</Button>
          <Button variant="destructive" onClick={() => answer(true)}>{t('quit.confirm')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
