/** Debounced workspace search; changing the filter or leaving the tree cancels the old scan. */
import { useEffect, useState } from 'react'
import type { FileSearchResult } from '../../../../shared/api'
import { api } from '../../ipc/api'
import { failureMessage } from '../../lib/ipc-error'
import type { DirectoryState } from '../../stores/files'

export function useFileFilter(cwd: string, query: string, hideIgnored: boolean, directories: Record<string, DirectoryState> | undefined) {
  const needle = query.trim()
  const key = JSON.stringify([cwd, needle, hideIgnored])
  const [state, setState] = useState<{ key: string; result?: FileSearchResult; error?: string }>()
  // Notifications and local mutations both refresh directory snapshots; reuse that invalidation.
  useEffect(() => {
    if (!needle) return
    let active = true, sent = false
    const timer = setTimeout(() => {
      sent = true
      void api.searchFiles(cwd, needle, hideIgnored).then(
        result => { if (active) setState({ key, result }) },
        error => { if (active) setState({ key, error: failureMessage(error) }) }
      )
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
      if (sent) void api.cancelFileSearch().catch(error => console.error('Unable to cancel file search', error))
    }
  }, [cwd, needle, hideIgnored, key, directories])
  const current = state?.key === key ? state : undefined
  return { entries: current?.result?.entries ?? [], truncated: current?.result?.truncated ?? false,
    loading: !!needle && !current?.result && !current?.error, error: current?.error }
}
