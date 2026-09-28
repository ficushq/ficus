import type { Provider, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { claudeCodeOffered, claudeCodeUsable, getClaudeCodeStatus } from './availability'
import { CLAUDE_CODE_FLAG, CLAUDE_CODE_PROVIDER, claudeCodeAccount, isClaudeCodeCredential } from './account'
import { createClaudeCodeStream } from './bridge'

let bridgeStream: ReturnType<typeof createClaudeCodeStream> | undefined

/**
 * The Anthropic provider, able to serve its Claude Code account. A turn whose selected account is
 * Claude Code goes through the user's own `claude`; every other account uses the Anthropic API
 * exactly as before.
 */
export function anthropicWithClaudeCode(
  base: Provider = anthropicProvider(),
  // One bridge per process, so every runtime shares the live Claude Code sessions.
  bridge: ReturnType<typeof createClaudeCodeStream> = (bridgeStream ??= createClaudeCodeStream())
): Provider {
  const apiKey = base.auth.apiKey!
  const viaClaudeCode = (options: { env?: Record<string, string | undefined> } | undefined) =>
    options?.env?.[CLAUDE_CODE_FLAG] === '1'
  return {
    ...base,
    auth: {
      ...base.auth,
      apiKey: {
        ...apiKey,
        // Claude Code keeps its own sign-in, which Ficus never reads; the account only needs it ready.
        resolve: async (input) =>
          isClaudeCodeCredential(input.credential)
            ? (await claudeCodeUsable())
              ? { auth: {}, env: { [CLAUDE_CODE_FLAG]: '1' }, source: 'Claude Code' }
              : undefined
            : apiKey.resolve(input),
      },
    },
    stream: (model, context, options) =>
      viaClaudeCode(options)
        ? bridge(model, context, options as SimpleStreamOptions)
        : base.stream(model, context, options),
    streamSimple: (model, context, options) =>
      viaClaudeCode(options) ? bridge(model, context, options) : base.streamSimple(model, context, options),
  }
}

type ProviderRegistry = { registerNativeProvider(provider: Provider): void }

/** Where Core runs on the user's own machine, the Anthropic provider can serve a Claude Code account. */
export function registerAnthropicWithClaudeCode(runtime: ProviderRegistry) {
  if (!claudeCodeOffered()) return
  runtime.registerNativeProvider(anthropicWithClaudeCode())
  // Account selection reads the cached sign-in status synchronously; start it early.
  if (claudeCodeAccount()?.enabled) void getClaudeCodeStatus().catch(() => {})
}

export { CLAUDE_CODE_PROVIDER }
