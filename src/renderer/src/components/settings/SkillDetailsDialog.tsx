import { useEffect, useState } from 'react'
import { Copy, FolderOpen, LoaderCircle } from 'lucide-react'
import { api, type SkillInfo } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

export function SkillDetailsDialog({ skill, onClose }: { skill: SkillInfo; onClose(): void }) {
  const t = useT()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void api.readSkill(skill.id).then((value) => { if (current) setText(value) }, (failure) => { if (current) setError(String(failure)) })
    return () => { current = false }
  }, [skill.id])
  const action = (run: () => Promise<unknown>) => {
    void run().catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">{skill.name}{skill.manualOnly ? <Badge variant="secondary">{t('skills.manualOnly')}</Badge> : null}</DialogTitle>
          <DialogDescription>{t('skills.detailDescription')}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{skill.description}</p>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="min-h-0 overflow-y-auto rounded-lg border bg-code-background p-4 text-code-foreground">
          {text === null ? <p role="status" className="flex items-center gap-2 text-xs"><LoaderCircle className="size-4 animate-spin" />{t('skills.loading')}</p> : <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text}</pre>}
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">{skill.filePath}</p>
        <DialogFooter className="flex-wrap">
          <Button size="sm" variant="ghost" onClick={() => action(() => navigator.clipboard.writeText(`/skill:${skill.name}`))}><Copy data-icon="inline-start" />{t('skills.copyCommand')}</Button>
          <Button size="sm" variant="outline" onClick={() => action(() => api.openSkillDirectory(skill.id))}><FolderOpen data-icon="inline-start" />{t('skills.openDirectory')}</Button>
          <Button size="sm" onClick={onClose}>{t('skills.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
