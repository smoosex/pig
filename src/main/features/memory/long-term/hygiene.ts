/** Shared hygiene for raw task learning and retrieval; not a universal secret detector. */
export const SENSITIVE_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk)-[a-zA-Z0-9_-]{20,}|\bgh[pousr]_[a-zA-Z0-9]{20,}|\bgithub_pat_[a-zA-Z0-9_]{20,}|\bAKIA[A-Z0-9]{16}\b|\b(?:password|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*["']?[^\s"']{8,}/i

/** Profiles are short directory identities; implementation paths belong to scoped knowledge. */
export function isProjectProfile(content: string): boolean {
  return content.length <= 320 && !/```|\b(?:src|tests|packages)\/|\b[\w-]+\.tsx?\b/.test(content)
}

export function isDerivedMemoryTool(name: unknown): boolean {
  return typeof name === 'string' && (name.startsWith('memory_') || name === 'recall' || name.startsWith('session_'))
}
