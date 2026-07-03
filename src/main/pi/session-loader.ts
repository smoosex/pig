import { basename } from 'node:path'
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent'

export interface SessionMeta {
  path: string
  id: string
  cwd: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
}

export interface ProjectGroup {
  cwd: string
  name: string
  sessions: SessionMeta[]
}

function toMeta(info: SessionInfo): SessionMeta {
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    name: info.name,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage
  }
}

export async function listProjects(): Promise<ProjectGroup[]> {
  const all = await SessionManager.listAll()
  const byCwd = new Map<string, SessionMeta[]>()
  for (const info of all) {
    const cwd = info.cwd || '(unknown)'
    const arr = byCwd.get(cwd)
    if (arr) arr.push(toMeta(info))
    else byCwd.set(cwd, [toMeta(info)])
  }

  const groups: ProjectGroup[] = []
  for (const [cwd, sessions] of byCwd) {
    sessions.sort((a, b) => b.modified.localeCompare(a.modified))
    groups.push({
      cwd,
      name: cwd === '(unknown)' ? '未知项目' : basename(cwd) || cwd,
      sessions
    })
  }
  groups.sort((a, b) => {
    const aLast = a.sessions[0]?.modified ?? ''
    const bLast = b.sessions[0]?.modified ?? ''
    return bLast.localeCompare(aLast)
  })
  return groups
}