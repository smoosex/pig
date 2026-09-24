import { mkdir, readdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pigPath } from './pig-dir'
import { listJsonlFiles, listProject, sessionDirForCwd, type ProjectGroup } from './pi/session-loader'

export function chatsDir(): string {
  return pigPath('chats')
}

export function isChatsRoot(cwd: string): boolean {
  return resolve(cwd) === resolve(chatsDir())
}

export function isChatCwd(cwd: string): boolean {
  return dirname(resolve(cwd)) === resolve(chatsDir())
}

export async function createChatDir(): Promise<string> {
  await mkdir(chatsDir(), { recursive: true })
  for (;;) {
    const cwd = join(chatsDir(), randomUUID())
    try {
      await mkdir(cwd)
      return cwd
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

export async function listChats(): Promise<ProjectGroup[]> {
  let names: string[]
  try {
    names = (await readdir(chatsDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const groups = await Promise.all(names.map((name) => listProject(join(chatsDir(), name))))
  const chats = groups.filter((group): group is ProjectGroup => (group?.sessions.length ?? 0) > 0)
  chats.sort((a, b) => (b.sessions[0]?.modified ?? '').localeCompare(a.sessions[0]?.modified ?? ''))
  return chats
}

export async function removeChatWorkDir(cwd: string): Promise<void> {
  if (!isChatCwd(cwd)) throw new Error(`Invalid chat dir: ${cwd}`)
  await rm(resolve(cwd), { recursive: true, force: true })
}

/**
 * Chats nobody ever sent to hold no session file, and the renderer that would take one back dies with
 * the process: quitting from the chat home leaves its directory behind. The chat list cannot show
 * them, so they pile up unseen — main sweeps them while nothing can be holding one, which is startup.
 */
export async function pruneEmptyChatDirs(): Promise<void> {
  let names: string[]
  try {
    names = (await readdir(chatsDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return
  }
  await Promise.all(
    names.map(async (name) => {
      const cwd = join(chatsDir(), name)
      if ((await listJsonlFiles(sessionDirForCwd(cwd))).length > 0) return
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    })
  )
}
