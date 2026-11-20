export const MODEL_OVERRIDE_PROMPT_PROVIDERS = [
  {
    provider: 'openai-codex',
    models: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  },
  {
    provider: 'anthropic',
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
] as const

export function buildModelOverridePrompt(): string {
  const providerSections = MODEL_OVERRIDE_PROMPT_PROVIDERS.map(({ provider, models }) => {
    return `- ${provider}: ${models.join(', ')}`
  })

  return `Agents can use per-agent model overrides. Use the full model spec format \`provider:model-id[:thinking-level]\`; thinking levels are suffixes on the same string (for example \`:low\`, \`:medium\`, \`:high\`).

Example model specs from the configured SDK catalog for openai-codex and anthropic:
${providerSections.join('\n')}

A model spec may be a comma-separated priority list of candidates, e.g. \`zai:glm-5.2:high,openai-codex:gpt-5.6-sol:low,anthropic:claude-sonnet-4-6\`. When a new agent session starts, the first candidate whose provider is enabled and authenticated is used; disabled or unauthenticated providers are skipped (credentials are preserved when a provider is disabled). List candidates in priority order.

Flow participants do not take a model spec: a participant's optional \`tier\` selects a model tier, and that tier's configured models apply. Use a model spec where a command takes \`--model\`: \`ficus squad spawn <agentType> <squadId> --model <spec>\` for one agent, or \`ficus agent-type create\` / \`ficus agent-type update <id> --model <spec>\` for an agent type's default.`
}
