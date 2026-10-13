import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { GitBranch, GitCommitHorizontal, GitPullRequest, Folder, FileDiff, SlidersHorizontal, ArrowLeft, Check, ListChecks } from 'lucide-react'
import { Toaster, toast } from 'sonner'
import { api, type SystemUIEvent, type ReviewOption } from '../ipc/api'
import type { MessageKey } from '../../../shared/i18n'
import { useT } from '../hooks/useT'
import { useSettingsStore } from '../stores/settings'
import { useSystemUIStore } from '../stores/system-ui'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command'
import { InputGroup, InputGroupInput, InputGroupTextarea } from './ui/input-group'

type Prompt = Extract<SystemUIEvent, { kind: 'review-prompt' }>
type Notice = Extract<SystemUIEvent, { kind: 'notify' }> & { id: string; expiresAt: number }
const NOTICE_TTL_MS = 8_000
const MAX_SESSION_NOTICES = 5
const MAX_NOTICES = 20
const optionKeys: Record<string, [MessageKey, MessageKey]> = {
  uncommitted: ['reviewUI.uncommitted', 'reviewUI.uncommittedDescription'],
  baseBranch: ['reviewUI.baseBranch', 'reviewUI.baseBranchDescription'],
  commit: ['reviewUI.commitOption', 'reviewUI.commitDescription'],
  pullRequest: ['reviewUI.pullRequest', 'reviewUI.pullRequestDescription'],
  folder: ['reviewUI.folder', 'reviewUI.folderDescription'],
  toggleCustomInstructions: ['reviewUI.instructionsOption', 'reviewUI.instructionsDescription'],
  removeInstructions: ['reviewUI.removeInstructions', 'reviewUI.removeInstructionsDescription'],
  emptyBranch: ['reviewUI.emptyBranch', 'reviewUI.emptyBranchDescription'],
  currentSession: ['reviewUI.currentSession', 'reviewUI.currentSessionDescription'],
  returnOnly: ['reviewUI.returnOnly', 'reviewUI.returnOnlyDescription'],
  returnAndFix: ['reviewUI.returnAndFix', 'reviewUI.returnAndFixDescription'],
  returnAndSummarize: ['reviewUI.returnAndSummarize', 'reviewUI.returnAndSummarizeDescription']
}
const optionIcons = {
  uncommitted: FileDiff, baseBranch: GitBranch, commit: GitCommitHorizontal, pullRequest: GitPullRequest,
  folder: Folder, toggleCustomInstructions: SlidersHorizontal, removeInstructions: SlidersHorizontal,
  emptyBranch: GitBranch, currentSession: ListChecks, returnOnly: ArrowLeft,
  returnAndFix: Check, returnAndSummarize: ListChecks
}

