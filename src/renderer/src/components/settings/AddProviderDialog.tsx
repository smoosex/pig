import { Fragment, useEffect, useState } from 'react'
import { useT } from '../../hooks/useT'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ProviderAuthType, SettingsProvider } from '../../ipc/api'
import { Button } from '../ui/button'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator
} from '../ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { SmoothHoverHighlight } from '../ui/smooth-hover-highlight'

export function AddProviderDialog({
  open,
  onOpenChange,
  providers,
  onConnect
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: SettingsProvider[]
  onConnect: (provider: SettingsProvider, method: ProviderAuthType) => void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<SettingsProvider | null>(null)
  const available = providers.filter((provider) => provider.oauth || provider.apiKey)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setChosen(null)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{chosen ? chosen.name : t('providers.add')}</DialogTitle>
          <DialogDescription>
            {chosen
              ? t('providers.addDescription')
              : t('providers.pickDescription')}
          </DialogDescription>
        </DialogHeader>
        {chosen ? (
          <div className="flex flex-col gap-3">
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setChosen(null)}
            >
              <ChevronLeft data-icon="inline-start" />
              {t('providers.backToList')}
            </Button>
            {chosen.oauth ? (
              <Button
                variant="outline"
                className="h-auto justify-between py-3"
                onClick={() => onConnect(chosen, 'oauth')}
              >
                <span>{chosen.oauth.subscription ? t('providers.subscriptionLogin') : t('providers.accountLogin')}</span>
                <ChevronRight data-icon="inline-end" />
              </Button>
            ) : null}
            {chosen.apiKey?.canLogin ? (
              <Button
                variant="outline"
                className="h-auto justify-between py-3"
                onClick={() => onConnect(chosen, 'api_key')}
              >
                <span>{t('providers.setKey')}</span>
                <ChevronRight data-icon="inline-end" />
              </Button>
            ) : chosen.apiKey ? (
              <p className="text-sm text-muted-foreground">
                {t('providers.environmentNote', { name: chosen.apiKey.name })}
              </p>
            ) : null}
          </div>
        ) : (
          <Command
            loop
            // cmdk selects its first row on mount unless the value it starts with matches nothing;
            // a chooser has to open without a hover, so the list waits for real input.
            defaultValue=" "
            onKeyDownCapture={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation()
            }}
          >
            <CommandInput
              aria-label={t('providers.searchProviders')}
              placeholder={t('providers.searchPlaceholder')}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="max-h-80">
              <SmoothHoverHighlight
                activeSelector="[data-selected='true']"
                activeAttribute="data-selected"
                highlightClassName="bg-glass-prompt-foreground/8 solid:bg-accent"
              >
                <CommandEmpty>{t('providers.noMatch')}</CommandEmpty>
                {[
                  { heading: t('providers.subscriptionLogin'), items: available.filter((provider) => provider.oauth) },
                  {
                    heading: t('providers.apiKey'),
                    items: available.filter((provider) => !provider.oauth && provider.apiKey)
                  }
                ].map(({ heading, items }, index) => (
                  <Fragment key={heading}>
                    {index > 0 ? <CommandSeparator /> : null}
                    <CommandGroup heading={heading}>
                      {items.map((provider) => (
                        <CommandItem
                          key={provider.id}
                          value={provider.id}
                          keywords={[provider.name]}
                          data-hover-highlight-row
                          className="py-3 data-selected:bg-transparent!"
                          onSelect={() => setChosen(provider)}
                        >
                          <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                          <span
                            data-slot="command-shortcut"
                            className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
                          >
                            {provider.configured ? t('providers.configured') : null}
                            <ChevronRight />
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </Fragment>
                ))}
              </SmoothHoverHighlight>
            </CommandList>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  )
}
