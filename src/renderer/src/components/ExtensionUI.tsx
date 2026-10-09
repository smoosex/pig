/** SDK dialogs live outside settings and session panes so OAuth can complete while navigation changes. */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type ExtensionUIEvent } from '../ipc/api'
import { useT } from '../hooks/useT'
import { useSessionsStore, selectActiveSessionId } from '../stores/sessions'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select'

type Prompt = Extract<ExtensionUIEvent, { kind: 'prompt' }>
function ExtensionPrompt({ prompt, reply }: { prompt: Prompt; reply(value: string | null): void }) {
  const t = useT()
  const [value, setValue] = useState(prompt.prefill ?? '')
  const valid = prompt.method !== 'select' || prompt.options?.includes(value)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) reply(null)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{prompt.title}</DialogTitle>
          <DialogDescription>{prompt.message || t('mcp.promptDescription')}</DialogDescription>
        </DialogHeader>
        {prompt.method !== 'confirm' ? (
          <Field>
            <FieldLabel htmlFor="extension-prompt">{prompt.title}</FieldLabel>
            {prompt.method === 'select' ? (
              <Select value={value} onValueChange={setValue}>
                <SelectTrigger id="extension-prompt">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {prompt.options?.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : prompt.method === 'editor' ? (
              <Textarea
                id="extension-prompt"
                rows={8}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoFocus
              />
            ) : (
              <Input
                id="extension-prompt"
                value={value}
                placeholder={prompt.message}
                onChange={(event) => setValue(event.target.value)}
                autoFocus
              />
            )}
          </Field>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => reply(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!valid}
            onClick={() => reply(prompt.method === 'confirm' ? 'yes' : value)}
          >
            {t('common.continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
export function ExtensionUI() {
  const active = useSessionsStore(selectActiveSessionId)
  const [prompts, setPrompts] = useState<Prompt[]>([])
  useEffect(
    () =>
      api.onExtensionUI((event) => {
        if (event.kind === 'dismiss')
          setPrompts((items) => items.filter((item) => item.id !== event.id))
        else if (event.kind === 'prompt') setPrompts((items) => [...items, event])
        else if (
          event.owner.startsWith('mcp:') ||
          event.owner === selectActiveSessionId(useSessionsStore.getState())
        ) {
          const notify =
            event.level === 'error'
              ? toast.error
              : event.level === 'warning'
                ? toast.warning
                : toast
          notify(event.message)
        }
      }),
    []
  )
  const prompt = prompts.find((item) => item.owner.startsWith('mcp:') || item.owner === active)
  return prompt ? (
    <ExtensionPrompt
      key={prompt.id}
      prompt={prompt}
      reply={(value) => {
        setPrompts((items) => items.filter((item) => item.id !== prompt.id))
        void api.replyExtensionUI(prompt.id, value).catch((error) => toast.error(String(error)))
      }}
    />
  ) : null
}
