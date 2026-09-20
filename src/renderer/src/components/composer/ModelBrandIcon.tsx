import { Box } from 'lucide-react'
import {
  siAlibabacloud,
  siAnthropic,
  siCloudflare,
  siDeepseek,
  siGithubcopilot,
  siGooglecloud,
  siGooglegemini,
  siHuggingface,
  siKimi,
  siMinimax,
  siMistralai,
  siNvidia,
  siOllama,
  siOpenaigym,
  siOpencode,
  siOpenrouter,
  siQwen,
  siVercel,
  siX,
  type SimpleIcon
} from 'simple-icons'
import type { SessionModelInfo } from '../../ipc/api'

const providerIcons: Record<string, SimpleIcon> = {
  anthropic: siAnthropic,
  openai: siOpenaigym,
  google: siGooglegemini,
  'google-vertex': siGooglecloud,
  deepseek: siDeepseek,
  nvidia: siNvidia,
  mistral: siMistralai,
  'cloudflare-ai-gateway': siCloudflare,
  'cloudflare-workers-ai': siCloudflare,
  xai: siX,
  openrouter: siOpenrouter,
  'vercel-ai-gateway': siVercel,
  opencode: siOpencode,
  'opencode-go': siOpencode,
  huggingface: siHuggingface,
  kimi: siKimi,
  'kimi-coding': siKimi,
  minimax: siMinimax,
  'minimax-cn': siMinimax,
  'qwen-token-plan': siQwen,
  'alibaba-cloud': siAlibabacloud,
  'github-copilot': siGithubcopilot,
  ollama: siOllama
}

export function ModelBrandIcon({ model }: { model: SessionModelInfo | null }) {
  const icon = model ? providerIcons[model.provider.toLowerCase()] : undefined
  if (!icon) return <Box data-icon="inline-start" />
  return (
    <svg
      data-icon="inline-start"
      data-brand={icon.slug}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d={icon.path} />
    </svg>
  )
}
