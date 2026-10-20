/** Local directory browser; main owns filesystem access and the existing project registration flow. */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, ChevronRight, Folder, GitBranch, Home, LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react'
import { api, type ProjectDirectoryListing, type ProjectDirectorySearch } from '../../ipc/api'
import { useSessionsStore } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { cn, hideScroll } from '../../lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { SmoothHoverHighlight } from '../ui/smooth-hover-highlight'

export function ProjectPickerDialog() {
  const open = useSessionsStore((s) => s.projectPickerOpen)
  const setOpen = useSessionsStore((s) => s.setProjectPickerOpen)
  return open ? <ProjectBrowser onClose={() => setOpen(false)} /> : null
}

function ProjectBrowser({ onClose }: { onClose: () => void }) {
  const t = useT()
  const openProject = useSessionsStore((s) => s.openProject)
  const id = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef(document.activeElement as HTMLElement | null)
  const savingRef = useRef(false)
  const [target, setTarget] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [showHidden, setShowHidden] = useState(false)
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [deep, setDeep] = useState(false)
  const [search, setSearch] = useState<ProjectDirectorySearch | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const needle = query.trim()
  const deepActive = deep && !!needle && !!listing && !browseError

  useEffect(() => {
    // Old requests may finish after navigating again or closing; only this location owns the result.
    let current = true
    setLoading(true)
    setError(null)
    setBrowseError(null)
    void api.browseProjectDirectories(target, showHidden).then((next) => {
      if (!current) return
      setListing(next)
      setPathInput(next.path)
      setActive(0)
      setLoading(false)
    }, (failure: unknown) => {
      if (!current) return
      setBrowseError(failure instanceof Error ? failure.message : String(failure))
      setLoading(false)
    })
    return () => { current = false }
  }, [target, showHidden, revision])

  useEffect(() => {
    setSearch(null)
    setSearchError(null)
    if (!deepActive) return
    // Typing restarts the walk after a pause; a result only counts for the folder/query/visibility it was asked for.
    let current = true
    let started = false
    const timer = setTimeout(() => {
      started = true
      void api.searchProjectDirectories(listing.path, needle, showHidden).then((next) => {
        if (current) setSearch(next)
      }, (failure: unknown) => {
        if (current) setSearchError(failure instanceof Error ? failure.message : String(failure))
      })
    }, 200)
    return () => {
      current = false
      clearTimeout(timer)
      // Closing, turning search off or changing the query also stops the walk in main, not just its result.
      if (started) void api.cancelProjectDirectorySearch()
    }
  }, [deepActive, listing, needle, showHidden])

  const searching = deepActive && !search && !searchError
  const folders = useMemo((): { name: string; path: string; git: boolean | null; warning?: string; location?: string }[] => {
    if (deepActive) {
      return (search?.directories ?? []).map((folder) => {
        const parent = folder.relativePath.slice(0, folder.relativePath.length - folder.name.length).replace(/[\\/]$/, '')
        return { ...folder, location: parent || undefined }
      })
    }
    const lower = needle.toLocaleLowerCase()
    return (listing?.directories ?? []).filter((folder) => folder.name.toLocaleLowerCase().includes(lower))
      .sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(lower)) - Number(a.name.toLocaleLowerCase().startsWith(lower)))
  }, [deepActive, search, listing, needle])
  const selected = folders[active]
  const canAdd = !!listing && !loading && !adding && !browseError && pathInput === listing.path

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-directory-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, folders])

  const navigate = (path?: string) => {
    if (savingRef.current) return
    setLoading(true)
    setBrowseError(null)
    setError(null)
    setTarget(path)
    setQuery('')
    setActive(0)
    setRevision((value) => value + 1)
  }

  const add = async () => {
    if (!canAdd || savingRef.current || !listing) return
    savingRef.current = true
    setAdding(true)
    setError(null)
    // Registration failures belong to this dialog: keep it open and show the error for an explicit retry.
    try {
      await openProject(listing.path)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      savingRef.current = false
      setAdding(false)
    }
  }

  const navigateKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (loading || searching || adding) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => folders.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + folders.length) % folders.length : 0)
    } else if ((event.key === 'Enter' || (event.key === 'ArrowRight' && event.currentTarget === listRef.current)) && selected) {
      event.preventDefault()
      navigate(selected.path)
    } else if ((event.key === 'ArrowLeft' || event.key === 'Backspace') && !query && event.currentTarget === listRef.current && listing?.parent) {
      event.preventDefault()
      navigate(listing.parent)
    } else if (event.key === 'Tab' && !event.shiftKey && query && selected && query !== selected.name && selected.name.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) {
      event.preventDefault()
      setQuery(selected.name)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !savingRef.current) onClose() }}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-xl"
        showCloseButton={!adding}
        onEscapeKeyDown={(event) => { if (savingRef.current) event.preventDefault() }}
        onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus() }}
        onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus({ preventScroll: true }) }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.metaKey || event.ctrlKey) event.stopPropagation()
          if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'w') {
            event.preventDefault()
            event.stopPropagation()
            if (!savingRef.current) onClose()
          } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            void add()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('projectPicker.title')}</DialogTitle>
          <DialogDescription>{t('projectPicker.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" title={t('projectPicker.home')} aria-label={t('projectPicker.home')} disabled={adding} onClick={() => navigate(listing?.home)}><Home /></Button>
          <Button variant="ghost" size="icon-sm" title={t('projectPicker.parent')} aria-label={t('projectPicker.parent')} disabled={!listing?.parent || adding} onClick={() => navigate(listing!.parent!)}><ArrowUp /></Button>
          <Input
            aria-label={t('projectPicker.path')}
            placeholder={t('projectPicker.pathPlaceholder')}
            value={pathInput}
            disabled={adding}
            className="min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                event.preventDefault()
                event.stopPropagation()
                navigate(pathInput)
              }
            }}
          />
          <Button variant="outline" size="sm" disabled={!pathInput.trim() || adding} onClick={() => navigate(pathInput)}>{t('projectPicker.go')}</Button>
          <Button variant="ghost" size="icon-sm" title={t('projectPicker.refresh')} aria-label={t('projectPicker.refresh')} disabled={loading || adding} onClick={() => navigate(target)}><RotateCw className={loading ? 'animate-spin' : undefined} /></Button>
        </div>
        {listing ? <nav aria-label={t('projectPicker.path')} className={cn('flex shrink-0 items-center gap-0.5 overflow-x-auto', hideScroll)}>
          {listing.breadcrumbs.map((crumb, index) => <div key={crumb.path} className="flex shrink-0 items-center">
            {index > 0 ? <ChevronRight className="size-3 text-muted-foreground" /> : null}
            <Button variant="ghost" size="xs" disabled={adding} aria-current={crumb.path === listing.path ? 'location' : undefined} onClick={() => navigate(crumb.path)}>{crumb.name}</Button>
          </div>)}
        </nav> : null}
        <div className="flex items-center gap-3">
          <Input
            className="min-w-0 flex-1"
            ref={searchRef}
            value={query}
            disabled={adding}
            placeholder={t('projectPicker.search')}
            aria-label={t('projectPicker.search')}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={`${id}-folders`}
            aria-activedescendant={!loading && !searching && selected ? `${id}-folder-${active}` : undefined}
            onChange={(event) => { setQuery(event.target.value); setActive(0) }}
            onKeyDown={(event) => { if (!event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey) navigateKeys(event) }}
          />
          <div className="flex h-8 shrink-0 flex-col justify-center gap-1">
            <div className="flex h-3.5 items-center justify-end gap-2">
              <Label htmlFor={`${id}-deep`} className="text-[0.6875rem] leading-none font-normal">{t('projectPicker.deep')}</Label>
              <Switch id={`${id}-deep`} size="sm" checked={deep} disabled={adding} onCheckedChange={(checked) => { setDeep(checked); setActive(0) }} />
            </div>
            <div className="flex h-3.5 items-center justify-end gap-2">
              <Label htmlFor={`${id}-hidden`} className="text-[0.6875rem] leading-none font-normal">{t('projectPicker.hidden')}</Label>
              <Switch id={`${id}-hidden`} size="sm" checked={showHidden} disabled={adding} onCheckedChange={(checked) => { setShowHidden(checked); if (!deep) setQuery('') }} />
            </div>
          </div>
        </div>
        {browseError ?? searchError ?? error ? <p role="alert" className="break-words text-xs text-destructive">{browseError ?? searchError ?? error}</p> : null}
        <div ref={listRef} id={`${id}-folders`} role="listbox" aria-label={t('projectPicker.folders')} aria-busy={loading || searching} aria-activedescendant={!loading && !searching && selected ? `${id}-folder-${active}` : undefined} tabIndex={0} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey) navigateKeys(event) }} className={cn('h-64 min-h-0 overflow-auto outline-none', hideScroll)}>
          {loading || searching ? <p role="status" className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{t(loading ? 'projectPicker.loading' : 'projectPicker.searching')}</p> : !folders.length ? <p className="py-12 text-center text-xs text-muted-foreground">{t(query ? 'projectPicker.noMatch' : 'projectPicker.empty')}</p> : <SmoothHoverHighlight activeKey={active} highlightClassName="bg-glass-prompt-foreground/8 solid:bg-accent">
            {folders.map((folder, index) => <Button
              key={folder.path}
              id={`${id}-folder-${index}`}
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              variant="ghost"
              disabled={adding}
              data-directory-index={index}
              data-hover-highlight-row
              data-hover-highlight-active={index === active ? '' : undefined}
              className="relative h-9 w-full justify-start gap-2 px-2 font-normal hover:bg-transparent!"
              onPointerMove={() => setActive(index)}
              onClick={() => navigate(folder.path)}
            >
              <Folder className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left text-xs">
                {folder.name}
                {folder.location ? <span className="ml-2 text-muted-foreground">{folder.location}</span> : null}
              </span>
              {folder.warning ? <span title={folder.warning}><TriangleAlert className="size-4 text-warning" aria-label={folder.warning} /></span> : folder.git ? <GitBranch className="text-muted-foreground" aria-label={t('projectPicker.git')} /> : null}
              <ChevronRight className="text-muted-foreground" />
            </Button>)}
          </SmoothHoverHighlight>}
        </div>
        {deepActive ? search?.truncated ? <p className="text-xs text-warning">{t('projectPicker.searchTruncated')}</p> : null : listing?.truncated ? <p className="text-xs text-warning">{t('projectPicker.truncated')}</p> : null}
        <p className="text-xs text-muted-foreground">{t('projectPicker.hint')}</p>
        <DialogFooter className="items-center">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={listing?.path}>{listing?.path}</p>
          <Button variant="outline" disabled={adding} onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!canAdd} onClick={() => void add()}>{adding ? <LoaderCircle className="animate-spin" /> : null}{t(adding ? 'projectPicker.adding' : 'projectPicker.add')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
