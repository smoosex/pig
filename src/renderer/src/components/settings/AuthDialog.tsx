import { useEffect, useState } from 'react'
import { useT } from '../../hooks/useT'
import type { SettingsAuthPrompt } from '../../ipc/api'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

export function AuthDialog({
  open,
  title,
  lines,
  prompt,
  busy,
  error,
  onSubmit,
  onCancel
}: {
  open: boolean
  title: string
  lines: string[]
  prompt: (SettingsAuthPrompt & { id: string }) | null
  busy: boolean
  error: string | null
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const t = useT()
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue('')
  }, [prompt?.id])

  const secret = prompt?.type === 'secret'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          onCancel()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{prompt?.message ?? t('providers.promptDefault')}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-2">
          {lines.map((line, i) => (
            <p key={i} className="text-sm break-all text-muted-foreground">
              {line}
            </p>
          ))}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {prompt?.type === 'select' ? (
            <div className="flex flex-col gap-1">
              {prompt.options.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant="outline"
                  className="h-auto justify-start py-2"
                  onClick={() => onSubmit(option.id)}
                >
                  <span className="flex min-w-0 flex-col text-left">
                    <span>{option.label}</span>
                    {option.description ? (
                      <span className="text-xs font-normal text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </Button>
              ))}
            </div>
          ) : prompt ? (
            <Input
              autoFocus
              type={secret ? 'password' : 'text'}
              value={value}
              placeholder={prompt.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault()
                  onSubmit(value)
                }
              }}
            />
          ) : busy ? (
            <p className="text-sm text-muted-foreground">{t('providers.waiting')}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          {prompt && prompt.type !== 'select' ? (
            <Button type="button" disabled={!value.trim()} onClick={() => onSubmit(value)}>
              {t('common.continue')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
