/**
 * The repo has no linter, so this test is the rule that keeps copy out of the source: every
 * user-facing string comes from src/shared/i18n, and a literal here means someone bypassed it.
 * Both processes are scanned: main sends its errors and dialog titles to the renderer verbatim.
 *
 * Comments and the deliberate pi-parity parsers below are the only allowed exceptions.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const CJK = /[\u4e00-\u9fff]/

/** Lines allowed to carry CJK: a parser that must also recognise the copy it strips, not a string. */
const allowed = new Map<string, string[]>([
  ['src/renderer/src/components/turn/ProcessText.tsx', ["return text.replace(/^(Thought for \\d+s|已?思考了?\\s*\\d+\\s*(秒|s)?)\\s*\\n+/i, '').trim()"]]
])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('translated copy', () => {
  test('both processes spell their Chinese through the dictionary', () => {
    const offenders: string[] = []
    const roots = [join(ROOT, 'src/renderer/src'), join(ROOT, 'src/main')]
    for (const path of roots.flatMap(sourceFiles)) {
      const file = relative(ROOT, path)
      const permitted = allowed.get(file) ?? []
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return
        const code = line.split('//')[0]
        if (!CJK.test(code)) return
        if (permitted.some((excerpt) => line.includes(excerpt))) return
        offenders.push(`${file}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
