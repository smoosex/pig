import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CustomModelCost, CustomModelInput, CustomModelView } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'

const DEFAULT_CONTEXT_WINDOW = '128000'
const DEFAULT_MAX_TOKENS = '16384'

function parseCostField(raw: string): number {
  const trimmed = raw.trim()
  if (!trimmed) return 0
  const num = Number(trimmed)
  if (!Number.isFinite(num) || num < 0) throw new Error('Invalid price')
  return num
}

export function CustomModelDialog({
  open,
  providerName,
  model,
  busy,
  onSave,
  onClose
}: {
  open: boolean
  providerName: string
  model?: CustomModelView
  busy: boolean
  onSave: (input: CustomModelInput) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [reasoning, setReasoning] = useState(false)
  const [vision, setVision] = useState(false)
  const [contextWindow, setContextWindow] = useState(DEFAULT_CONTEXT_WINDOW)
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS)
  const [pricingOpen, setPricingOpen] = useState(false)
  const [pricingEnabled, setPricingEnabled] = useState(false)
  const [costInput, setCostInput] = useState('0')
  const [costOutput, setCostOutput] = useState('0')
  const [costCacheRead, setCostCacheRead] = useState('0')
  const [costCacheWrite, setCostCacheWrite] = useState('0')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setId(model?.id ?? '')
    setName(model && model.name !== model.id ? model.name : '')
    setReasoning(model?.reasoning ?? false)
    setVision(model?.vision ?? false)
    setContextWindow(String(model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW))
    setMaxTokens(String(model?.maxTokens ?? DEFAULT_MAX_TOKENS))
    const hasCost = Boolean(model?.cost)
    setPricingEnabled(hasCost)
    setPricingOpen(hasCost)
    setCostInput(String(model?.cost?.input ?? 0))
    setCostOutput(String(model?.cost?.output ?? 0))
    setCostCacheRead(String(model?.cost?.cacheRead ?? 0))
    setCostCacheWrite(String(model?.cost?.cacheWrite ?? 0))
    setError(null)
  }, [open, model])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError(null)
    try {
      const parsedContext = Number(contextWindow.trim())
      const parsedMaxTokens = Number(maxTokens.trim())
      let cost: CustomModelCost | null | undefined
      if (pricingEnabled) {
        cost = {
          input: parseCostField(costInput),
          output: parseCostField(costOutput),
          cacheRead: parseCostField(costCacheRead),
          cacheWrite: parseCostField(costCacheWrite)
        }
      } else if (model?.cost) {
        cost = null
      }
      await onSave({
        ...(model ? { previousId: model.id } : {}),
        id: id.trim(),
        name: name.trim() || undefined,
        reasoning,
        vision,
        contextWindow: parsedContext,
        maxTokens: parsedMaxTokens,
        ...(cost !== undefined ? { cost } : {})
      })
    } catch (err) {
      setError(failureMessage(err))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{model ? t('providers.custom.editModel') : t('providers.custom.addModel')}</DialogTitle>
          <DialogDescription>{providerName}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <FieldGroup className="gap-3.5">
              <Field>
                <FieldLabel htmlFor="custom-model-id">{t('providers.custom.modelId')}</FieldLabel>
                <Input
                  id="custom-model-id"
                  autoFocus
                  value={id}
                  disabled={busy}
                  placeholder={t('providers.custom.modelIdPlaceholder')}
                  onChange={(e) => setId(e.target.value)}
                />
                <FieldDescription>{t('providers.custom.modelIdHint')}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-model-name">{t('providers.custom.modelName')}</FieldLabel>
                <Input
                  id="custom-model-name"
                  value={name}
                  disabled={busy}
                  placeholder={t('providers.custom.modelNamePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="custom-model-context">{t('providers.custom.contextWindow')}</FieldLabel>
                  <Input
                    id="custom-model-context"
                    type="number"
                    min={1}
                    step={1}
                    value={contextWindow}
                    disabled={busy}
                    onChange={(e) => setContextWindow(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="custom-model-max-tokens">{t('providers.custom.maxTokens')}</FieldLabel>
                  <Input
                    id="custom-model-max-tokens"
                    type="number"
                    min={1}
                    step={1}
                    value={maxTokens}
                    disabled={busy}
                    onChange={(e) => setMaxTokens(e.target.value)}
                  />
                </Field>
              </div>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="custom-model-reasoning">{t('providers.custom.reasoning')}</FieldLabel>
                  <FieldDescription>{t('providers.custom.reasoningHint')}</FieldDescription>
                </FieldContent>
                <Switch
                  id="custom-model-reasoning"
                  checked={reasoning}
                  disabled={busy}
                  onCheckedChange={setReasoning}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="custom-model-vision">{t('providers.custom.vision')}</FieldLabel>
                  <FieldDescription>{t('providers.custom.visionHint')}</FieldDescription>
                </FieldContent>
                <Switch
                  id="custom-model-vision"
                  checked={vision}
                  disabled={busy}
                  onCheckedChange={setVision}
                />
              </Field>
              <Collapsible open={pricingOpen} onOpenChange={setPricingOpen} className="flex flex-col gap-3">
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="self-start px-1.5 text-xs text-muted-foreground">
                    {pricingOpen ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
                    {t('providers.custom.pricing')}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-3 rounded-lg border border-foreground/10 p-3">
                  <Field orientation="horizontal">
                    <FieldLabel htmlFor="custom-model-pricing-enabled">{t('providers.custom.enablePricing')}</FieldLabel>
                    <Switch
                      id="custom-model-pricing-enabled"
                      checked={pricingEnabled}
                      disabled={busy}
                      onCheckedChange={setPricingEnabled}
                    />
                  </Field>
                  {pricingEnabled ? (
                    <div className="grid grid-cols-2 gap-3">
                      <Field>
                        <FieldLabel htmlFor="custom-model-cost-input">{t('providers.custom.costInput')}</FieldLabel>
                        <Input
                          id="custom-model-cost-input"
                          type="number"
                          min={0}
                          step="any"
                          value={costInput}
                          disabled={busy}
                          onChange={(e) => setCostInput(e.target.value)}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="custom-model-cost-output">{t('providers.custom.costOutput')}</FieldLabel>
                        <Input
                          id="custom-model-cost-output"
                          type="number"
                          min={0}
                          step="any"
                          value={costOutput}
                          disabled={busy}
                          onChange={(e) => setCostOutput(e.target.value)}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="custom-model-cost-cache-read">{t('providers.custom.costCacheRead')}</FieldLabel>
                        <Input
                          id="custom-model-cost-cache-read"
                          type="number"
                          min={0}
                          step="any"
                          value={costCacheRead}
                          disabled={busy}
                          onChange={(e) => setCostCacheRead(e.target.value)}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="custom-model-cost-cache-write">{t('providers.custom.costCacheWrite')}</FieldLabel>
                        <Input
                          id="custom-model-cost-cache-write"
                          type="number"
                          min={0}
                          step="any"
                          value={costCacheWrite}
                          disabled={busy}
                          onChange={(e) => setCostCacheWrite(e.target.value)}
                        />
                      </Field>
                    </div>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            </FieldGroup>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !id.trim()}>
              {busy ? t('providers.custom.saving') : t('providers.custom.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
