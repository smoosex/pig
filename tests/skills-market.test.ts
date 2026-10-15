import { expect, test } from 'bun:test'
import { featuredSkills, searchSkillMarket } from '../src/main/skills/market'

test('featured skills work offline without invented installation counts', async () => {
  let requests = 0
  const result = await searchSkillMarket('', async () => { requests++; throw new Error('offline') })
  expect(result.skills.length).toBeGreaterThan(0)
  expect(result.skills.every((skill) => skill.installs === null)).toBe(true)
  expect(result.skills[0].icon).toBe(`https://github.com/${result.skills[0].repo.split('/')[0]}.png?size=96`)
  expect(requests).toBe(0)
})

test('skills.sh search validates repository identities and caches successful results', async () => {
  let requests = 0
  const fetcher = async (url: URL, init: RequestInit) => {
    requests++
    expect(url.origin).toBe('https://www.skills.sh')
    expect(url.searchParams.get('q')).toBe('unique-search-test')
    expect(init.redirect).toBe('error')
    return Response.json({ skills: [
      { source: 'owner/repo', skillId: 'some-skill', name: 'Some Skill', installs: 123 },
      { source: 'owner/repo', skillId: 'some-skill', installs: 123 },
      { source: 'https://evil.example/repo', skillId: 'bad' },
      { source: 'owner/repo', skillId: '../escape' },
      { source: 'other/repo', skillId: 'unknown-count' }
    ] })
  }
  const result = await searchSkillMarket(' Unique-Search-Test ', fetcher)
  expect(result.skills.map((skill) => skill.id)).toEqual(['owner/repo/some-skill', 'other/repo/unknown-count'])
  expect(result.skills[0].installs).toBe(123)
  expect(result.skills[1].installs).toBeNull()
  expect(result.skills.map((skill) => skill.icon)).toEqual(['https://github.com/owner.png?size=96', 'https://github.com/other.png?size=96'])
  expect(await searchSkillMarket('unique-search-test', fetcher)).toEqual(result)
  expect(requests).toBe(1)
})

test('failed search keeps matching offline entries and reports the actual failure', async () => {
  const result = await searchSkillMarket('pdf', async () => new Response('unavailable', { status: 503 }))
  expect(result.error).toContain('503')
  expect(result.skills).toEqual(featuredSkills.filter((skill) => `${skill.name} ${skill.description} ${skill.repo}`.toLowerCase().includes('pdf')))
})
