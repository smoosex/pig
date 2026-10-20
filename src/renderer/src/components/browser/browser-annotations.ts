/** Browser marks become unsent prompt text in a real session's composer; the user decides when to send. */
import type { BrowserAnnotation, BrowserPickerOptions } from '../../../../shared/browser'
import { api } from '../../ipc/api'
import { useComposerDraftsStore } from '../../stores/composer-drafts'
import { useSessionsStore } from '../../stores/sessions'
import { t } from '../../lib/i18n'
import { appendBrowserAnnotationsDraft } from './browser-draft'

export async function addBrowserAnnotationsToDraft(browserId: string, target: string, annotations: BrowserAnnotation[]): Promise<void> {
  if (!annotations.length) return
  if (!useSessionsStore.getState().openTabs.some((tab) => tab.id === target && (tab.kind === 'project' || tab.kind === 'chat'))) {
    throw new Error('Session is closed')
  }
  const drafts = useComposerDraftsStore.getState()
  drafts.restoreDraft(target, appendBrowserAnnotationsDraft(drafts.drafts[target], annotations, t('browser.annotationAttachment')))
  // Only the batch now held by the draft leaves the preview; marks added meanwhile stay.
  await api.browser.removeAnnotations(browserId, annotations.map((mark) => mark.id))
  await useSessionsStore.getState().activateTab(target)
}

/** Resolve semantic variables on a real element so guests never inherit unresolved var() tokens. */
export function browserPickerOptions(labels: BrowserPickerOptions['labels']): BrowserPickerOptions {
  const solid = document.documentElement.dataset.surfaceStyle === 'solid'
  const probe = document.createElement('div')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  document.body.append(probe)
  const color = (token: string) => {
    probe.style.color = `var(--${token})`
    return getComputedStyle(probe).color
  }
  const theme: BrowserPickerOptions['theme'] = {
    background: color(solid ? 'popover' : 'glass-popover-background'),
    foreground: color(solid ? 'popover-foreground' : 'glass-prompt-foreground'),
    border: color(solid ? 'border' : 'glass-card-border'),
    muted: color('muted-foreground'), primary: color('primary'), primaryForeground: color('primary-foreground'),
    input: color(solid ? 'background' : 'glass-popover-background'), ring: color('ring'), shadow: '',
    destructive: color('destructive')
  }
  probe.style.boxShadow = solid ? 'var(--shadow-md)' : 'var(--glass-popover-shadow)'
  theme.shadow = getComputedStyle(probe).boxShadow
  probe.remove()
  return { labels, theme }
}
