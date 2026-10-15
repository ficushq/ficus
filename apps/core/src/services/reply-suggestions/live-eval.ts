/**
 * Optional live prompt check for reply suggestions. Not a test file: CI never runs it.
 *
 *   ANTHROPIC_API_KEY=… bun apps/core/src/services/reply-suggestions/live-eval.ts [provider:model[:level] …]
 *
 * Sends each fixture that passes the pre-check through the shipped prompt and parser, using API
 * keys from the environment (no database or stored accounts), and prints the chips next to what
 * the fixture expects. Defaults to the Lite tier's chain from config/model-tiers/lite.yaml.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { completeSimple, getEnvApiKey, getModel } from '@earendil-works/pi-ai/compat'
import { MONOREPO_ROOT } from '../../lib/paths'
import { completeLight } from '../model-tiers/light-completion'
import { REPLY_SUGGESTION_FIXTURES } from './fixtures'
import { parseReplySuggestions } from './parse'
import { likelyAsksHuman } from './precheck'
import { buildReplySuggestionPrompt, REPLY_SUGGESTION_MAX_TOKENS, REPLY_SUGGESTION_SYSTEM } from './prompt'

/** `provider:model[:level]`; the full parser lives in a module that needs the database. */
function parseModelSpec(spec: string) {
  const [provider = '', modelId = '', thinkingLevel] = spec.trim().split(':')
  return { provider, modelId, thinkingLevel }
}

function liteChain(): string {
  const tier = yaml.load(readFileSync(join(MONOREPO_ROOT, 'config/model-tiers/lite.yaml'), 'utf8')) as { chain: string }
  return tier.chain
}

async function main() {
  const specs = process.argv.slice(2).length ? process.argv.slice(2) : liteChain().split(',')
  const usable = specs.filter((spec) => getEnvApiKey(parseModelSpec(spec).provider))
  if (usable.length === 0) {
    console.error(`No API key in the environment for any of: ${specs.join(', ')}`)
    process.exit(1)
  }
  let misses = 0
  for (const fixture of REPLY_SUGGESTION_FIXTURES) {
    if (!likelyAsksHuman(fixture.agent)) {
      console.log(`- ${fixture.name}: skipped by the pre-check`)
      continue
    }
    const answer = await completeLight(
      {
        tier: 'lite',
        system: REPLY_SUGGESTION_SYSTEM,
        prompt: buildReplySuggestionPrompt({ agentText: fixture.agent, humanText: fixture.human }),
        maxTokens: REPLY_SUGGESTION_MAX_TOKENS,
      },
      {
        tierChain: async () => usable.join(','),
        usableCandidates: (chain) => chain.split(','),
        complete: async (spec, call) => {
          const { provider, modelId, thinkingLevel } = parseModelSpec(spec)
          const message = await completeSimple(
            getModel(provider as never, modelId as never),
            { systemPrompt: call.system, messages: [{ role: 'user', content: call.prompt, timestamp: Date.now() }] },
            {
              apiKey: getEnvApiKey(provider),
              maxTokens: call.maxTokens,
              reasoning:
                thinkingLevel && thinkingLevel !== 'off'
                  ? (thinkingLevel as 'minimal' | 'low' | 'medium' | 'high')
                  : undefined,
              signal: call.signal,
            }
          )
          if (message.stopReason === 'error') throw new Error(message.errorMessage)
          return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
        },
        onCandidateError: (spec, error) => console.error(`  ${spec} failed: ${String(error)}`),
      }
    )
    const chips = answer ? parseReplySuggestions(answer.text) : []
    const chipsOk = fixture.chips === undefined || fixture.chips === chips.length > 0
    const patternOk = !fixture.expectChip || chips.length === 0 || chips.some((chip) => fixture.expectChip!.test(chip))
    if (!chipsOk || !patternOk) misses++
    console.log(
      `${chipsOk && patternOk ? '✓' : '✗'} ${fixture.name} (${answer?.model ?? 'no answer'}): ${JSON.stringify(chips)}`
    )
  }
  console.log(misses ? `${misses} fixture(s) differ from expectations` : 'All fixtures as expected')
}

void main()
