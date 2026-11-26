import { useCallback, useEffect, useMemo, useState } from 'react'
import { LoaderCircle, RotateCw, Search } from 'lucide-react'
import {
  api,
  type CustomModelInput,
  type CustomProviderView,
  type DiscoveredRemoteModel
} from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 16_384

export function formatModelTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

export function toCustomModelInput(candidate: DiscoveredRemoteModel): CustomModelInput {
  return {
    id: candidate.id,
    ...(candidate.name && candidate.name !== candidate.id ? { name: candidate.name } : {}),
    reasoning: candidate.reasoning ?? false,
    vision: candidate.vision ?? false,
    contextWindow: candidate.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: candidate.maxTokens ?? DEFAULT_MAX_TOKENS
  }
}

export function DiscoverModelsDialog({
  provider,
  busy,
  onImport,
  onClose
}: {
  provider: CustomProviderView | null
  busy: boolean
  onImport: (providerId: string, models: CustomModelInput[]) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const [candidates, setCandidates] = useState<DiscoveredRemoteModel[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const existingIds = useMemo(
    () => new Set(provider?.models.map((item) => item.id) ?? []),
    [provider]
  )

  const loadCandidates = useCallback(async (target: CustomProviderView) => {
    setLoading(true)
    setError(null)
    try {
      const discovered = await api.discoverCustomModels({
        providerId: target.id,
        api: target.api,
        baseUrl: target.baseUrl,
        authMode: target.authMode,
        envVar: target.envVar,
        authHeader: target.authHeader
      })
      setCandidates(discovered)
      setSelected(new Set())
    } catch (err) {
      setError(failureMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!provider) return
    setCandidates([])
    setSelected(new Set())
    setQuery('')
    setError(null)
    void loadCandidates(provider)
  }, [provider, loadCandidates])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter(
      (item) =>
        item.id.toLowerCase().includes(q) ||
        (item.name?.toLowerCase().includes(q) ?? false)
    )
  }, [candidates, query])

  const selectableFiltered = useMemo(
    () => filtered.filter((item) => !existingIds.has(item.id)),
    [filtered, existingIds]
  )

  const toggle = (id: string, nextChecked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (nextChecked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const selectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const item of selectableFiltered) next.add(item.id)
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  const submit = async () => {
    if (!provider || busy || selected.size === 0) return
    setError(null)
    try {
      const chosen = candidates
        .filter((item) => selected.has(item.id) && !existingIds.has(item.id))
        .map(toCustomModelInput)
      if (chosen.length === 0) return
      await onImport(provider.id, chosen)
    } catch (err) {
      setError(failureMessage(err))
    }
  }

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('providers.custom.discoverTitle', { name: provider?.name ?? '' })}
          </DialogTitle>
          <DialogDescription>{t('providers.custom.discoverDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <div className="flex items-center gap-2">
            <InputGroup className="flex-1">
              <InputGroupAddon>
                <Search className="size-4 text-muted-foreground" />
              </InputGroupAddon>
              <InputGroupInput
                autoFocus
                value={query}
                disabled={loading || busy}
                placeholder={t('providers.custom.discoverSearch')}
                onChange={(e) => setQuery(e.target.value)}
              />
            </InputGroup>
            {provider ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('model.refresh')}
                disabled={loading || busy}
                onClick={() => void loadCandidates(provider)}
              >
                <RotateCw className={loading ? 'animate-spin' : undefined} />
              </Button>
            ) : null}
          </div>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {loading ? (
            <p role="status" className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t('providers.custom.fetchingModels')}
            </p>
          ) : candidates.length > 0 ? (
            <>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{t('providers.custom.discoverSelected', { count: selected.size })}</span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy || selectableFiltered.length === 0}
                    onClick={selectAllFiltered}
                  >
                    {t('providers.custom.selectAll')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy || selected.size === 0}
                    onClick={clearSelection}
                  >
                    {t('providers.custom.selectNone')}
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-foreground/10 divide-y divide-border/50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {filtered.map((item) => {
                  const alreadyAdded = existingIds.has(item.id)
                  const checked = alreadyAdded || selected.has(item.id)
                  return (
                    <label
                      key={item.id}
                      className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/50 data-[disabled=true]:cursor-default data-[disabled=true]:opacity-60"
                      data-disabled={alreadyAdded || undefined}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={alreadyAdded || busy}
                        onCheckedChange={(val) => toggle(item.id, val === true)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-mono text-xs font-medium">{item.id}</span>
                          {item.reasoning ? (
                            <Badge variant="secondary">{t('providers.custom.badgeReasoning')}</Badge>
                          ) : null}
                          {item.vision ? (
                            <Badge variant="secondary">{t('providers.custom.badgeVision')}</Badge>
                          ) : null}
                          {item.contextWindow ? (
                            <span className="text-xs text-muted-foreground">
                              {formatModelTokens(item.contextWindow)}
                            </span>
                          ) : null}
                        </div>
                        {item.name && item.name !== item.id ? (
                          <p className="truncate text-xs text-muted-foreground">{item.name}</p>
                        ) : null}
                      </div>
                      {alreadyAdded ? (
                        <Badge variant="secondary">{t('providers.custom.discoverAlreadyAdded')}</Badge>
                      ) : null}
                    </label>
                  )
                })}
              </div>
            </>
          ) : !error ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t('providers.custom.discoverEmpty')}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={busy || loading || selected.size === 0}
            onClick={() => void submit()}
          >
            {busy
              ? t('providers.custom.saving')
              : t('providers.custom.discoverImport', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
