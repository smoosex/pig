/** Searchable scope selection; original Pi rules survive until explicitly unchecked or removed. */
import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, GripVertical, TriangleAlert } from 'lucide-react'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useScopedModels } from '../../hooks/useScopedModels'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { api, type SessionModelInfo } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { FieldLabel, FieldLegend, FieldSet } from '../ui/field'
import { SettingsRow } from './SettingsFields'

function reference(model: SessionModelInfo): string {
  return `${model.provider}/${model.id}`
}

function ScopeRow({ pattern, models, disabled, onRemove }: {
  pattern: string
  models: SessionModelInfo[]
  disabled: boolean
  onRemove: () => void
}) {
  const t = useT()
  const id = useId()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: pattern, disabled })
  return (
    <div ref={setNodeRef} data-scope-pattern={pattern}
      className={cn('relative flex items-center gap-2 rounded-md bg-popover px-2 py-2', isDragging && 'opacity-50')}
      style={{ transform: CSS.Transform.toString(transform), transition }}>
      <Button type="button" variant="ghost" size="icon-xs" ref={setActivatorNodeRef}
        className="touch-none shrink-0" disabled={disabled}
        aria-label={t('model.scopeReorder', { name: pattern })} {...attributes} {...listeners}>
        <GripVertical />
      </Button>
      <Checkbox id={id} checked disabled={disabled} onCheckedChange={onRemove} />
      <FieldLabel htmlFor={id} className="min-w-0 flex-1 cursor-pointer flex-col gap-0.5">
        <span className="w-full truncate text-xs">{models.length === 1 ? models[0].name : pattern}</span>
        <span className="w-full truncate text-xs font-normal text-muted-foreground">{pattern}</span>
      </FieldLabel>
    </div>
  )
}

export function ScopedModelsSetting() {
  const t = useT()
  const scope = useScopedModels(true)
  const models = useModelCatalogStore((s) => s.models)
  const [patterns, setPatterns] = useState(scope.patterns)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  useEffect(() => {
    if (!saving) setPatterns(scope.patterns)
  }, [scope.patterns, saving])

  const save = async (next: string[]) => {
    if (saving) return
    setPatterns(next)
    setSaving(true)
    setError(null)
    try {
      await api.setScopedModels(next)
      await scope.load()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  const selected = useMemo(() => [...new Set(patterns)].map((pattern) => ({
    pattern,
    models: scope.selections.find((entry) => entry.pattern === pattern)?.models
      ?? models.filter((model) => reference(model) === pattern)
  })), [patterns, scope.selections, models])
  const selectedKeys = new Set(selected.flatMap((entry) => entry.models.map(reference)))
  const q = query.trim().toLowerCase()
  const matches = (value: string) => value.toLowerCase().includes(q)
  const shownSelected = selected.filter((entry) => matches(`${entry.pattern} ${entry.models.map((m) => `${m.name} ${m.providerName}`).join(' ')}`))
  const available = models.filter((model) => !selectedKeys.has(reference(model)) && matches(`${model.name} ${model.providerName} ${reference(model)}`))
  const disabled = saving || !scope.loaded

  return (
    <SettingsRow title={t('model.scope')} description={t('model.scopeDescription')}>
      <div className="flex items-center gap-2">
        {scope.warnings.length || error || scope.error ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm"
                className="text-warning" aria-label={t('model.scopeWarnings')}
                title={t('model.scopeWarnings')}>
                <TriangleAlert />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96 max-w-[var(--radix-popover-content-available-width)]">
              <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                <p className="text-sm font-medium">{t('model.scopeWarnings')}</p>
                {error ?? scope.error ? <Alert variant="destructive"><AlertDescription>{error ?? scope.error}</AlertDescription></Alert> : null}
                {scope.warnings.map((warning, index) => <p key={index} className="break-words text-xs text-muted-foreground">{warning}</p>)}
                {scope.missingProviderPatterns.length ? <>
                  <p className="text-xs text-muted-foreground">{t('model.scopeCleanupDescription')}</p>
                  <Button type="button" size="sm" variant="outline" disabled={disabled}
                    className="self-start" onClick={() => void save(patterns.filter((pattern) => !scope.missingProviderPatterns.includes(pattern)))}>
                    {t('model.scopeCleanup')}
                  </Button>
                </> : null}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
        <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery('') }}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={!scope.loaded}
              className="justify-between" aria-label={t('model.scope')} aria-busy={saving}>
              {patterns.length ? t('model.scopeSelected', { count: selected.length }) : t('model.scopeChoose')}
              <ChevronDown data-icon="inline-end" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96 max-w-[var(--radix-popover-content-available-width)] gap-2 p-2">
            <Input autoFocus value={query} aria-label={t('model.search')} placeholder={t('model.search')}
              onChange={(event) => setQuery(event.target.value)} />
            <div className="max-h-80 overflow-y-auto">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
                if (!over || active.id === over.id) return
                const from = patterns.indexOf(String(active.id))
                const to = patterns.indexOf(String(over.id))
                if (from >= 0 && to >= 0) void save(arrayMove(patterns, from, to))
              }}>
                <FieldSet className="gap-1">
                  <FieldLegend className="sr-only">{t('model.scope')}</FieldLegend>
                  <SortableContext items={shownSelected.map((entry) => entry.pattern)} strategy={verticalListSortingStrategy}>
                    {shownSelected.map((entry) => <ScopeRow key={entry.pattern} {...entry} disabled={disabled}
                      onRemove={() => void save(patterns.filter((pattern) => pattern !== entry.pattern))} />)}
                  </SortableContext>
                  {available.map((model) => (
                    <FieldLabel key={reference(model)} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-accent">
                      <Checkbox checked={false} disabled={disabled} onCheckedChange={() => void save([...patterns, reference(model)])} />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-xs">{model.name}</span>
                        <span className="truncate text-xs font-normal text-muted-foreground">{model.providerName} · {reference(model)}</span>
                      </span>
                    </FieldLabel>
                  ))}
                </FieldSet>
              </DndContext>
              {!shownSelected.length && !available.length ? <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('model.noMatch')}</p> : null}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </SettingsRow>
  )
}
