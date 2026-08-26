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

function toProject(cwd: string, infos: SessionInfo[]): ProjectGroup | null {
  if (infos.length === 0) return null
  const sessions = infos.map(toMeta).sort((a, b) => b.modified.localeCompare(a.modified))
  return {
    cwd,
    name: cwd === '(unknown)' ? '未知项目' : basename(cwd) || cwd,
    sessions
  }
}

export async function listProject(cwd: string): Promise<ProjectGroup | null> {
  const infos =
    cwd === '(unknown)'
      ? (await SessionManager.listAll()).filter((info) => !info.cwd)
      : await SessionManager.list(cwd)
  return toProject(cwd, infos)
}

export async function listProjects(): Promise<ProjectGroup[]> {
  const all = await SessionManager.listAll()
  const byCwd = new Map<string, SessionInfo[]>()
  for (const info of all) {
    const cwd = info.cwd || '(unknown)'
    const arr = byCwd.get(cwd)
    if (arr) arr.push(info)
    else byCwd.set(cwd, [info])
  }

  const groups = [...byCwd].flatMap(([cwd, infos]) => {
    const project = toProject(cwd, infos)
    return project ? [project] : []
  })
  groups.sort((a, b) => {
    const aLast = a.sessions[0]?.modified ?? ''
    const bLast = b.sessions[0]?.modified ?? ''
    return bLast.localeCompare(aLast)
  })
  return groups
}
