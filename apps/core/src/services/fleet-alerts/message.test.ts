import { describe, expect, test } from 'bun:test'
import { formatFleetDuration, renderFleetIncidentMessage } from './message'
import type { FleetIncidentNotificationClaim } from './store'

const NOW = new Date('2026-09-23T12:00:00Z')
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
const SQUAD_ID = '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b'

function claim(overrides: Partial<FleetIncidentNotificationClaim>): FleetIncidentNotificationClaim {
  return {
    notificationId: 'notification',
    incidentId: 'incident',
    audience: 'human',
    recipientId: null,
    idempotencyKey: null,
    phase: 'alert',
    claimToken: 'token',
    attempts: 0,
    incidentResolvedAt: null,
    incidentStartedAt: ago(45),
    incidentKind: 'squad_dead_fleet',
    squadId: SQUAD_ID,
    scopeKey: `squad:${SQUAD_ID}`,
    causeCode: 'demand-not-served',
    causeSummary:
      '1 pending work item remains; oldest is 4070m old. No execution run has started in the last 45m of pending demand, and no open provider or sandbox incident explains the delay.',
    remediation:
      'Check machine + sandbox health first (`ficus machines list`), then worker pickup (`ficus worker status`).',
    details: {},
    ...overrides,
  }
}

describe('fleet incident messages', () => {
  test('retains complete source when clipping a push presentation', () => {
    const squadName = `[**Ficus**](https://example.com/${'x'.repeat(350)})`
    const message = renderFleetIncidentMessage(claim({}), { squadName }, NOW)
    expect(message.push).toMatchObject({
      source: {
        title: message.subject,
        body: `Work in squad ${squadName} has been stalled for 45m.`,
        subtitle: squadName,
      },
    })
  })

  test('formats durations in the largest readable units', () => {
    expect(formatFleetDuration(20_000)).toBe('1m')
    expect(formatFleetDuration(45 * 60_000)).toBe('45m')
    expect(formatFleetDuration(190 * 60_000)).toBe('3h 10m')
    expect(formatFleetDuration(120 * 60_000)).toBe('2h')
    expect(formatFleetDuration(4258 * 60_000)).toBe('2d 22h')
  })

  test('a stalled squad is named, with readable waiting time instead of raw minutes', () => {
    const message = renderFleetIncidentMessage(
      claim({ details: { demandCount: 1, oldestDemandAt: ago(4070).toISOString() } }),
      { squadName: 'Ficus Core' },
      NOW
    )
    expect(message.subject).toBe('Squad Ficus Core stalled')
    expect(message.content).toBe(
      'Work in squad Ficus Core has been stalled for 45m.\n\n' +
        'Cause: No agent run has started, and no provider or sandbox problem explains it.\n' +
        'Waiting: 1 work item, the oldest for 2d 19h\n' +
        'Fix: Check machine + sandbox health first (`ficus machines list`), then worker pickup (`ficus worker status`).'
    )
    expect(message.content).not.toContain(SQUAD_ID)
    expect(message.content).not.toContain('4070m')
    expect(message.push).toEqual({
      title: 'Squad Ficus Core stalled',
      body: 'Work in squad Ficus Core has been stalled for 45m.',
      subtitle: 'Ficus Core',
      collapseKey: 'fleet:incident',
      threadKey: 'fleet',
      interruptionLevel: 'active',
    })
  })

  test('a squad stalled by a provider names the provider', () => {
    const message = renderFleetIncidentMessage(
      claim({
        causeCode: 'plan-credit',
        causeSummary: 'Provider plan credits are unavailable.',
        remediation: undefined,
        details: { demandCount: 2, provider: 'openai-codex', providerRouteBlocked: true },
      }),
      { squadName: 'Ficus Core' },
      NOW
    )
    expect(message.subject).toBe('Squad Ficus Core stalled: OpenAI Codex out of plan credits')
    expect(message.content).toContain('Cause: OpenAI Codex plan credits are unavailable.')
    expect(message.content).toContain('Waiting: 2 work items')
  })

  test('legacy global provider attribution without routing proof cannot blame a provider', () => {
    const message = renderFleetIncidentMessage(
      claim({
        causeCode: 'rate-limit',
        causeSummary: 'Provider rate limit is preventing requests.',
        remediation: 'Run login for anthropic',
        details: { provider: 'anthropic' },
      }),
      { squadName: 'Example' },
      NOW
    )
    expect(message.subject).toBe('Squad Example stalled')
    expect(message.content).not.toContain('Anthropic')
    expect(message.content).not.toContain('login')
    expect(message.content).toContain('current provider cause has not been established')
  })

  test('a recovery reports how long it lasted and the earlier cause, without remediation', () => {
    const message = renderFleetIncidentMessage(
      claim({ phase: 'recovery', incidentStartedAt: ago(190), incidentResolvedAt: ago(0) }),
      { squadName: 'Ficus Core' },
      NOW
    )
    expect(message.subject).toBe('Squad Ficus Core is running again')
    expect(message.content).toBe(
      'Work in squad Ficus Core is running again after being stalled for 3h 10m.\n\n' +
        'Earlier cause: No agent run has started, and no provider or sandbox problem explains it.'
    )
    expect(message.push.interruptionLevel).toBe('passive')
  })

  test('provider incidents use the provider label and a label-aware cause', () => {
    const base = {
      incidentKind: 'provider_unhealthy' as const,
      squadId: undefined,
      provider: 'openai-codex',
      scopeKey: 'provider:openai-codex:account:*',
      causeCode: 'expired-oauth',
      causeSummary: 'Provider OAuth credentials expired or were revoked.',
      remediation: 'Run `ficus pa login openai-codex` to authenticate again.',
    }
    const alert = renderFleetIncidentMessage(claim(base), {}, NOW)
    expect(alert.subject).toBe('OpenAI Codex: sign-in expired')
    expect(alert.content).toBe(
      'Agents that use OpenAI Codex can’t run until this clears.\n\n' +
        'Cause: OpenAI Codex sign-in expired or was revoked.\n' +
        'Started: 45m ago\n' +
        'Fix: Run `ficus pa login openai-codex` to authenticate again.'
    )
    expect(alert.push.subtitle).toBeUndefined()
    const recovery = renderFleetIncidentMessage(
      claim({ ...base, phase: 'recovery', incidentResolvedAt: ago(0), incidentStartedAt: ago(125) }),
      {},
      NOW
    )
    expect(recovery.subject).toBe('OpenAI Codex recovered')
    expect(recovery.content).toStartWith('OpenAI Codex is working again after 2h 5m.')
  })

  test('agent sandboxes name the agent and squad and phrase reason codes', () => {
    const agentId = '8feeb6aa-7f95-4686-a92f-56095edd2660'
    const message = renderFleetIncidentMessage(
      claim({
        incidentKind: 'sandbox_degraded',
        squadId: undefined,
        scopeKey: `sandbox:agent_${agentId}`,
        causeCode: 'sandbox-setup-degraded',
        causeSummary: 'VM sandbox best-effort setup remains degraded.',
        remediation: 'Inspect VM sandbox transport and setup reconciliation logs.',
        details: {
          sandboxId: `agent_${agentId}`,
          reasons: ['callback_transport_degraded', 'devbox_unavailable', 'future_reason'],
        },
      }),
      { agentName: 'reviewer', squadName: 'Ficus Core' },
      NOW
    )
    expect(message.subject).toBe('The sandbox for reviewer in squad Ficus Core is degraded')
    expect(message.content).toContain(
      'Cause: VM sandbox setup is degraded: callback connection degraded, devbox unavailable.'
    )
    expect(message.content).not.toContain(agentId)
    expect(message.content).not.toContain('_')
  })

  test('missing names and unknown details fall back without echoing raw details', () => {
    const message = renderFleetIncidentMessage(
      claim({ causeCode: 'unknown-code', causeSummary: 'Sanitized summary.', details: { secret: 'must-not-leak' } }),
      {},
      NOW
    )
    expect(message.subject).toBe('Squad 4ea8b934 stalled')
    expect(message.content).toContain('Cause: Sanitized summary.')
    expect(JSON.stringify(message)).not.toContain('must-not-leak')
    expect(JSON.stringify(message)).not.toContain(SQUAD_ID)
  })

  describe('overloaded sandboxes', () => {
    const AGENT_ID = '8feeb6aa-7f95-4686-a92f-56095edd2660'
    const squadRemediation = `Find and stop the runaway job with \`ficus squad sandbox-ps ${SQUAD_ID}\` (or Workspace settings → Processes), then \`ficus squad sandbox-kill\` / \`sandbox-stop-container\`.`
    const agentRemediation = `Find and stop the runaway job with \`ficus agent sandbox-ps ${AGENT_ID}\` (or the agent's sandbox controls → Processes), then \`ficus agent sandbox-kill\` / \`sandbox-stop-container\`.`
    const cause =
      'More work is running than the machine has CPUs for, often a detached build, test run, or container left behind. On a shared machine, another sandbox can cause it too.'
    const overload = (overrides: Partial<FleetIncidentNotificationClaim>) =>
      claim({
        incidentKind: 'sandbox_overloaded',
        incidentStartedAt: ago(12),
        scopeKey: `sandbox:squad_${SQUAD_ID}`,
        causeCode: 'sandbox-overloaded',
        causeSummary: cause,
        remediation: squadRemediation,
        details: {
          sandboxId: `squad_${SQUAD_ID}`,
          cpus: 4,
          load: [31.9, 28.7, 25.5],
          peakLoad: 40.2,
          memTotalMb: 16_000,
          memAvailableMb: 463,
        },
        ...overrides,
      })

    test('a squad sandbox alert gives the load, its duration, the effect, and how to find the job', () => {
      const message = renderFleetIncidentMessage(overload({}), { squadName: 'Ficus Core' }, NOW)
      expect(message.subject).toBe('The sandbox for squad Ficus Core is overloaded')
      expect(message.content).toBe(
        'The sandbox for squad Ficus Core is overloaded: load 31.9 on 4 CPUs for 12m (463 MB free). ' +
          'Agents’ tool calls and toolchain checks time out while it lasts.\n\n' +
          `Cause: ${cause}\n` +
          'Peak load: 40.2\n' +
          `Fix: ${squadRemediation}`
      )
      expect(message.push).toMatchObject({
        title: 'The sandbox for squad Ficus Core is overloaded',
        subtitle: 'Ficus Core',
        interruptionLevel: 'active',
      })
    })

    test('an agent sandbox alert names the agent and uses the agent commands', () => {
      const message = renderFleetIncidentMessage(
        overload({
          squadId: undefined,
          scopeKey: `sandbox:agent_${AGENT_ID}`,
          remediation: agentRemediation,
          details: {
            sandboxId: `agent_${AGENT_ID}`,
            cpus: 1,
            load: [2.5, 2, 1],
            peakLoad: 2.5,
            memTotalMb: 4_096,
            memAvailableMb: 2_560,
          },
        }),
        { agentName: 'reviewer' },
        NOW
      )
      expect(message.subject).toBe('The sandbox for reviewer is overloaded')
      expect(message.content).toBe(
        'The sandbox for reviewer is overloaded: load 2.5 on 1 CPU for 12m (2.5 GB free). ' +
          'Agents’ tool calls and toolchain checks time out while it lasts.\n\n' +
          `Cause: ${cause}\n` +
          `Fix: ${agentRemediation}`
      )
    })

    test('recovery reports how long it lasted and the load it settled at', () => {
      const message = renderFleetIncidentMessage(
        overload({
          phase: 'recovery',
          incidentStartedAt: ago(26),
          incidentResolvedAt: ago(0),
          details: { cpus: 4, load: [2.1, 6, 9], peakLoad: 40.2, memAvailableMb: 9_000, resolvedBy: 'load' },
        }),
        { squadName: 'Ficus Core' },
        NOW
      )
      expect(message.subject).toBe('The sandbox for squad Ficus Core recovered')
      expect(message.content).toBe(
        'The sandbox for squad Ficus Core is no longer overloaded after 26m: load 2.1 on 4 CPUs.\n\n' +
          `Earlier cause: ${cause}`
      )
      expect(message.push.interruptionLevel).toBe('passive')

      const agent = renderFleetIncidentMessage(
        overload({
          phase: 'recovery',
          scopeKey: `sandbox:agent_${AGENT_ID}`,
          incidentResolvedAt: ago(0),
          details: { cpus: 2, load: [1.5, 3, 3], resolvedBy: 'load' },
        }),
        { agentName: 'reviewer', squadName: 'Ficus Core' },
        NOW
      )
      expect(agent.subject).toBe('The sandbox for reviewer in squad Ficus Core recovered')
      expect(agent.content).toStartWith(
        'The sandbox for reviewer in squad Ficus Core is no longer overloaded after 12m: load 1.5 on 2 CPUs.'
      )
    })

    test('an episode closed for lack of readings says so instead of claiming recovery', () => {
      const message = renderFleetIncidentMessage(
        overload({
          phase: 'recovery',
          incidentStartedAt: ago(40),
          incidentResolvedAt: ago(0),
          details: { cpus: 4, load: [31.9, 28.7, 25.5], resolvedBy: 'unobserved' },
        }),
        { squadName: 'Ficus Core' },
        NOW
      )
      expect(message.subject).toBe('The sandbox for squad Ficus Core: overload alert closed')
      expect(message.content).toStartWith(
        'The sandbox for squad Ficus Core has had no load reading for 10m (no agent is running in it, or it isn’t answering), so its overload alert is closed after 40m.'
      )
    })

    test('missing or malformed readings fall back without inventing numbers', () => {
      const message = renderFleetIncidentMessage(
        overload({ details: { cpus: 'four', load: 'high', secret: 'must-not-leak' } }),
        {},
        NOW
      )
      expect(message.subject).toBe(`Sandbox ${SQUAD_ID.slice(0, 8)} is overloaded`)
      expect(message.content).toStartWith(`Sandbox ${SQUAD_ID.slice(0, 8)} has been overloaded for 12m.`)
      expect(JSON.stringify(message)).not.toContain('must-not-leak')
    })
  })
})
