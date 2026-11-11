/**
 * A permission request of this session, shown in place of its prompt box instead of a dialog. A
 * click or a number key answers at once; arrows/Space only move the choice and Enter confirms the
 * highlighted (focused) one, so keyboard navigation cannot approve by accident. Esc picks the last
 * option, which always denies.
 * Keys are ignored briefly after the card takes focus: it replaces the prompt box, so a digit or
 * Enter the user was still typing into a draft must not become an answer.
 */
import { failureMessage } from '../../lib/ipc-error'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Questionnaire } from '@shadcn/react/questionnaire'
import { ArrowDown, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '../../hooks/useT'
import { replyExtensionPrompt, useExtensionPrompts, type ExtensionPrompt } from '../../stores/extension-prompts'
import { Kbd } from '../ui/kbd'
import { Field } from '../ui/field'
import { Textarea } from '../ui/textarea'
import { MAX_APPROVAL_REASON_LENGTH } from '../../../../shared/tool-settings'

const ARM_MS = 600

export function useApprovalPrompt(sessionId: string | null): ExtensionPrompt | undefined {
  return useExtensionPrompts((state) =>
    sessionId ? state.prompts.find((item) => item.approval && (item.owner === sessionId || item.approvalController === sessionId)) : undefined
  )
}

export function ApprovalPrompt({ sessionId, autoFocus = true }: { sessionId: string | null; autoFocus?: boolean }) {
  const prompt = useApprovalPrompt(sessionId)
  return prompt ? <ApprovalCard key={prompt.id} prompt={prompt} autoFocus={autoFocus} /> : null
}

function ApprovalCard({ prompt, autoFocus }: { prompt: ExtensionPrompt; autoFocus: boolean }) {
  const t = useT()
  const form = useRef<HTMLFormElement>(null)
  const details = useRef<HTMLDivElement>(null)
  const detailsContent = useRef<HTMLParagraphElement>(null)
  const scrollHintId = useId()
  const [detailsOverflow, setDetailsOverflow] = useState(false)
  const answered = useRef(false)
  const reasonInput = useRef<HTMLTextAreaElement>(null)
  const reasonVisited = useRef(false)
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  // One highlight: the pointer's choice while the mouse moves, otherwise the keyboard's. CSS :hover
  // would stay on a still pointer after the arrows move the selection away.
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const highlighted = hovered ?? focused
  const options = prompt.options ?? []
  const denyOption = options.at(-1)
  const reasonOption = t('permissions.denyWithReason')
  const choices = useMemo(() => denyOption === undefined ? options : [...options, reasonOption], [options, denyOption, reasonOption])
  // Declared up front so the item is active (not inert) on the first render and can take focus.
  const items = useMemo(() => [{ name: 'approval', required: true, choices: choices.map((value) => ({ value })) }], [choices])
  const answer = (value: string, reason?: string) => {
    if (answered.current) return
    answered.current = true
    void replyExtensionPrompt(prompt.id, value, reason).catch((error) => toast.error(failureMessage(error)))
  }

  const choose = (value: string) => {
    if (value === reasonOption) {
      reasonVisited.current = true
      setReasonOpen(true)
      reasonInput.current?.focus({ preventScroll: true })
    } else answer(value)
  }

  useLayoutEffect(() => {
    const viewport = details.current
    const content = detailsContent.current
    if (!viewport || !content) return
    const measure = () => setDetailsOverflow(viewport.scrollHeight > viewport.clientHeight)
    measure()
    // The viewport may stay at its height limit while wrapping changes the content height.
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [prompt.message])

  const armedAt = useRef(performance.now() + ARM_MS)
  useEffect(() => {
    // The card replaces the prompt box, so it owns the keyboard of the visible pane; a background
    // split pane takes it once the user makes that pane active.
    if (!autoFocus) return
    armedAt.current = performance.now() + ARM_MS
    if (reasonOpen) reasonInput.current?.focus({ preventScroll: true })
    else {
      const radios = form.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]')
      const target = reasonVisited.current ? radios?.[options.length - 1] : radios?.[0]
      target?.focus({ preventScroll: true })
    }
  }, [autoFocus, reasonOpen])

  const onKeyDownCapture = (event: KeyboardEvent<HTMLFormElement>) => {
    if (reasonOpen && (event.target === reasonInput.current || event.key === 'Escape')) {
      // Text and IME belong to the reason, not Questionnaire's choice shortcuts.
      event.stopPropagation()
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        if (!event.repeat && denyOption !== undefined) answer(denyOption, reason.trim() || undefined)
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!event.repeat) setReasonOpen(false)
      }
      return
    }
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
    // App shortcuts above still work.
    setHovered(null)
    if (performance.now() < armedAt.current) {
      // Swallow, including Questionnaire's own Space/arrow selection and Enter submission.
      event.preventDefault()
      event.stopPropagation()
      return
    }
    // Focus alone highlights a choice without checking it, and Questionnaire's Enter ignores an
    // unchecked choice, so Enter answers with the focused choice itself.
    const focusedIndex = event.key === 'Enter' && event.target instanceof HTMLInputElement ? choices.indexOf(event.target.value) : -1
    const index = event.key === 'Escape' ? options.length - 1 : /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : focusedIndex
    const option = choices[index]
    if (option === undefined) return
    // Prevented before Questionnaire's own shortcut, which would only select the choice.
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) choose(option)
  }
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (reasonOpen) {
      if (denyOption !== undefined) answer(denyOption, reason.trim() || undefined)
      return
    }
    const value = new FormData(event.currentTarget).get('approval')
    if (typeof value === 'string' && choices.includes(value)) choose(value)
  }

  return (
    <Questionnaire.Root
      ref={form}
      shortcuts="numbers"
      items={items}
      defaultItem="approval"
      onSubmit={onSubmit}
      onKeyDownCapture={onKeyDownCapture}
      data-approval-prompt
      className="rounded-2xl border-[0.5px] border-glass-border bg-glass-composer-background/60 bg-(image:--glass-popover-sheen) p-3 text-glass-prompt-foreground shadow-glass-card solid:border-border solid:bg-composer-background solid:bg-none solid:text-foreground solid:shadow-md"
    >
      <Questionnaire.Item name="approval" required className="m-0 min-w-0 border-0 p-0">
        <Questionnaire.Title className="flex items-center gap-1.5 px-1 text-sm font-medium">
          <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
          {prompt.title}
        </Questionnaire.Title>
        {prompt.approvalController ? (
          <p className="mt-1 px-1 text-xs text-muted-foreground" data-approval-session>
            {t('permissions.approvalControlledSession', { id: prompt.owner })}
          </p>
        ) : null}
        {prompt.approvalSource?.kind === 'subagent' ? (
          <p className="mt-1 px-1 text-xs text-muted-foreground" data-approval-source>
            {t('permissions.approvalSubagent', { title: prompt.approvalSource.title, id: prompt.approvalSource.id })}
            {' '}{t('permissions.subagentGrantHint')}
          </p>
        ) : null}
        {prompt.message ? (
          <>
            <div
              ref={details}
              role="region"
              aria-label={t('permissions.approvalDetails')}
              aria-describedby={detailsOverflow ? scrollHintId : undefined}
              tabIndex={detailsOverflow ? 0 : undefined}
              className="mt-1 max-h-40 overflow-y-auto px-1 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground focus-visible:rounded-sm focus-visible:outline-1 focus-visible:outline-focus-ring"
            >
              <Questionnaire.Description ref={detailsContent}>{prompt.message}</Questionnaire.Description>
            </div>
            {detailsOverflow ? (
              <p id={scrollHintId} className="mt-1 flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground">
                <ArrowDown className="size-3 shrink-0" aria-hidden="true" />
                {t('permissions.approvalScrollHint')}
              </p>
            ) : null}
          </>
        ) : null}
        <Questionnaire.Choices className="mt-2 flex flex-col gap-0.5" onPointerLeave={() => setHovered(null)}>
          {choices.map((option) => (
            <Questionnaire.Choice
              key={option}
              value={option}
              // A mouse click has a detail; the synthetic click of Space or arrow keys does not.
              onClick={(event) => { if (event.detail > 0) choose(option) }}
              onPointerMove={() => setHovered(option)}
              data-highlighted={highlighted === option ? '' : undefined}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors data-highlighted:bg-glass-prompt-foreground/8 solid:data-highlighted:bg-accent solid:data-highlighted:text-accent-foreground"
            >
              <Questionnaire.ChoiceInput
                className="sr-only"
                onFocus={() => setFocused(option)}
                onBlur={() => setFocused((current) => (current === option ? null : current))}
              />
              <Questionnaire.ChoiceShortcut
                render={<Kbd className="bg-glass-prompt-foreground/8 text-glass-prompt-foreground solid:bg-muted solid:text-muted-foreground" />}
              />
              <Questionnaire.ChoiceLabel className="truncate">{option}</Questionnaire.ChoiceLabel>
            </Questionnaire.Choice>
          ))}
        </Questionnaire.Choices>
        {reasonOpen ? (
          <Field orientation="horizontal" className="mt-1 items-start pl-10">
            <Textarea
              ref={reasonInput}
              rows={1}
              className="max-h-12 min-h-6 resize-none overflow-y-auto rounded-none border-0 border-b bg-transparent! px-0 py-0 leading-5 shadow-none focus-visible:border-input focus-visible:ring-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              aria-label={t('permissions.denialReason')}
              value={reason}
              onFocus={() => setFocused(reasonOption)}
              onBlur={() => setFocused(current => current === reasonOption ? null : current)}
              onChange={event => setReason(event.target.value)}
              placeholder={t('permissions.denialReasonPlaceholder')}
              maxLength={MAX_APPROVAL_REASON_LENGTH}
            />
          </Field>
        ) : null}
      </Questionnaire.Item>
      <p className="mt-1.5 px-1 text-right text-xs text-muted-foreground">
        {t(reasonOpen ? 'permissions.denialReasonHint' : 'permissions.approvalHint')}
      </p>
    </Questionnaire.Root>
  )
}
