import type { OperationsRemediation, OperationsSignalType } from '@ficus/shared'
import type { RedactedText } from './redaction'
export interface TaintedToolCall {
  messageId: string
  toolName: string
  args: string
  result: string
  isError: boolean
  observedAt: Date
}
export interface TaintedInboxMessage {
  messageId: string
  content: string
  consumedAt: Date
}
export interface ExtractedSignal {
  type: OperationsSignalType
  remediation: OperationsRemediation
  normalizedTarget: string
  occurrenceCount: number
  failedToolCalls: number
  estimatedAvoidableRetries: number
  messageId: string | null
  summary: RedactedText
  observedAt: Date
}
