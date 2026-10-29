/**
 * A permission request of this session, shown in place of its prompt box instead of a dialog. A
 * click or a number key answers at once; arrows/Space only move the choice and Enter confirms it, so
 * keyboard navigation cannot approve by accident. Esc picks the last option, which always denies.
 * Keys are ignored briefly after the card takes focus: it replaces the prompt box, so a digit or
 * Enter the user was still typing into a draft must not become an answer.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Questionnaire } from '@shadcn/react/questionnaire'
import { ArrowDown, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '../../hooks/useT'
import { replyExtensionPrompt, useExtensionPrompts, type ExtensionPrompt } from '../../stores/extension-prompts'
import { Kbd } from '../ui/kbd'

const ARM_MS = 600

export function useApprovalPrompt(sessionId: string | null): ExtensionPrompt | undefined {
  return useExtensionPrompts((state) =>
    sessionId ? state.prompts.find((item) => item.approval && item.owner === sessionId) : undefined
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
  // One highlight: the pointer's choice while the mouse moves, otherwise the keyboard's. CSS :hover
  // would stay on a still pointer after the arrows move the selection away.
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const highlighted = hovered ?? focused
  const options = prompt.options ?? []
  // Declared up front so the item is active (not inert) on the first render and can take focus.
  const items = useMemo(() => [{ name: 'approval', required: true, choices: options.map((value) => ({ value })) }], [options])
  const answer = (value: string) => {
    if (answered.current) return
    answered.current = true
    void replyExtensionPrompt(prompt.id, value).catch((error) => toast.error(String(error)))
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
    form.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }, [autoFocus])

  const onKeyDownCapture = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
    // App shortcuts above still work.
    setHovered(null)
    if (performance.now() < armedAt.current) {
      // Swallow, including Questionnaire's own Space/arrow selection and Enter submission.
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const index = event.key === 'Escape' ? options.length - 1 : /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1
    const option = options[index]
    if (option === undefined) return
    // Prevented before Questionnaire's own shortcut, which would only select the choice.
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) answer(option)
  }
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = new FormData(event.currentTarget).get('approval')
    if (typeof value === 'string' && options.includes(value)) answer(value)
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
          {options.map((option) => (
            <Questionnaire.Choice
              key={option}
              value={option}
              // A mouse click has a detail; the synthetic click of Space or arrow keys does not.
              onClick={(event) => { if (event.detail > 0) answer(option) }}
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
      </Questionnaire.Item>
      <p className="mt-1.5 px-1 text-right text-xs text-muted-foreground">{t('permissions.approvalHint')}</p>
    </Questionnaire.Root>
  )
}
