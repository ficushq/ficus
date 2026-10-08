import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  AnthropicIcon,
  OpenAIIcon,
  GoogleIcon,
  GeminiIcon,
  GitHubCopilotIcon,
  OpenRouterIcon,
  OllamaIcon,
  MistralIcon,
  PerplexityIcon,
  CodeIcon,
  PlusIcon,
  ChevronDownIcon,
} from '../icons'

const logos = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  google: GoogleIcon,
  'google-antigravity': GeminiIcon,
  'github-copilot': GitHubCopilotIcon,
  openrouter: OpenRouterIcon,
  ollama: OllamaIcon,
  mistral: MistralIcon,
  perplexity: PerplexityIcon,
  custom: PlusIcon,
}

/** Brand mark for a provider id, falling back to a generic code glyph. */
export function ProviderLogo({ providerId, className }: { providerId: string; className?: string }) {
  const Logo = logos[providerId as keyof typeof logos] ?? CodeIcon
  return <Logo className={className} />
}

export function ProviderDirectoryCard({
  providerId,
  name,
  description,
  status,
  action = 'Settings',
  children,
}: {
  providerId: string
  name: string
  description: string
  status?: string
  action?: string
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <article
      className={clsx(
        'flex min-w-0 flex-col rounded-xl border border-panel-border bg-surface',
        expanded && 'md:col-span-2'
      )}
    >
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start gap-3">
          <div
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-panel-border bg-surface-secondary text-primary"
          >
            <ProviderLogo providerId={providerId} className="h-7 w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="font-semibold text-primary">{name}</h4>
            {status && (
              <span className={clsx('text-xs', status === 'Connected' ? 'text-accent-light' : 'text-muted')}>
                {status}
              </span>
            )}
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">{description}</p>
        <div className="mt-auto pt-4">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`provider-settings-${providerId}`}
            onClick={() => setExpanded(!expanded)}
            className="ficus-button ficus-button-link flex items-center gap-2 self-start text-sm text-primary"
          >
            {action}
            <ChevronDownIcon className={clsx('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      </div>
      {expanded && (
        <div id={`provider-settings-${providerId}`} className="min-w-0 border-t border-panel-border p-5">
          {children}
        </div>
      )}
    </article>
  )
}
