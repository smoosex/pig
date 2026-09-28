import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api, type PluginUIEvent } from '../ipc/api'
import { useT } from '../hooks/useT'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'

type Prompt = Extract<PluginUIEvent, { kind: 'prompt' }>
type Notice = Extract<PluginUIEvent, { kind: 'notify' }>

export function PluginUI({ activeSessionId }: { activeSessionId: string | null }) {
  const t = useT()
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [notices, setNotices] = useState<(Notice & { id: number })[]>([])
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const [widgets, setWidgets] = useState<Record<string, string[]>>({})
  const [value, setValue] = useState('')
  const [expandedNotice, setExpandedNotice] = useState<number | null>(null)
  const prompt = prompts[0]
  const notice = prompt ? undefined : notices.find((item) => item.id === expandedNotice)

  useEffect(() => api.onPluginUI((event) => {
    if (event.kind === 'prompt') setPrompts((items) => [...items, event])
    if (event.kind === 'dismiss') setPrompts((items) => items.filter((item) => item.id !== event.id))
    if (event.kind === 'notify') {
      const id = Date.now() + Math.random()
      setNotices((items) => [...items.slice(-8), { ...event, id }])
      if (event.message.length > 240 || event.message.includes('\n')) setExpandedNotice(id)
      else setTimeout(() => setNotices((items) => items.filter((item) => item.id !== id)), 8_000)
    }
    if (event.kind === 'status') setStatuses((items) => {
      const next = { ...items }
      const key = `${event.sessionId}:${event.key}`
      if (event.text) next[key] = event.text
      else delete next[key]
      return next
    })
    if (event.kind === 'widget') setWidgets((items) => {
      const next = { ...items }
      const key = `${event.sessionId}:${event.key}`
      if (event.lines?.length) next[key] = event.lines
      else delete next[key]
      return next
    })
  }), [])

  useEffect(() => {
    setValue(prompt?.method === 'editor' ? prompt.prefill ?? '' : '')
  }, [prompt?.id, prompt?.method, prompt?.prefill])

  const reply = (answer: string | boolean | null) => {
    if (!prompt) return
    void api.replyPluginUI(prompt.id, answer)
    setPrompts((items) => items.filter((item) => item.id !== prompt.id))
  }
  const closeNotice = (id: number) => {
    setNotices((items) => items.filter((item) => item.id !== id))
    if (expandedNotice === id) setExpandedNotice(null)
  }
  const activeStatuses = Object.entries(statuses).filter(([key]) => key.startsWith(`${activeSessionId}:`))
  const activeWidgets = Object.entries(widgets).filter(([key]) => key.startsWith(`${activeSessionId}:`))
  const compactNotices = notices.filter((item) => item.id !== expandedNotice && item.message.length <= 240 && !item.message.includes('\n'))

  return (
    <>
      {(compactNotices.length > 0 || activeStatuses.length > 0 || activeWidgets.length > 0) && (
        <div className="fixed right-4 bottom-4 z-40 flex max-w-sm flex-col gap-2" aria-live="polite">
          {activeStatuses.map(([key, text]) => (
            <p key={key} className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">{text}</p>
          ))}
          {activeWidgets.map(([key, lines]) => (
            <p key={key} className="rounded-lg border bg-popover px-3 py-2 text-xs whitespace-pre-wrap text-popover-foreground shadow-md">{lines.join('\n')}</p>
          ))}
          {compactNotices.map((item) => (
            <div key={item.id} role="status" className="flex items-start gap-2 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
              <span className={item.level === 'error' ? 'text-destructive' : ''}>{item.message}</span>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={t('common.cancel')} onClick={() => closeNotice(item.id)}><X /></Button>
            </div>
          ))}
        </div>
      )}
      <Dialog open={!!prompt} onOpenChange={(open) => { if (!open) reply(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{prompt?.title}</DialogTitle>
            {prompt?.message ? <DialogDescription>{prompt.message}</DialogDescription> : null}
          </DialogHeader>
          {prompt?.method === 'select' ? (
            <div className="flex max-h-64 flex-col gap-1 overflow-auto">
              {prompt.options?.map((option) => (
                <Button key={option} variant="outline" className="justify-start" onClick={() => reply(option)}>{option}</Button>
              ))}
            </div>
          ) : prompt?.method === 'input' ? (
            <Input autoFocus placeholder={prompt.message} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) reply(value)
            }} />
          ) : prompt?.method === 'editor' ? (
            <Textarea autoFocus rows={8} value={value} onChange={(event) => setValue(event.target.value)} />
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => reply(prompt?.method === 'confirm' ? false : null)}>{t('common.cancel')}</Button>
            {prompt?.method === 'confirm' ? (
              <Button onClick={() => reply(true)}>{t('common.continue')}</Button>
            ) : prompt?.method === 'input' || prompt?.method === 'editor' ? (
              <Button onClick={() => reply(value)}>{t('common.continue')}</Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!notice} onOpenChange={(open) => { if (!open && notice) closeNotice(notice.id) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Plugin</DialogTitle></DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap break-words">{notice?.message}</div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { if (notice) void navigator.clipboard.writeText(notice.message) }}>{t('common.copyAll')}</Button>
            <Button onClick={() => { if (notice) closeNotice(notice.id) }}>{t('common.continue')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
