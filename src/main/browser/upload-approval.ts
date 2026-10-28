/** Browser upload approvals show local metadata only to the user; page text and paths are untrusted. */
import { t } from '../i18n'
import { approve } from '../permissions/approval'
import { fileVerdict } from '../sandbox/policy'
import { policyEnvironment, realTarget } from '../sandbox/service'
import type { BrowserUploadContext } from '../plugins/pig-browser-host'
import type { BrowserUploadFile } from './agent-upload'

/** JSON quoting prevents filenames and page titles from forging new lines; escape bidi controls too. */
function display(value: string): string {
  return JSON.stringify(value).replace(/[\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export async function approveBrowserUpload(
  sessionId: string, context: BrowserUploadContext, page: { url: string; title: string }, ref: string,
  files: readonly BrowserUploadFile[], signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  if (!context.ui) throw new Error('This session cannot ask the user, so the operation was refused')
  const url = new URL(page.url)
  const pageAddress = `${url.origin}${url.pathname}`
  if (pageAddress.length > 16_384) throw new Error('The page address is too long to display for upload approval')
  const env = policyEnvironment()
  const workspace = { cwd: realTarget(context.cwd), gitCommonDir: null }
  const sensitive = t('permissions.browserUploadSensitive')
  const entries = files.map(file => ({ file, sensitive: fileVerdict('default', 'read', file.resolved, workspace, env) === 'ask' }))
  const listed = entries.map(({ file, sensitive: isSensitive }) => {
    const warning = isSensitive ? '⚠ ' : ''
    const requested = file.requested === file.resolved ? '' : ` ← ${display(file.requested)}`
    return `- ${warning}${display(file.resolved)} (${file.size} B)${requested}`
  }).join('\n')
  const filesDetail = `${entries.some(entry => entry.sensitive) ? `⚠ ${sensitive}\n` : ''}${listed}`
  const title = t('permissions.browserUploadTitle')
  const message = t('permissions.browserUploadMessage',
    { page: display(pageAddress), title: display(page.title.slice(0, 256)), ref: display(ref), files: filesDetail })
  await approve(context.ui, sessionId, [], title, message, signal)
}
