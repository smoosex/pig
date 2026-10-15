/** An offline starter catalog plus skills.sh search; install counts are shown only when supplied upstream. */
import type { SkillMarketEntry, SkillMarketResult } from '../../shared/skills'
import { githubAvatar, skillResponseText, validRepo, type SkillFetcher } from './source'

export const featuredSkills: SkillMarketEntry[] = [
  { repo: 'anthropics/skills', skillId: 'frontend-design', description: 'Build distinctive, production-ready web interfaces.' },
  { repo: 'vercel-labs/agent-skills', skillId: 'vercel-react-best-practices', description: 'React and Next.js performance guidelines from Vercel.' },
  { repo: 'vercel-labs/agent-browser', skillId: 'agent-browser', description: 'Browse websites, fill forms and automate browser workflows.' },
  { repo: 'anthropics/skills', skillId: 'pdf', description: 'Read, extract, create and manipulate PDF documents.' },
  { repo: 'anthropics/skills', skillId: 'docx', description: 'Create, edit and inspect Word documents.' },
  { repo: 'vercel-labs/skills', skillId: 'find-skills', description: 'Find and install skills for new workflows.' }
].map((skill) => ({ ...skill, id: `${skill.repo}/${skill.skillId}`, name: skill.skillId, installs: null, featured: true, icon: githubAvatar(skill.repo) }))

const cache = new Map<string, { expires: number; skills: SkillMarketEntry[] }>()
export async function searchSkillMarket(query: string, fetcher: SkillFetcher = fetch): Promise<SkillMarketResult> {
  const q = query.trim().slice(0, 120).toLowerCase()
  if (!q) return { skills: featuredSkills }
  const fallback = featuredSkills.filter((skill) => `${skill.name} ${skill.description} ${skill.repo}`.toLowerCase().includes(q))
  const cached = cache.get(q)
  if (cached && cached.expires > Date.now()) return { skills: cached.skills }
  try {
    const url = new URL('https://www.skills.sh/api/search')
    url.search = new URLSearchParams({ q, limit: '30' }).toString()
    const body = JSON.parse(await skillResponseText(url, 2 * 1024 * 1024, fetcher)) as { skills?: unknown[] }
    if (!Array.isArray(body.skills)) throw new Error('skills.sh returned an invalid skill list')
    const skills: SkillMarketEntry[] = []
    for (const raw of body.skills) {
      if (!raw || typeof raw !== 'object') continue
      const value = raw as Record<string, unknown>
      if (typeof value.source !== 'string' || !validRepo(value.source) || typeof value.skillId !== 'string' || !/^[\w.-]+$/.test(value.skillId)) continue
      const id = `${value.source}/${value.skillId}`
      if (skills.some((skill) => skill.id === id)) continue
      skills.push({
        id, featured: false, icon: githubAvatar(value.source), repo: value.source, skillId: value.skillId, name: typeof value.name === 'string' ? value.name : value.skillId,
        description: typeof value.description === 'string' ? value.description : '',
        installs: typeof value.installs === 'number' && Number.isFinite(value.installs) && value.installs >= 0 ? value.installs : null
      })
      if (skills.length === 30) break
    }
    if (cache.size >= 64) cache.delete(cache.keys().next().value!)
    cache.set(q, { expires: Date.now() + 300_000, skills })
    return { skills }
  } catch (error) { return { skills: fallback, error: error instanceof Error ? error.message : String(error) } }
}
