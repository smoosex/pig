/** Project registration and directory relocation share the in-app path picker. */
import { useSessionsStore } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { PathPickerDialog } from './PathPickerDialog'

function parentDirectoryOf(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (slash < 0) return undefined
  return slash === 0 ? '/' : trimmed.slice(0, slash)
}

export function ProjectPickerDialog() {
  const t = useT()
  const open = useSessionsStore((s) => s.projectPickerOpen)
  const setOpen = useSessionsStore((s) => s.setProjectPickerOpen)
  const openProject = useSessionsStore((s) => s.openProject)
  const relocateTarget = useSessionsStore((s) => s.relocateProjectTarget)
  const closeRelocate = useSessionsStore((s) => s.closeRelocateProjectDialog)
  const relocateProject = useSessionsStore((s) => s.relocateProject)

  if (relocateTarget) {
    return (
      <PathPickerDialog
        key={`relocate:${relocateTarget.cwd}`}
        project
        initialPath={parentDirectoryOf(relocateTarget.cwd)}
        title={t('project.relocateTitle', { name: relocateTarget.name })}
        description={t('project.relocateDescription')}
        confirmLabel={t('project.relocateConfirm')}
        busyLabel={t('project.relocating')}
        onClose={closeRelocate}
        onSelect={async (path) => {
          await relocateProject(relocateTarget.cwd, path)
        }}
      />
    )
  }

  return open ? <PathPickerDialog project
    title={t('projectPicker.title')}
    description={t('projectPicker.description')}
    confirmLabel={t('projectPicker.add')}
    busyLabel={t('projectPicker.adding')}
    onClose={() => setOpen(false)}
    onSelect={async (path) => { await openProject(path) }}
  /> : null
}
