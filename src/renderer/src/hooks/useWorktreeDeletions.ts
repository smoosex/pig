/** Background cleanup notices survive sidebar switches and renderer reloads via a main-owned snapshot. */
import { useEffect } from 'react'
import { toast } from 'sonner'
import { api, type WorktreeDeletionJob } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'
import { useT } from './useT'
import { failureMessage } from '../lib/ipc-error'

export function useWorktreeDeletions(): void {
  const t = useT()
  useEffect(() => {
    let disposed = false
    let revision = 0
    const visible = new Map<string, string>()
    const receive = (jobs: WorktreeDeletionJob[]) => {
      if (disposed) return
      useSessionsStore.getState().applyWorktreeDeletions(jobs.map((job) => job.cwd))
      const failed = new Set(jobs.filter((job) => job.error).map((job) => job.cwd))
      for (const cwd of visible.keys()) {
        if (!failed.has(cwd)) {
          toast.dismiss(`worktree-delete:${cwd}`)
          visible.delete(cwd)
        }
      }
      for (const job of jobs) {
        if (!job.error) continue
        const signature = `${job.attempts}:${job.retryAt}:${job.error}`
        if (visible.get(job.cwd) === signature) continue
        visible.set(job.cwd, signature)
        const retry = job.retryAt !== undefined
          ? t('worktree.deleteRetrying', { seconds: Math.max(1, Math.ceil((job.retryAt - Date.now()) / 1000)) })
          : t('worktree.deleteRetryExhausted')
        toast.error(t('worktree.deleteFailed', { branch: job.branch }), {
          id: `worktree-delete:${job.cwd}`,
          duration: Infinity,
          description: `${job.error}\n${retry}`,
          action: {
            label: t('common.retry'),
            onClick: (event) => {
              event.preventDefault()
              void api.retryWorktreeDeletion(job.cwd).catch((error: unknown) => {
                toast.error(t('worktree.deleteFailed', { branch: job.branch }), { description: failureMessage(error) })
              })
            }
          }
        })
      }
    }
    const unsubscribe = api.onWorktreeDeletionsChanged((jobs) => { revision++; receive(jobs) })
    const snapshotRevision = revision
    void api.listWorktreeDeletions().then((jobs) => {
      if (revision === snapshotRevision) receive(jobs)
    }, (error: unknown) => {
      if (!disposed) toast.error(t('worktree.deleteStatusFailed'), { description: failureMessage(error) })
    })
    return () => {
      disposed = true
      unsubscribe()
      for (const cwd of visible.keys()) toast.dismiss(`worktree-delete:${cwd}`)
    }
  }, [t])
}
