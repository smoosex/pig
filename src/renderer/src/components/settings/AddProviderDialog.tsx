import { Fragment, useEffect, useState } from 'react'
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
          <DialogTitle>{chosen ? chosen.name : '添加供应商'}</DialogTitle>
          <DialogDescription>
            {chosen
              ? '选择连接方式，凭据将交由 pi 管理。'
              : '搜索供应商，登录账号或配置 API 密钥。'}
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
              返回供应商列表
            </Button>
            {chosen.oauth ? (
              <Button
                variant="outline"
                className="h-auto justify-between py-3"
                onClick={() => onConnect(chosen, 'oauth')}
              >
                <span>{chosen.oauth.subscription ? '订阅登录' : '账号登录'}</span>
                <ChevronRight data-icon="inline-end" />
              </Button>
            ) : null}
            {chosen.apiKey?.canLogin ? (
              <Button
                variant="outline"
                className="h-auto justify-between py-3"
                onClick={() => onConnect(chosen, 'api_key')}
              >
                <span>设置 API 密钥</span>
                <ChevronRight data-icon="inline-end" />
              </Button>
            ) : chosen.apiKey ? (
              <p className="text-sm text-muted-foreground">
                此供应商需要通过环境变量或外部凭据配置：{chosen.apiKey.name}
              </p>
            ) : null}
          </div>
        ) : (
          <Command
            loop
            onKeyDownCapture={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation()
            }}
          >
            <CommandInput
              aria-label="搜索供应商"
              placeholder="搜索名称或 ID…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="max-h-80">
              <CommandEmpty>没有匹配的供应商，试试其他名称或关键词。</CommandEmpty>
              {[
                { heading: '订阅登录', items: available.filter((provider) => provider.oauth) },
                {
                  heading: 'API 密钥',
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
                        className="py-3"
                        onSelect={() => setChosen(provider)}
                      >
                        <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                        <span
                          data-slot="command-shortcut"
                          className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
                        >
                          {provider.configured ? '已配置' : null}
                          <ChevronRight />
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </Fragment>
              ))}
            </CommandList>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  )
}
