export const MODEL_OVERRIDE_PROMPT_PROVIDERS = [
  {
    provider: 'openai-codex',
    models: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  },
  {
    provider: 'anthropic',
    models: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
] as const

export function buildModelOverridePrompt(): string {
  const providerSections = MODEL_OVERRIDE_PROMPT_PROVIDERS.map(({ provider, models }) => {
    return `- ${provider}: ${models.join(', ')}`
  })

  return `Agents can use per-agent model overrides. Use the full model spec format \`provider:model-id[:thinking-level]\`; thinking levels are suffixes on the same string (for example \`:low\`, \`:medium\`, \`:high\`).

Example model specs from the configured SDK catalog for openai-codex and anthropic:
${providerSections.join('\n')}

A model spec may be a comma-separated priority list of candidates, e.g. \`zai:glm-5.3:high,openai-codex:gpt-6.2-sol:low,anthropic:claude-sonnet-5-5\`. When a new agent session starts, the first candidate whose provider is enabled and authenticated is used; disabled or unauthenticated providers are skipped (credentials are preserved when a provider is disabled). List candidates in priority order.

Flow participants do not take a model spec: a participant's optional \`tier\` selects a model tier, and that tier's configured models apply. Use a model spec where a command takes \`--model\`: \`ficus squad spawn <agentType> <squadId> --model <spec>\` for one agent, or \`ficus agent-type create\` / \`ficus agent-type update <id> --model <spec>\` for an agent type's default.

An existing agent takes one override at most: \`ficus agent model <id> <spec>\` sets a model override, and \`ficus agent model <id> --tier <slug>\` makes it follow a model tier, picking up later edits to that tier. Setting one clears the other; \`--clear\` removes both. Overrides apply from the agent's next turn; add \`--now\` to switch a running agent immediately.`
}
