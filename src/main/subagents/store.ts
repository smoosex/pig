/**
 * Per-parent subagent index at `$PIG_DIR/subagents/<parent id>/index.json`; child transcripts sit
 * beside it. Writes are serialized per parent. Pig does not resume children, so loading an index
 * from a previous run turns anything still queued or running into `interrupted`.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubagentInfo } from '../../shared/api'
import { pigPath } from '../pig-dir'

export interface SubagentStore {
  dir(parentSessionId: string): string
  load(parentSessionId: string): Promise<SubagentInfo[]>
  save(parentSessionId: string, items: SubagentInfo[]): Promise<void>
  remove(parentSessionId: string): Promise<void>
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/

export function isStale(item: SubagentInfo): boolean {
  return item.status === 'queued' || item.status === 'running'
}

export function interruptStale(items: SubagentInfo[], now: number): SubagentInfo[] {
  return items.map((item) => isStale(item)
    ? { ...item, status: 'interrupted', endedAt: item.endedAt ?? now, activity: undefined }
    : item)
}

/**
 * Indexes from earlier builds stored the timeline in other shapes. Those are dropped rather than
 * converted: the manager rebuilds an incomplete timeline from the child's transcript.
 */
function withTimeline(item: SubagentInfo): SubagentInfo {
  const turns = Array.isArray(item.turnTools) ? item.turnTools as unknown[] : []
  const current = turns.every((turn) => !!turn && typeof turn === 'object' &&
    Array.isArray((turn as { tools?: unknown }).tools) && typeof (turn as { thinking?: unknown }).thinking === 'boolean')
  return current ? item : { ...item, turnTools: [] }
}

export function createFileStore(root: () => string = () => pigPath('subagents')): SubagentStore {
  const writes = new Map<string, Promise<void>>()
  const dir = (parentSessionId: string) => {
    if (!SAFE_ID.test(parentSessionId)) throw new Error(`Invalid session id: ${parentSessionId}`)
    return join(root(), parentSessionId)
  }
  return {
    dir,
    async load(parentSessionId) {
      let text: string
      try {
        text = await readFile(join(dir(parentSessionId), 'index.json'), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || !Array.isArray((value as { subagents?: unknown }).subagents)) {
        throw Object.assign(new Error('Invalid subagent index'), { code: 'ERR_SUBAGENT_INDEX' })
      }
      const items = (value as { subagents: SubagentInfo[] }).subagents
      return interruptStale(items.map(withTimeline), Date.now())
    },
    save(parentSessionId, items) {
      const target = dir(parentSessionId)
      const snapshot = `${JSON.stringify({ version: 1, subagents: items }, null, 2)}\n`
      const previous = writes.get(parentSessionId) ?? Promise.resolve()
      const next = previous.then(async () => {
        await mkdir(target, { recursive: true })
        const path = join(target, 'index.json')
        const temp = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temp, snapshot)
          await rename(temp, path)
        } catch (error) {
          await rm(temp, { force: true })
          throw error
        }
      })
      // Only the queue tail absorbs rejection to allow later writes. The returned promise still
      // rejects, and the manager's invoke/job boundary reports that failure to callers or the UI.
      const settled = next.catch(() => {})
      writes.set(parentSessionId, settled)
      void settled.then(() => { if (writes.get(parentSessionId) === settled) writes.delete(parentSessionId) })
      return next
    },
    async remove(parentSessionId) {
      await writes.get(parentSessionId)
      await rm(dir(parentSessionId), { recursive: true, force: true })
    }
  }
}
