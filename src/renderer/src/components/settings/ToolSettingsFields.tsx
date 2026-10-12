import { useEffect } from 'react'
import { useT } from '../../hooks/useT'
import { useToolSettingsStore } from '../../stores/tool-settings'
import { api } from '../../ipc/api'
import { Alert, AlertDescription } from '../ui/alert'
import { Switch } from '../ui/switch'
import { SettingsCard, SettingsRow } from './SettingsFields'

export function ToolSettingsFeedback() {
  const error = useToolSettingsStore((s) => s.error)
  if (!error) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}
export function CodemodeSetting() {
  const t = useT()
  const codemode = useToolSettingsStore((s) => s.state.codemode)
  const busy = useToolSettingsStore((s) => s.busy)
  const loaded = useToolSettingsStore((s) => s.loaded)
  const load = useToolSettingsStore((s) => s.load)
  const run = useToolSettingsStore((s) => s.run)
  useEffect(() => {
    void load()
  }, [load])
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t('mcp.tools')}
      </p>
      <SettingsCard>
        <SettingsRow title="Codemode" description={t('mcp.codemodeDescription')}>
          <Switch
            aria-label="Codemode"
            checked={codemode}
            disabled={busy || !loaded}
            onCheckedChange={(value) => void run(() => api.setCodemode(value))}
          />
        </SettingsRow>
      </SettingsCard>
      <ToolSettingsFeedback />
    </div>
  )
}
