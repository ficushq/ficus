/**
 * One prompt, one answer through the user's own signed-in Claude Code, for small utility calls
 * outside any agent session (reply suggestions and other Lite-tier completions).
 *
 * Unlike the session bridge (`bridge.ts`), this starts a `claude` process for the single call and
 * ends it as soon as the answer, a failure, a timeout or the caller's abort arrives: no tools, no
 * user or project settings, one turn, and no session written to disk. Claude Code keeps its own
 * sign-in, which Ficus never reads.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { query as sdkQuery, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { getHomeDir } from '../../../lib/utils/home'
import { claudeChildEnv, claudeCodeExecutable } from './availability'
import { describeClaudeCodeFailure } from './failures'

/** Rough characters per output token, for the cap enforced on our side. */
const CHARS_PER_TOKEN = 4

export type OneShotQueryFn = (params: { prompt: string; options: Options }) => Query

export interface ClaudeCodeOneShotRequest {
  /** Claude model id, e.g. `claude-haiku-4-5`. */
  model: string
  system: string
  prompt: string
  /** Output cap: passed to Claude Code and enforced again on the answer. */
  maxTokens: number
  /** Ends the call and its process. */
  signal: AbortSignal
  /** Off unless set; the Lite tier runs without thinking. */
  thinking?: boolean
  /** Told the call's token usage when Claude Code reports it (for the inference cost ledger). */
  onUsage?: (usage: ClaudeCodeOneShotUsage) => void
}

export interface ClaudeCodeOneShotUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ClaudeCodeOneShotDeps {
  query?: OneShotQueryFn
  executable?: () => string | undefined
  workDir?: () => string
}

/**
 * Ask Claude Code once. Resolves the answer text (null when empty), and throws on a failure or an
 * abort. The query is closed on every exit, so no process outlives the call.
 */
export async function completeOnceWithClaudeCode(
  request: ClaudeCodeOneShotRequest,
  deps: ClaudeCodeOneShotDeps = {}
): Promise<string | null> {
  if (request.signal.aborted) throw new Error('Claude Code one-shot call aborted')
  const executable = (deps.executable ?? claudeCodeExecutable)()
  if (!executable) throw new Error('Claude Code is not installed')
  const runQuery = deps.query ?? (sdkQuery as unknown as OneShotQueryFn)
  const maxTokens = Math.max(1, Math.floor(request.maxTokens))

  const abortController = new AbortController()
  const options: Options = {
    model: request.model,
    systemPrompt: request.system,
    pathToClaudeCodeExecutable: executable,
    cwd: (deps.workDir ?? defaultWorkDir)(),
    env: claudeChildEnv(process.env, {
      CLAUDE_AGENT_SDK_CLIENT_APP: 'ficus',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
      ENABLE_CLAUDEAI_MCP_SERVERS: '0',
    }),
    // A plain completion: no built-in tools, nothing pre-approved, nothing to prompt for.
    tools: [],
    allowedTools: [],
    permissionMode: 'dontAsk',
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    thinking: request.thinking ? { type: 'adaptive' } : { type: 'disabled' },
    maxTurns: 1,
    persistSession: false,
    abortController,
  }

  const query = runQuery({ prompt: request.prompt, options })
  const close = () => {
    abortController.abort()
    try {
      query.close()
    } catch {
      // Already exited.
    }
  }
  let aborted = false
  const onAbort = () => {
    aborted = true
    close()
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const message of query) {
      if (aborted) break
      if (message.type === 'result') reportUsage(message, request.onUsage)
      const answer = settle(message, executable)
      if (answer === undefined) continue
      return capText(answer, maxTokens)
    }
    throw new Error(aborted ? 'Claude Code one-shot call aborted' : 'Claude Code exited without an answer')
  } catch (error) {
    if (aborted) throw new Error('Claude Code one-shot call aborted')
    throw error
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    close()
  }
}

function reportUsage(message: SDKMessage, onUsage: ClaudeCodeOneShotRequest['onUsage']): void {
  const raw = (message as { usage?: Record<string, unknown> }).usage
  if (!onUsage || !raw) return
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  try {
    onUsage({
      input: count(raw.input_tokens),
      output: count(raw.output_tokens),
      cacheRead: count(raw.cache_read_input_tokens),
      cacheWrite: count(raw.cache_creation_input_tokens),
    })
  } catch {
    // Accounting must never fail the call.
  }
}

/** The answer a message settles the call with, undefined to keep reading; throws on a failure. */
function settle(message: SDKMessage, executable: string): string | null | undefined {
  if (message.type === 'assistant' && !message.parent_tool_use_id && message.error) {
    // An API error (rate limit, billing, sign-in) arrives as a synthetic assistant message.
    const text = (message.message.content as any[])
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
      .trim()
    throw new Error(describeClaudeCodeFailure(text || `Claude Code error: ${message.error}`, message.error, executable))
  }
  if (message.type !== 'result') return undefined
  if (message.subtype === 'success' && !message.is_error) return message.result.trim() || null
  const detail =
    message.subtype === 'success'
      ? message.result
      : ((message as { errors?: string[] }).errors?.join('\n') ?? `Claude Code stopped: ${message.subtype}`)
  throw new Error(describeClaudeCodeFailure(detail || 'Claude Code ended without an answer', undefined, executable))
}

/** Claude Code may not honor the token cap exactly; never hand back more than it allows. */
function capText(text: string | null, maxTokens: number): string | null {
  if (text === null) return null
  const limit = maxTokens * CHARS_PER_TOKEN
  return text.length > limit ? text.slice(0, limit) : text
}

/** An empty working directory, so no project CLAUDE.md or settings reach the call. */
function defaultWorkDir() {
  const dir = join(getHomeDir(), 'claude-code', 'one-shot')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
