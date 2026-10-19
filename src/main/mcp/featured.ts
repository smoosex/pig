/**
 * Connection recipes based on Magpie's featured list (excluding Magpie Image).
 *
 * The copy here is the English fallback; `descriptionKey` and each input's `labelKey`/`descriptionKey`
 * name the dictionary entry the renderer prefers, so a featured listing follows the app language
 * while a Registry listing shows the text its own author wrote.
 */
import type { McpConfig, McpMarketInput, McpMarketServer } from '../../shared/api'
import type { MessageKey, Messages } from '../../shared/i18n'
import { mcpConfigIdentity } from '../../shared/mcp-market'

/** A featured name is a dictionary section, so a recipe without copy fails the typecheck. */
type FeaturedName = keyof Messages['mcp']['featured']
/** Only the inputs that section declares, so a field without copy fails too. */
type FeaturedInputKey<N extends FeaturedName> = Messages['mcp']['featured'][N] extends {
  input: infer Keys
}
  ? keyof Keys & string
  : never

const descriptionKey = (name: FeaturedName): MessageKey => `mcp.featured.${name}.description`
const inputKey = <N extends FeaturedName>(
  server: N,
  key: FeaturedInputKey<N>,
  field: 'label' | 'description'
): MessageKey => `mcp.featured.${server}.input.${key}.${field}` as MessageKey

const remote = (
  name: FeaturedName,
  title: string,
  publisher: string,
  url: string,
  description: string,
  inputs: McpMarketInput[] = []
): McpMarketServer => ({
  id: name,
  name,
  title,
  publisher,
  description,
  descriptionKey: descriptionKey(name),
  icon: featuredIcons[name],
  homepage: featuredHomepages[name],
  featured: true,
  config: { url, description, enabled: false, exposure: 'deferred' },
  inputs
})
const local = (
  name: FeaturedName,
  title: string,
  publisher: string,
  command: string,
  args: string[],
  description: string,
  inputs: McpMarketInput[] = []
): McpMarketServer => ({
  id: name,
  name,
  title,
  publisher,
  description,
  descriptionKey: descriptionKey(name),
  icon: featuredIcons[name],
  homepage: featuredHomepages[name],
  featured: true,
  config: { command, args, description, enabled: false, exposure: 'deferred' },
  inputs
})
/** An input declared by an environment key: the label is the recipe's own, the sample is that key. */
const key = <N extends FeaturedName>(
  server: N,
  name: FeaturedInputKey<N>,
  where: string
): McpMarketInput => ({
  key: name,
  where: 'env',
  label: 'API key',
  description: where,
  placeholder: name,
  labelKey: inputKey(server, name, 'label'),
  descriptionKey: inputKey(server, name, 'description'),
  required: true,
  secret: true
})
const ownerAvatar = (owner: string): string => `https://github.com/${owner}.png?size=96`
/** Where each featured server is documented, so the source can be checked before it runs. */
const featuredHomepages: Record<FeaturedName, string> = {
  context7: 'https://context7.com',
  playwright: 'https://github.com/microsoft/playwright-mcp',
  'open-computer-use': 'https://github.com/iFurySt/open-computer-use',
  'chrome-devtools': 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  github: 'https://github.com/github/github-mcp-server',
  deepwiki: 'https://deepwiki.com',
  exa: 'https://docs.exa.ai/reference/exa-mcp',
  filesystem: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  fetch: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  memory: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  'sequential-thinking':
    'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  git: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  time: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
  sentry: 'https://docs.sentry.io/product/sentry-mcp/',
  linear: 'https://linear.app/docs/mcp',
  notion: 'https://developers.notion.com/docs/mcp',
  atlassian: 'https://www.atlassian.com/platform/remote-mcp-server',
  supabase: 'https://supabase.com/docs/guides/getting-started/mcp',
  stripe: 'https://docs.stripe.com/mcp',
  vercel: 'https://vercel.com/docs/mcp/vercel-mcp',
  neon: 'https://neon.com/docs/ai/neon-mcp-server',
  'cloudflare-docs': 'https://github.com/cloudflare/mcp-server-cloudflare',
  'microsoft-learn': 'https://github.com/MicrosoftDocs/mcp',
  huggingface: 'https://huggingface.co/settings/mcp',
  'brave-search': 'https://github.com/brave/brave-search-mcp-server',
  firecrawl: 'https://github.com/firecrawl/firecrawl-mcp-server',
  tavily: 'https://github.com/tavily-ai/tavily-mcp'
}
/** Icon sources carried over from Magpie's featured list; a listing without one falls back to initials. */
const featuredIcons: Record<FeaturedName, string> = {
  context7: ownerAvatar('upstash'),
  playwright: 'https://playwright.dev/img/playwright-logo.svg',
  'open-computer-use': ownerAvatar('iFurySt'),
  'chrome-devtools': ownerAvatar('ChromeDevTools'),
  github: ownerAvatar('github'),
  deepwiki: ownerAvatar('CognitionAI'),
  exa: ownerAvatar('exa-labs'),
  filesystem: ownerAvatar('modelcontextprotocol'),
  fetch: ownerAvatar('modelcontextprotocol'),
  memory: ownerAvatar('modelcontextprotocol'),
  'sequential-thinking': ownerAvatar('modelcontextprotocol'),
  git: ownerAvatar('modelcontextprotocol'),
  time: ownerAvatar('modelcontextprotocol'),
  sentry: ownerAvatar('getsentry'),
  linear: ownerAvatar('linear'),
  notion: ownerAvatar('makenotion'),
  atlassian: ownerAvatar('atlassian'),
  supabase: ownerAvatar('supabase'),
  stripe: ownerAvatar('stripe'),
  vercel: ownerAvatar('vercel'),
  neon: ownerAvatar('neondatabase'),
  'cloudflare-docs': ownerAvatar('cloudflare'),
  'microsoft-learn': ownerAvatar('microsoft'),
  huggingface: ownerAvatar('huggingface'),
  'brave-search': ownerAvatar('brave'),
  firecrawl: ownerAvatar('firecrawl'),
  tavily: ownerAvatar('tavily-ai')
}
export const openComputerUseMcp = local(
  'open-computer-use',
  'Open Computer Use',
  'iFurySt',
  'npx',
  ['-y', 'open-computer-use@1.1.2', 'mcp'],
  'Control desktop apps through accessibility and screenshots. macOS requires Accessibility and Screen Recording permissions; Windows and Linux support is experimental.'
)

