/** UI-only reply references, atomically persisted outside the session log. Writes share one queue. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BookmarkSnapshot, ReplyBookmark } from '../shared/bookmarks'
import { replyBookmarkId } from '../shared/bookmarks'
import { pigPath } from './pig-dir'

function parseSnapshot(text: string): BookmarkSnapshot {
  let value: BookmarkSnapshot
  try { value = JSON.parse(text) as BookmarkSnapshot }
  catch { throw new Error('Invalid bookmarks file') }
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.items)) {
    throw new Error('Invalid bookmarks file')
  }
  const ids = new Set<string>()
  for (const item of value.items) {
    if (!item || !item.session || typeof item.session.id !== 'string' || typeof item.session.path !== 'string' ||
      typeof item.session.cwd !== 'string' || typeof item.session.firstMessage !== 'string' ||
      typeof item.session.created !== 'string' || typeof item.session.modified !== 'string' ||
      typeof item.session.size !== 'number' || (item.session.name !== undefined && typeof item.session.name !== 'string') ||
      typeof item.turnId !== 'string' || typeof item.entryId !== 'string' || typeof item.preview !== 'string' ||
      !Number.isFinite(item.createdAt) || !['project', 'chat'].includes(item.kind) ||
      item.id !== replyBookmarkId(item.session.id, item.entryId) || ids.has(item.id)) {
      throw new Error('Invalid bookmark record')
    }
    ids.add(item.id)
  }
  return value
}

export class BookmarkStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: () => string = () => pigPath('bookmarks.json')) {}

  async list(): Promise<BookmarkSnapshot> {
    await this.queue
    return this.read()
  }

  private async read(): Promise<BookmarkSnapshot> {
    try {
      return parseSnapshot(await readFile(this.file(), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, items: [] }
      throw error
    }
  }

  private mutate(change: (items: ReplyBookmark[]) => ReplyBookmark[]): Promise<BookmarkSnapshot> {
    const operation = this.queue.then(async () => {
      const previous = await this.read()
      const items = change(previous.items)
      if (items === previous.items) return previous
      const next = { revision: previous.revision + 1, items }
      const file = this.file()
      const temp = `${file}.${randomUUID()}.tmp`
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      try {
        await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
        await rename(temp, file)
      } finally {
        await rm(temp, { force: true })
      }
      return next
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  add(item: ReplyBookmark): Promise<BookmarkSnapshot> {
    return this.mutate(items => items.some(current => current.id === item.id) ? items : [item, ...items])
  }

  remove(id: string): Promise<BookmarkSnapshot> {
    return this.mutate(items => items.some(item => item.id === id) ? items.filter(item => item.id !== id) : items)
  }
}

export const bookmarks = new BookmarkStore()
