/** Project registration is a consumer of the shared path picker. */
import { useSessionsStore } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { PathPickerDialog } from './PathPickerDialog'

export function ProjectPickerDialog() {
  const t = useT()
  const open = useSessionsStore((s) => s.projectPickerOpen)
  const setOpen = useSessionsStore((s) => s.setProjectPickerOpen)
  const openProject = useSessionsStore((s) => s.openProject)
  return open ? <PathPickerDialog project
    title={t('projectPicker.title')}
    description={t('projectPicker.description')}
    confirmLabel={t('projectPicker.add')}
    busyLabel={t('projectPicker.adding')}
    onClose={() => setOpen(false)}
    onSelect={async (path) => { await openProject(path) }}
  /> : null
}
