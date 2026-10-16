import { useT } from '../../hooks/useT'
import { useSessionsStore } from '../../stores/sessions'
import { useSubagentStore } from '../../stores/subagents'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'

export function SubagentCloseConfirm() {
  const t = useT()
  const closing = useSubagentStore((state) => state.closing)
  const cancel = useSubagentStore((state) => state.cancelClose)
  const closeTab = useSessionsStore((state) => state.closeTab)
  return (
    <AlertDialog open={!!closing} onOpenChange={(open) => { if (!open) cancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('subagents.closeTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('subagents.closeDescription', { n: closing?.running ?? 0 })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => {
            if (closing) closeTab(closing.tabId, { confirmed: true })
            cancel()
          }}>{t('subagents.closeConfirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
