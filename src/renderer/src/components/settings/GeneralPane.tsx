import type { SendShortcut, ThinkingLevel } from '../../ipc/api'
import { useSettingsStore } from '../../stores/settings'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { DefaultModelPicker } from './DefaultModelPicker'
import { SettingsCard, SettingsRow } from './SettingsFields'

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}

export function GeneralPane() {
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const defaultThinkingLevel = useSettingsStore((s) => s.defaultThinkingLevel)
  const thinkingLevels = useSettingsStore((s) => s.thinkingLevels)
  const models = useSettingsStore((s) => s.models)
  const setSendShortcut = useSettingsStore((s) => s.setSendShortcut)
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel)
  const setDefaultThinking = useSettingsStore((s) => s.setDefaultThinking)
  const newline = sendShortcut === 'enter' ? 'Shift+Enter' : 'Enter'

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          发送
        </p>
        <SettingsCard>
          <SettingsRow title="发送快捷键" description={`${newline} 换行`}>
            <Select
              value={sendShortcut}
              onValueChange={(value) => void setSendShortcut(value as SendShortcut)}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="enter">Enter</SelectItem>
                  <SelectItem value="shift-enter">Shift+Enter</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          模型
        </p>
        <SettingsCard>
          <SettingsRow title="默认模型" description="新建对话时使用的模型">
            <DefaultModelPicker
              model={defaultModel}
              models={models}
              onSelect={(item) => void setDefaultModel(item.provider, item.id)}
            />
          </SettingsRow>
          <SettingsRow title="默认思考强度" description="新建对话时使用的推理强度">
            {thinkingLevels.length === 0 ? (
              <span className="text-xs text-muted-foreground">当前模型不支持</span>
            ) : (
              <Select
                value={defaultThinkingLevel ?? thinkingLevels[0]}
                onValueChange={(value) => void setDefaultThinking(value as ThinkingLevel)}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectGroup>
                    {thinkingLevels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {thinkingLabels[level]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </SettingsRow>
        </SettingsCard>
      </div>
    </div>
  )
}
