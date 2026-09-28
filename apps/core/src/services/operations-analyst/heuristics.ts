import { createHash } from 'node:crypto'
import type { OperationsRemediation } from '@ficus/shared'
import { generatedEvidence } from './redaction'
import type { ExtractedSignal, TaintedInboxMessage, TaintedToolCall } from './types'

export const ALGORITHM_VERSION = 'ops-heuristics-v1'
const safe = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*|@[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*)$/
function isSafeTarget(value: string, secrets: readonly string[]) {
  return safe.test(value) && !secrets.some((secret) => secret.length >= 4 && value.includes(secret))
}
function command(args: string): string | null {
  try {
    const parsed = JSON.parse(args)
    return typeof parsed?.command === 'string' ? parsed.command : null
  } catch {
    return null
  }
}
function signal(
  type: ExtractedSignal['type'],
  remediation: OperationsRemediation,
  target: string,
  tool: TaintedToolCall,
  failed = tool.isError
): ExtractedSignal {
  return {
    type,
    remediation,
    normalizedTarget: target,
    occurrenceCount: 1,
    failedToolCalls: failed ? 1 : 0,
    estimatedAvoidableRetries: 0,
    messageId: tool.messageId,
    summary: generatedEvidence(
      type === 'ad_hoc_install'
        ? `${target} was installed ad hoc in a completed execution`
        : type === 'permission_failure'
          ? `${tool.toolName} encountered a sandbox permission failure`
          : type === 'repeated_tool_failure'
            ? `${tool.toolName} failed repeatedly in a completed execution`
            : `${tool.toolName} reported that ${target} was unavailable`
    ),
    observedAt: tool.observedAt,
  }
}
export function extractSignals(input: {
  tools: TaintedToolCall[]
  inbox: TaintedInboxMessage[]
  knownSecrets: readonly string[]
}): ExtractedSignal[] {
  const out: ExtractedSignal[] = []
  for (const tool of input.tools) {
    const text = tool.result
    const cmd = command(tool.args)
    const missing = text.match(
      /(?:bash:\s*)?([A-Za-z0-9._-]+): command not found|executable ([A-Za-z0-9._-]+) not found/i
    )
    const target = missing?.[1] || missing?.[2]
    if (tool.isError && target && isSafeTarget(target, input.knownSecrets))
      out.push(signal('missing_command', { type: 'add_sandbox_package', package: target }, target, tool))
    if (cmd) {
      const install = cmd.match(
        /^(?:devbox add|apt(?:-get)? install|apk add|brew install|pipx? install|bun add -g|npm install -g|cargo install)\s+(@?[A-Za-z0-9][A-Za-z0-9._/-]*)\s*$/
      )
      if (install && isSafeTarget(install[1], input.knownSecrets))
        out.push(
          signal('ad_hoc_install', { type: 'add_sandbox_package', package: install[1] }, install[1], tool, false)
        )
    }
    if (
      tool.isError &&
      /permission denied|operation not permitted|EACCES/i.test(text) &&
      isSafeTarget(tool.toolName, input.knownSecrets)
    )
      out.push(
        signal('permission_failure', { type: 'review_sandbox_permission', tool: tool.toolName }, tool.toolName, tool)
      )
    const runtime = text.match(/(?:ModuleNotFoundError:\s*)?No module named ['"]([A-Za-z0-9._-]+)['"]/i)
    if (tool.isError && runtime && isSafeTarget(runtime[1], input.knownSecrets))
      out.push(signal('runtime_unavailable', { type: 'update_sandbox_runtime', runtime: runtime[1] }, runtime[1], tool))
  }
  for (const message of input.inbox) {
    if (
      /missing|unavailable|failed|permission/i.test(message.content) &&
      /workaround|install|devbox add|apt install/i.test(message.content)
    ) {
      out.push({
        type: 'workaround_discussion',
        remediation: { type: 'update_agent_guidance', topic: 'environment-workarounds' },
        normalizedTarget: 'environment-workarounds',
        occurrenceCount: 1,
        failedToolCalls: 0,
        estimatedAvoidableRetries: 0,
        messageId: message.messageId,
        summary: generatedEvidence('A consumed inter-agent message discussed an environment workaround'),
        observedAt: message.consumedAt,
      })
    }
  }
  const counts = new Map<string, number>()
  for (const tool of input.tools.filter((t) => t.isError)) {
    const k = `${tool.toolName}:${tool.result.replace(/\d+/g, '#').slice(0, 80)}`
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  for (const [key, count] of counts)
    if (count >= 2) {
      const tool = input.tools.find((t) => `${t.toolName}:${t.result.replace(/\d+/g, '#').slice(0, 80)}` === key)!
      if (isSafeTarget(tool.toolName, input.knownSecrets)) {
        const x = signal(
          'repeated_tool_failure',
          { type: 'improve_agent_tooling', tool: tool.toolName },
          tool.toolName,
          tool
        )
        x.occurrenceCount = count
        x.failedToolCalls = count
        x.estimatedAvoidableRetries = count - 1
        out.push(x)
      }
    }
  return out
}
export function fingerprintFor(squadId: string, remediation: OperationsRemediation): string {
  const target =
    'package' in remediation
      ? remediation.package
      : 'runtime' in remediation
        ? remediation.runtime
        : 'tool' in remediation
          ? remediation.tool
          : remediation.topic
  return createHash('sha256').update(`ops-fingerprint-v1|${squadId}|${remediation.type}|${target}`).digest('hex')
}
