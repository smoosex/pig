import { extensions, fileNames } from './file-icons.generated'

export function fileIconName(path: string): string | null {
  let candidate = path.replaceAll('\\', '/')
  while (candidate) {
    const named = fileNames[candidate] ?? fileNames[candidate.toLowerCase()]
    if (named) return named
    const slash = candidate.indexOf('/')
    if (slash === -1) break
    candidate = candidate.slice(slash + 1)
  }

  for (let dot = candidate.indexOf('.'); dot !== -1; dot = candidate.indexOf('.', dot + 1)) {
    const segment = candidate.slice(dot + 1)
    const icon = extensions[segment] ?? extensions[segment.toLowerCase()]
    if (icon) return icon
  }

  return null
}
