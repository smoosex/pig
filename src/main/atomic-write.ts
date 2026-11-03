/**
 * Temp-and-rename writes for state files owned by main.
 *
 * A process killed in the middle of a plain writeFile leaves a truncated document behind, and every
 * reader of these files parses JSON: `opened-projects.json` would come back as an empty project list
 * and the next write would persist that emptiness. Writing beside the target and renaming keeps the
 * previous contents intact until the new document is complete.
 *
 * The temp file must sit in the target's directory: rename across filesystems fails with EXDEV. The
 * name carries a UUID so two writers of the same file cannot share a scratch path. The caller still
 * owns `mkdir` — a missing parent should surface as ENOENT instead of silently creating a directory
 * at a mistyped path.
 */
import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    // 0600 covers every state file here: only main reads them, and two of them carry credentials
    // or tokens in URLs.
    await writeFile(temporary, data, { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
