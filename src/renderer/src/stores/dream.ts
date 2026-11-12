/** One shared Dream monitor for the sidebar and dialog. Closing a view never stops the task;
 * request revisions prevent an old poll from replacing a start/stop response. */
import { useEffect } from 'react'
import { create } from 'zustand'
import type { DreamRecord, DreamRecordSummary, DreamStatus } from '../../../shared/dream'
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
  view: 'history' | 'detail'
  dismissedId?: string
  viewedResultId?: string
  records: DreamRecordSummary[]
  nextOffset?: number
  historyBusy: boolean
  historyError?: string
  recordId?: string
  record?: DreamRecord
  recordError?: string
  openHistory: (enabled?: boolean) => void
  loadHistory: (more?: boolean) => Promise<void>
  readRecord: (id: string) => Promise<void>
  refresh: () => Promise<void>
  openDialog: (enabled?: boolean) => void
  closeDialog: () => void
  newTopic: () => void
  setDraft: (draft: string) => void
  start: () => Promise<void>
  stop: () => Promise<void>
  repair: () => Promise<void>
}
function viewedResult(state: DreamState): string | undefined {
  const viewedId = state.recordId ? state.record?.id : state.status?.id
  return state.open && state.view === 'detail' && !state.compose && state.status?.state !== 'running' && viewedId === state.status?.id
    ? viewedId : state.viewedResultId
}
let revision = 0, enabledRevision = 0, historyRevision = 0, recordRevision = 0
export const useDreamStore = create<DreamState>((set, get) => ({
  busy: false, open: false, compose: false, draft: '', view: 'detail', records: [], historyBusy: false,
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
    recordRevision++
    set({ open: true, enabled, compose: false, view: 'detail', recordId: undefined, record: undefined, recordError: undefined, actionError: undefined })
    if (enabled !== undefined) return
    void api.getMemorySettings().then(value => {
      if (request === enabledRevision) set({ enabled: value.fileMemory?.enabled ?? true })
    }, error => { if (request === enabledRevision) set({ actionError: failureMessage(error) }) })
  },
  closeDialog: () => {
    enabledRevision++; recordRevision++; historyRevision++
    const viewedId = viewedResult(get())
    set({ open: false, historyBusy: false, ...(get().status?.state !== 'running' && viewedId && viewedId === get().status?.id ? { dismissedId: viewedId } : {}) })
  },
  openHistory: enabled => {
    const viewedResultId = viewedResult(get())
    get().openDialog(enabled)
    set({ view: 'history', viewedResultId })
    void get().loadHistory()
  },
  loadHistory: async (more = false) => {
    const request = ++historyRevision
    const offset = more ? get().nextOffset : undefined
    if (more && offset === undefined) return
    set({ historyBusy: true, historyError: undefined })
    try {
      const page = await api.dream.list(offset)
      if (request === historyRevision) set({ records: more ? [...new Map([...get().records, ...page.items].map(record => [record.id, record])).values()] : page.items, nextOffset: page.nextOffset })
    } catch (error) { if (request === historyRevision) set({ historyError: failureMessage(error) }) }
    finally { if (request === historyRevision) set({ historyBusy: false }) }
  },
  readRecord: async id => {
    const request = ++recordRevision
    set({ view: 'detail', compose: false, recordId: id, record: undefined, recordError: undefined })
    try {
      const record = await api.dream.read(id)
      if (request === recordRevision) set({ record })
    } catch (error) { if (request === recordRevision) set({ recordError: failureMessage(error) }) }
  },
  newTopic: () => {
    recordRevision++
    set({ viewedResultId: viewedResult(get()), view: 'detail', recordId: undefined, record: undefined, compose: true, draft: '', actionError: undefined })
  },
  setDraft: draft => set({ draft }),
  start: async () => {
    const topic = get().draft.trim()
    if (get().busy || get().status?.state === 'running' || !topic) return
    revision++; set({ busy: true, actionError: undefined })
    try { const status = await api.dream.start({ topic }); revision++; set({ status, compose: false }) }
    catch (error) { set({ actionError: failureMessage(error) }) }
    finally { set({ busy: false }) }
  },
  repair: async () => {
    if (get().busy || get().status?.state === 'running') return
    recordRevision++
    revision++; set({ busy: true, open: true, view: 'detail', recordId: undefined, record: undefined, compose: false, actionError: undefined })
    try { const status = await api.dream.start({ repair: true }); revision++; set({ status }) }
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
