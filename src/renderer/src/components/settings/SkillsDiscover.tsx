/** Discovery is mounted only on demand; a search response must never replace a newer query. */
import { useEffect, useState } from 'react'
import { BookOpen, Download, LoaderCircle, Search } from 'lucide-react'
import { api, type SkillInfo, type SkillMarketResult } from '../../ipc/api'
import type { MessageKey } from '../../../../shared/i18n'
import { useT } from '../../hooks/useT'
import { listingText } from '../../lib/i18n'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import type { AddSkillSource } from './AddSkillDialog'
import { McpIcon } from './McpIcon'

export function SkillsDiscover({ installed, onAdd }: { installed: SkillInfo[]; onAdd(source: AddSkillSource): void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [market, setMarket] = useState<SkillMarketResult>({ skills: [] })
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let current = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      void api.searchSkillMarket(query).then(
        (result) => { if (current) setMarket(result) },
        (error) => { if (current) setMarket({ skills: [], error: String(error) }) }
      ).finally(() => { if (current) setLoading(false) })
    }, query.trim() ? 350 : 0)
    return () => { current = false; window.clearTimeout(timer) }
  }, [query])
  return (
    <>
      <InputGroup>
        <InputGroupInput aria-label={t('skills.marketSearch')} placeholder={t('skills.marketSearch')} value={query} onChange={(event) => setQuery(event.target.value)} />
        <InputGroupAddon><Search /></InputGroupAddon>
        {loading ? <InputGroupAddon align="inline-end"><LoaderCircle className="animate-spin" /></InputGroupAddon> : null}
      </InputGroup>
      <p className="text-xs text-muted-foreground">{t('skills.marketHint')}</p>
      {market.error ? <Alert><AlertDescription><span>{t('skills.marketFailed')}</span><span>{market.error}</span></AlertDescription></Alert> : null}
      {!loading && !market.skills.length ? <Empty className="min-h-40 border"><EmptyHeader><EmptyTitle>{t('skills.marketEmpty')}</EmptyTitle><EmptyDescription>{t('skills.marketEmptyDescription')}</EmptyDescription></EmptyHeader></Empty> : null}
      {loading && !market.skills.length ? <p role="status" className="text-xs text-muted-foreground">{t('skills.loading')}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2" aria-busy={loading}>
        {market.skills.map((skill) => {
          const have = installed.some((item) => item.name === skill.name || item.name === skill.skillId)
          const featured = skill.featured
          const description = featured ? listingText(t, `skills.featuredDescriptions.${skill.skillId}` as MessageKey, skill.description) : skill.description
          return (
            <Card key={skill.id} className="min-w-0 gap-4">
              <CardHeader className="gap-3">
                <div className="flex items-center gap-3">
                  <McpIcon source={skill.icon} name={skill.name} fallback={<BookOpen className="size-4" />} className="size-8 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate text-sm leading-tight" title={skill.name}>{skill.name}</CardTitle>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground" title={skill.repo}>{skill.repo}</p>
                  </div>
                </div>
              </CardHeader>
              {description ? <CardContent><CardDescription className="line-clamp-3 text-xs leading-relaxed">{description}</CardDescription></CardContent> : null}
              <CardFooter className="mt-auto flex-wrap gap-2">
                <span className="flex-1 text-xs text-muted-foreground">{skill.installs !== null ? t('skills.installs', { n: skill.installs.toLocaleString() }) : skill.featured ? <Badge variant="secondary">{t('skills.featured')}</Badge> : null}</span>
                <Button size="xs" variant="outline" disabled={have} onClick={() => onAdd({ source: skill.repo, target: skill.skillId })}>
                  {!have ? <Download data-icon="inline-start" /> : null}{t(have ? 'skills.added' : 'skills.inspectInstall')}
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>
    </>
  )
}
