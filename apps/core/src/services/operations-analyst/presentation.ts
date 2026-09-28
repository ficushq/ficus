import type { OperationsRemediation } from '@ficus/shared'
import { generatedEvidence, redactEvidence, type RedactedText } from './redaction'
import type { ExtractedSignal } from './types'

export function targetOf(remediation: OperationsRemediation): string {
  switch (remediation.type) {
    case 'add_sandbox_package':
      return remediation.package
    case 'update_sandbox_runtime':
      return remediation.runtime
    case 'review_sandbox_permission':
    case 'improve_agent_tooling':
      return remediation.tool
    case 'update_agent_guidance':
      return remediation.topic
  }
}

export function titleFor(remediation: OperationsRemediation): string {
  switch (remediation.type) {
    case 'add_sandbox_package':
      return `Add ${remediation.package} to the managed sandbox image`
    case 'update_sandbox_runtime':
      return `Update the ${remediation.runtime} sandbox runtime`
    case 'review_sandbox_permission':
      return `Review sandbox permissions used by ${remediation.tool}`
    case 'improve_agent_tooling':
      return `Improve reliability of ${remediation.tool}`
    case 'update_agent_guidance':
      return `Update agent guidance for ${remediation.topic}`
  }
}

export function recommendationSummaryFor(remediation: OperationsRemediation): RedactedText {
  const target = targetOf(remediation)
  switch (remediation.type) {
    case 'add_sandbox_package':
      return generatedEvidence(`${target} was unavailable or installed ad hoc in completed executions.`)
    case 'update_sandbox_runtime':
      return generatedEvidence(`${target} was unavailable as a sandbox runtime or module in completed executions.`)
    case 'review_sandbox_permission':
      return generatedEvidence(`${target} encountered sandbox permission failures in completed executions.`)
    case 'improve_agent_tooling':
      return generatedEvidence(`${target} failed repeatedly in completed executions.`)
    case 'update_agent_guidance':
      return generatedEvidence('Completed executions included inter-agent environment workaround discussions.')
  }
}

export function evidenceSummaryFor(signals: ExtractedSignal[]): RedactedText {
  return redactEvidence([...new Set(signals.map((signal) => String(signal.summary)))].join('; '), [])
}
