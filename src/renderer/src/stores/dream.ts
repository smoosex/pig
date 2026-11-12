/** One shared Dream monitor for the sidebar and dialog. Closing a view never stops the task;
 * request revisions prevent an old poll from replacing a start/stop response. */
import { useEffect } from 'react'
import { create } from 'zustand'
import type { DreamStatus } from '../../../shared/dream'
import { api } from '../ipc/api'
import { failureMessage } from '../lib/ipc-error'

interface DreamState {
  status?: DreamStatus
  loadError?: string
  actionError?: string
  busy: boolean
  open: boolean
  compose: boolean
  enabled?: boolean
  draft: string
  refresh: () => Promise<void>
  openDialog: (enabled?: boolean) => void
  closeDialog: () => void
  newTopic: () => void
  setDraft: (draft: string) => void
  start: () => Promise<void>
  stop: () => Promise<void>
}
let revision = 0, enabledRevision = 0
export const useDreamStore = create<DreamState>((set, get) => ({
  busy: false, open: false, compose: false, draft: '',
  refresh: async () => {
    if (get().busy) return
    const request = ++revision
    try {
      const status = await api.dream.status()
      if (request === revision) set({ status, loadError: undefined })
    } catch (error) { if (request === revision) set({ loadError: failureMessage(error) }) }
  },
  openDialog: enabled => {
    const request = ++enabledRevision
    set({ open: true, enabled, compose: false, actionError: undefined })
    if (enabled !== undefined) return
    void api.getMemorySettings().then(value => {
      if (request === enabledRevision) set({ enabled: value.fileMemory?.enabled ?? false })
    }, error => { if (request === enabledRevision) set({ actionError: failureMessage(error) }) })
  },
  closeDialog: () => { enabledRevision++; set({ open: false }) },
  newTopic: () => set({ compose: true, draft: get().status?.topic ?? get().draft, actionError: undefined }),
  setDraft: draft => set({ draft }),
  start: async () => {
    const topic = get().draft.trim()
    if (get().busy || get().status?.state === 'running' || !topic) return
    revision++; set({ busy: true, actionError: undefined })
    try { const status = await api.dream.start({ topic }); revision++; set({ status, compose: false }) }
    catch (error) { set({ actionError: failureMessage(error) }) }
    finally { set({ busy: false }) }
  },
  stop: async () => {
    if (get().busy) return
    revision++; set({ busy: true, actionError: undefined })
    try { const status = await api.dream.stop(); revision++; set({ status }) }
    catch (error) { set({ actionError: failureMessage(error) }) }
    finally { set({ busy: false }) }
  }
}))

let consumers = 0, generation = 0
let timer: ReturnType<typeof setTimeout> | undefined
export function useDreamMonitor(): void {
  useEffect(() => {
    if (++consumers === 1) {
      const current = ++generation
      const poll = async () => {
        await useDreamStore.getState().refresh()
        if (consumers && current === generation) timer = setTimeout(() => void poll(), 1000)
      }
      void poll()
    }
    return () => {
      if (--consumers === 0) { generation++; revision++; clearTimeout(timer) }
    }
  }, [])
}
