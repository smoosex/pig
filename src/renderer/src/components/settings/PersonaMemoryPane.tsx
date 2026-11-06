/** Built-in persona and memory settings. Tabs stay mounted to retain drafts. */
import { useEffect, useState } from 'react'
import { useT } from '../../hooks/useT'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { PersonaSettings } from './PersonaSettings'
import { MemorySettings } from './MemorySettings'

export function PersonaMemoryPane({ onDirtyChange, onBusyChange }: {
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const t = useT()
  const [tab, setTab] = useState('persona')
  const [actionsContainer, setActionsContainer] = useState<HTMLDivElement | null>(null)
  const [personaDirty, setPersonaDirty] = useState(false)
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [personaBusy, setPersonaBusy] = useState(false)
  const [memoryBusy, setMemoryBusy] = useState(false)

  useEffect(() => { onDirtyChange?.(personaDirty || memoryDirty) }, [personaDirty, memoryDirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(personaBusy || memoryBusy) }, [personaBusy, memoryBusy, onBusyChange])

  return <Tabs value={tab} onValueChange={setTab} className="gap-6">
    <div className="flex items-center justify-between gap-4">
      <TabsList>
        <TabsTrigger value="persona">{t('features.persona')}</TabsTrigger>
        <TabsTrigger value="memory">{t('features.memory')}</TabsTrigger>
      </TabsList>
      <div ref={setActionsContainer} hidden={tab !== 'persona'} className="flex items-center gap-2" />
    </div>
    <TabsContent value="persona" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
      <PersonaSettings actionsContainer={actionsContainer} onDirtyChange={setPersonaDirty} onBusyChange={setPersonaBusy} />
    </TabsContent>
    <TabsContent value="memory" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
      <MemorySettings onDirtyChange={setMemoryDirty} onBusyChange={setMemoryBusy} />
    </TabsContent>
  </Tabs>
}
