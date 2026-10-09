import { api } from '../../ipc/api'
import { projectMcpOverride } from '../../../../shared/tool-settings'
import { useT } from '../../hooks/useT'
import { useToolSettingsStore } from '../../stores/tool-settings'
import { SettingsCard, SettingsRow } from './SettingsFields'
import { ToolOverrideControl, ToolSettingsFeedback } from './ToolSettingsFields'

export function ProjectSettingsPane({ cwd }: { cwd: string }) {
  const t = useT()
  const state = useToolSettingsStore((s) => s.state)
  const busy = useToolSettingsStore((s) => s.busy)
  const loaded = useToolSettingsStore((s) => s.loaded)
  const run = useToolSettingsStore((s) => s.run)
  const project = state.projects[cwd]
  return (
    <div className="flex flex-col gap-5">
      <ToolSettingsFeedback />
      <p className="break-all font-mono text-xs text-muted-foreground">{cwd}</p>
      <SettingsCard>
        <SettingsRow
          title="Codemode"
          description={t('mcp.globalDefault', { state: t(state.codemode ? 'mcp.on' : 'mcp.off') })}
        >
          <ToolOverrideControl
            label="Codemode"
            value={project?.codemode}
            inherited={state.codemode}
            disabled={busy || !loaded}
            onChange={(codemode) => void run(() => api.setProjectToolSettings(cwd, { codemode }))}
          />
        </SettingsRow>
      </SettingsCard>
      <p className="text-sm font-medium">{t('mcp.projectMcp')}</p>
      {!state.servers.length ? (
        <p className="text-sm text-muted-foreground">{t('mcp.emptyDescription')}</p>
      ) : null}
      <SettingsCard>
        {state.servers.map((server) => (
          <SettingsRow
            key={server.name}
            title={server.name}
            description={t('mcp.globalDefault', {
              state: t(server.config.enabled === true ? 'mcp.on' : 'mcp.off')
            })}
          >
            <ToolOverrideControl
              label={server.name}
              value={projectMcpOverride(project, server.name)}
              inherited={server.config.enabled === true}
              disabled={busy || !loaded}
              onChange={(value) =>
                void run(() => api.setProjectToolSettings(cwd, { mcp: { [server.name]: value } }))
              }
            />
          </SettingsRow>
        ))}
      </SettingsCard>
    </div>
  )
}
