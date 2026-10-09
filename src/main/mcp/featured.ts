/** Connection recipes based on Magpie's featured list (excluding Magpie Image); descriptions are Pig's. */
import type { McpMarketInput, McpMarketServer } from '../../shared/api'

const remote = (
  name: string,
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
  featured: true,
  config: { url, description, enabled: false, exposure: 'deferred' },
  inputs
})
const local = (
  name: string,
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
  featured: true,
  config: { command, args, description, enabled: false, exposure: 'deferred' },
  inputs
})
const key = (name: string): McpMarketInput => ({
  key: name,
  where: 'env',
  label: name,
  required: true,
  secret: true
})
const ownerAvatar = (owner: string): string => `https://github.com/${owner}.png?size=96`
/** Icon sources carried over from Magpie's featured list; a listing without one falls back to initials. */
const featuredIcons: Record<string, string> = {
  context7: ownerAvatar('upstash'),
  playwright: 'https://playwright.dev/img/playwright-logo.svg',
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
export const featuredMcpServers: McpMarketServer[] = [
  remote(
    'context7',
    'Context7',
    'Upstash',
    'https://mcp.context7.com/mcp',
    'Current library documentation and code examples.',
    [{ key: 'CONTEXT7_API_KEY', where: 'header', label: 'API Key', secret: true }]
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
    [{ key: 'dir', where: 'arg', label: 'Folder', required: true }]
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
    [key('BRAVE_API_KEY')]
  ),
  local(
    'firecrawl',
    'Firecrawl',
    'Firecrawl',
    'npx',
    ['-y', 'firecrawl-mcp@latest'],
    'Crawl and extract web content.',
    [key('FIRECRAWL_API_KEY')]
  ),
  local(
    'tavily',
    'Tavily',
    'Tavily',
    'npx',
    ['-y', 'tavily-mcp@latest'],
    'Search and extract web content with Tavily.',
    [key('TAVILY_API_KEY')]
  )
].map((server) => ({ ...server, icon: featuredIcons[server.name] }))