export const featuredMcpServers: McpMarketServer[] = [
  openComputerUseMcp,
  remote(
    'context7',
    'Context7',
    'Upstash',
    'https://mcp.context7.com/mcp',
    'Current library documentation and code examples.',
    [
      {
        key: 'CONTEXT7_API_KEY',
        where: 'header',
        label: 'API key',
        description: 'context7.com/dashboard',
        placeholder: 'CONTEXT7_API_KEY',
        labelKey: inputKey('context7', 'CONTEXT7_API_KEY', 'label'),
        descriptionKey: inputKey('context7', 'CONTEXT7_API_KEY', 'description'),
        secret: true,
        format: '{}'
      }
    ]
  ),
  local(
    'playwright',
    'Playwright',
    'Microsoft',
    'npx',
    ['-y', '@playwright/mcp@latest'],
    'Browser automation through the accessibility tree.'
  ),
  local(
    'chrome-devtools',
    'Chrome DevTools',
    'Google',
    'npx',
    ['-y', 'chrome-devtools-mcp@latest'],
    'Inspect Chrome, network requests, console and performance.'
  ),
  remote(
    'github',
    'GitHub',
    'GitHub',
    'https://api.githubcopilot.com/mcp/',
    'Repositories, issues, pull requests and code search.',
    [
      {
        key: 'Authorization',
        where: 'header',
        label: 'Personal access token',
        description: 'github.com/settings/personal-access-tokens',
        placeholder: 'github_pat_…',
        labelKey: inputKey('github', 'Authorization', 'label'),
        descriptionKey: inputKey('github', 'Authorization', 'description'),
        format: 'Bearer {}',
        required: true,
        secret: true
      }
    ]
  ),
  remote(
    'deepwiki',
    'DeepWiki',
    'Cognition',
    'https://mcp.deepwiki.com/mcp',
    'Explore documentation for public GitHub repositories.'
  ),
  remote('exa', 'Exa', 'Exa', 'https://mcp.exa.ai/mcp', 'Web and code search for agents.'),
  local(
    'filesystem',
    'Filesystem',
    'Model Context Protocol',
    'npx',
    ['-y', '@modelcontextprotocol/server-filesystem@latest', '{dir}'],
    'Read and write files in explicitly allowed folders.',
    [
      {
        key: 'dir',
        where: 'arg',
        label: 'Folder',
        description: 'The folder it may read and write',
        placeholder: '~/code',
        labelKey: inputKey('filesystem', 'dir', 'label'),
        descriptionKey: inputKey('filesystem', 'dir', 'description'),
        required: true
      }
    ]
  ),
  local(
    'fetch',
    'Fetch',
    'Model Context Protocol',
    'uvx',
    ['mcp-server-fetch@latest'],
    'Read web pages as Markdown.'
  ),
  local(
    'memory',
    'Memory',
    'Model Context Protocol',
    'npx',
    ['-y', '@modelcontextprotocol/server-memory@latest'],
    'Persist a knowledge graph across conversations.'
  ),
  local(
    'sequential-thinking',
    'Sequential Thinking',
    'Model Context Protocol',
    'npx',
    ['-y', '@modelcontextprotocol/server-sequential-thinking@latest'],
    'Revise and explore a structured chain of reasoning.'
  ),
  local(
    'git',
    'Git',
    'Model Context Protocol',
    'uvx',
    ['mcp-server-git@latest'],
    'Inspect and modify Git repositories.'
  ),
  local(
    'time',
    'Time',
    'Model Context Protocol',
    'uvx',
    ['mcp-server-time@latest'],
    'Look up times and convert between time zones.'
  ),
  remote(
    'sentry',
    'Sentry',
    'Sentry',
    'https://mcp.sentry.dev/mcp',
    'Inspect application errors and traces.'
  ),
  remote(
    'linear',
    'Linear',
    'Linear',
    'https://mcp.linear.app/mcp',
    'Manage issues and projects in Linear.'
  ),
  remote(
    'notion',
    'Notion',
    'Notion',
    'https://mcp.notion.com/mcp',
    'Search and edit Notion workspace content.'
  ),
  remote(
    'atlassian',
    'Atlassian',
    'Atlassian',
    'https://mcp.atlassian.com/v1/mcp',
    'Work with Jira and Confluence.'
  ),
  remote(
    'supabase',
    'Supabase',
    'Supabase',
    'https://mcp.supabase.com/mcp',
    'Manage Supabase projects and databases.'
  ),
  remote(
    'stripe',
    'Stripe',
    'Stripe',
    'https://mcp.stripe.com',
    'Inspect Stripe accounts, payments and documentation.'
  ),
  remote(
    'vercel',
    'Vercel',
    'Vercel',
    'https://mcp.vercel.com',
    'Manage Vercel deployments and projects.'
  ),
  remote(
    'neon',
    'Neon',
    'Neon',
    'https://mcp.neon.tech/mcp',
    'Manage Neon Postgres projects and branches.'
  ),
  remote(
    'cloudflare-docs',
    'Cloudflare Docs',
    'Cloudflare',
    'https://docs.mcp.cloudflare.com/mcp',
    'Search Cloudflare product documentation.'
  ),
  remote(
    'microsoft-learn',
    'Microsoft Learn',
    'Microsoft',
    'https://learn.microsoft.com/api/mcp',
    'Search Microsoft and Azure documentation.'
  ),
  remote(
    'huggingface',
    'Hugging Face',
    'Hugging Face',
    'https://huggingface.co/mcp',
    'Find models, datasets and Spaces.'
  ),
  local(
    'brave-search',
    'Brave Search',
    'Brave',
    'npx',
    ['-y', '@brave/brave-search-mcp-server@latest'],
    'Search the web with Brave.',
    [key('brave-search', 'BRAVE_API_KEY', 'brave.com/search/api')]
  ),
  local(
    'firecrawl',
    'Firecrawl',
    'Firecrawl',
    'npx',
    ['-y', 'firecrawl-mcp@latest'],
    'Crawl and extract web content.',
    [key('firecrawl', 'FIRECRAWL_API_KEY', 'firecrawl.dev/app/api-keys')]
  ),
  local(
    'tavily',
    'Tavily',
    'Tavily',
    'npx',
    ['-y', 'tavily-mcp@latest'],
    'Search and extract web content with Tavily.',
    [key('tavily', 'TAVILY_API_KEY', 'app.tavily.com')]
  )
]

/**
 * The recipe a saved server came from, matched by address or command rather than by name, because a
 * user may rename a server after adding it. A description that no longer matches the recipe's own
 * text means the user edited it, and then their wording is shown instead of the dictionary entry.
 */
export function featuredRecipe(config: McpConfig): McpMarketServer | undefined {
  const identity = mcpConfigIdentity(config)
  return featuredMcpServers.find(
    (server) =>
      mcpConfigIdentity(server.config) === identity &&
      (!config.description || config.description === server.config.description)
  )
}