function ReviewPanel({ prompt, reply }: { prompt: Prompt; reply: (value: string | null) => void }) {
  const t = useT()
  const [value, setValue] = useState(prompt.prefill ?? '')
  const [selected, setSelected] = useState(prompt.options?.find((option) => option.recommended)?.value ?? '')
  const options = prompt.options ?? []
  const optionCopy = (option: ReviewOption) => {
    const keys = prompt.step === 'preset' || prompt.step === 'start' || prompt.step === 'finish' ? optionKeys[option.value] : undefined
    return { label: keys ? t(keys[0]) : option.label, description: keys ? t(keys[1]) : option.description }
  }
  const title = t(`reviewUI.${prompt.step}`)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) reply(null) }}>
      <DialogContent className="gap-3 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('reviewUI.panelDescription')}</DialogDescription>
        </DialogHeader>
        {prompt.method === 'choose' ? (
          <Command value={selected} onValueChange={setSelected} onKeyDownCapture={(event) => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.stopPropagation()
          }}>
            <CommandInput autoFocus placeholder={t('reviewUI.search')} />
            <CommandList>
              <CommandEmpty>{t('reviewUI.noMatches')}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => {
                  const { label, description } = optionCopy(option)
                  const Icon = prompt.step === 'branch' ? GitBranch : prompt.step === 'commit' ? GitCommitHorizontal : optionIcons[option.value as keyof typeof optionIcons] ?? ListChecks
                  return (
                    <CommandItem key={option.value} value={option.value} keywords={[label, description ?? '']} onSelect={() => reply(option.value)}>
                      <Icon />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span>{label}</span>
                        {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
                      </div>
                      {option.recommended ? <Badge variant="secondary">{t('reviewUI.recommended')}</Badge> : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <InputGroup>
            {prompt.step === 'pr' ? (
              <InputGroupInput autoFocus aria-label={title} placeholder={t('reviewUI.prPlaceholder')} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) reply(value)
              }} />
            ) : (
              <InputGroupTextarea autoFocus aria-label={title} rows={6} placeholder={t(prompt.step === 'folders' ? 'reviewUI.foldersPlaceholder' : 'reviewUI.instructionsPlaceholder')} value={value} onChange={(event) => setValue(event.target.value)} />
            )}
          </InputGroup>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => reply(null)}>{t('common.cancel')}</Button>
          {prompt.method === 'edit' ? <Button onClick={() => reply(value)}>{t('common.continue')}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SystemPluginUI({ activeSessionId }: { activeSessionId: string | null }) {
  const t = useT()
  const appearance = useSettingsStore((state) => state.appearance)
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [notices, setNotices] = useState<Notice[]>([])
  const [detail, setDetail] = useState<Notice | null>(null)
  const visible = useRef(new Set<string>())
  const prompt = prompts.find((item) => item.sessionId === activeSessionId)
  useEffect(() => api.onSystemUI((event) => {
    if (event.kind === 'review-prompt') setPrompts((items) => [...items, event])
    if (event.kind === 'dismiss') setPrompts((items) => items.filter((item) => item.id !== event.id))
    if (event.kind === 'notify') {
      const now = Date.now()
      const notice = { ...event, id: crypto.randomUUID(), expiresAt: now + NOTICE_TTL_MS }
      setNotices((items) => {
        const fresh = items.filter((item) => item.expiresAt > now)
        const retained = new Set(fresh
          .filter((item) => item.sessionId === event.sessionId)
          .slice(-(MAX_SESSION_NOTICES - 1))
          .map((item) => item.id))
        return [...fresh.filter((item) => item.sessionId !== event.sessionId || retained.has(item.id)), notice].slice(-MAX_NOTICES)
      })
    }
    if (event.kind === 'review-state') useSystemUIStore.getState().setReviewActive(event.sessionId, event.active)
    if (event.kind === 'review-returning') useSystemUIStore.getState().setReviewReturning(event.sessionId, event.returning)
    if (event.kind === 'reset') {
      setPrompts((items) => items.filter((item) => item.sessionId !== event.sessionId))
      setNotices((items) => items.filter((item) => item.sessionId !== event.sessionId))
      useSystemUIStore.getState().setReviewActive(event.sessionId, false)
      useSystemUIStore.getState().setReviewReturning(event.sessionId, false)
      setDetail((item) => item?.sessionId === event.sessionId ? null : item)
    }
  }), [])
  // Expiry starts at receipt, so switching back cannot replay or renew an old backlog.
  useEffect(() => {
    if (notices.length === 0) return
    const nextExpiry = Math.min(...notices.map((item) => item.expiresAt))
    const timer = window.setTimeout(() => {
      const now = Date.now()
      setNotices((items) => items.filter((item) => item.expiresAt > now))
    }, Math.max(0, nextExpiry - Date.now()))
    return () => window.clearTimeout(timer)
  }, [notices])
  useEffect(() => {
    const now = Date.now()
    const active = notices.filter((item) => item.sessionId === activeSessionId && item.expiresAt > now)
    const ids = new Set(active.map((item) => item.id))
    for (const id of visible.current) {
      if (!ids.has(id)) { toast.dismiss(id); visible.current.delete(id) }
    }
    for (const item of active) {
      if (visible.current.has(item.id)) continue
      visible.current.add(item.id)
      const long = item.message.length > 240 || item.message.includes('\n')
      const remove = () => setNotices((items) => items.filter((notice) => notice.id !== item.id))
      const show = item.level === 'error' ? toast.error : item.level === 'warning' ? toast.warning : toast
      show(long ? `${item.message.split('\n')[0].slice(0, 160)}…` : item.message, {
        id: item.id, duration: item.expiresAt - now,
        description: t(`systemUI.${item.plugin}`),
        action: long ? { label: t('systemUI.details'), onClick: () => { remove(); setDetail(item) } } : undefined,
        onDismiss: remove, onAutoClose: remove
      })
    }
  }, [notices, activeSessionId, t])
  useEffect(() => () => { for (const id of visible.current) toast.dismiss(id) }, [])
  const reply = (value: string | null) => {
    if (!prompt) return
    void api.replyReviewUI(prompt.id, value)
    setPrompts((items) => items.filter((item) => item.id !== prompt.id))
  }
  const activeDetail = detail?.sessionId === activeSessionId ? detail : null
  return (
    <>
      <Toaster theme={appearance} position="bottom-right" closeButton
        style={{
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--normal-bg-hover': 'var(--accent)',
          '--normal-border-hover': 'var(--border)'
        } as CSSProperties}
        toastOptions={{ classNames: { description: 'text-muted-foreground!', closeButton: 'hover:bg-accent! hover:border-border!' } }}
      />
      {prompt ? <ReviewPanel key={prompt.id} prompt={prompt} reply={reply} /> : null}
      <Dialog open={!!activeDetail} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>{t('systemUI.details')}</DialogTitle><DialogDescription>{activeDetail ? t(`systemUI.${activeDetail.plugin}`) : ''}</DialogDescription></DialogHeader>
          <div className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-sm">{activeDetail?.message}</div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { if (activeDetail) void navigator.clipboard.writeText(activeDetail.message) }}>{t('common.copyAll')}</Button>
            <Button onClick={() => setDetail(null)}>{t('common.continue')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
