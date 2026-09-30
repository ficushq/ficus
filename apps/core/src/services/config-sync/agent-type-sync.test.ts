import { describe, test, expect, beforeEach } from 'bun:test'
import { db, agentTypes } from '../../db'
import { eq } from 'drizzle-orm'
import { AgentTypeSync, composeFromYaml } from './agent-type-sync'
import { loadSharedPromptFiles } from './shared-prompt-sync'

const sync = new AgentTypeSync()

/** The prompt an agent actually receives: the type's own text plus its includes. */
async function loadComposed() {
  const [parsed, files] = await Promise.all([sync.loadFromDir(), loadSharedPromptFiles()])
  return parsed.map((t) => ({ ...t, systemPrompt: composeFromYaml(t, files) }))
}

describe('AgentTypeSync', () => {
  beforeEach(async () => {
    await db.delete(agentTypes)
  })

  test('system-only classification parses, validates, and round-trips through records', () => {
    const source = 'id: custom-system-role\nname: Internal role\ntier: standard\nsystemPrompt: Test'
    expect(sync.parse(source, 'test.yaml').systemOnly).toBe(false)
    const parsed = sync.parse(`${source}\nsystemOnly: true`, 'test.yaml')
    expect(parsed.systemOnly).toBe(true)
    expect(sync.toRecord(parsed).systemOnly).toBe(true)
    expect(() => sync.parse(`${source}\nsystemOnly: "true"`, 'test.yaml')).toThrow('systemOnly')
  })
  test('loads all agent types from config/agent-types/', async () => {
    const parsed = await sync.loadFromDir()
    expect(parsed.length).toBeGreaterThanOrEqual(5) // at least engineer, architect, general, manager, reviewer
    for (const item of parsed) {
      expect(item.id).toBeTruthy()
      expect(item.name).toBeTruthy()
      expect(item.model || item.tier).toBeTruthy()
      expect(item.systemPrompt).toBeTruthy()
    }
  })

  test('syncs all agent types to DB', async () => {
    const result = await sync.sync()
    expect(result.synced).toBeGreaterThanOrEqual(5)
    expect(result.deleted).toBe(0)

    const rows = await db.select().from(agentTypes)
    expect(rows.length).toBe(result.synced)
    for (const row of rows) {
      expect(row.yamlTemplate).toBeTruthy()
      expect(row.yamlFieldOverrides).toEqual([])
    }
  })

  test('engineer type has expected fields', async () => {
    await sync.sync()
    const rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'engineer'))
    expect(rows).toHaveLength(1)
    const eng = rows[0]
    expect(eng.name).toBeTruthy()
    expect(eng.model).toBe('')
    expect(eng.tier).toBe('standard')
    expect(eng.systemPrompt.length).toBeGreaterThan(10)
  })

  test('security auditor type uses the exhaustive tier and audit guidance', async () => {
    const parsed = await sync.loadFromDir()
    const securityAuditor = parsed.find((p) => p.id === 'security-auditor')

    expect(securityAuditor).toBeTruthy()
    expect(securityAuditor!.name).toBe('Security Auditor')
    expect(securityAuditor!.model).toBe('')
    expect(securityAuditor!.tier).toBe('exhaustive')
    expect(securityAuditor!.tools?.allow ?? []).toEqual(
      expect.arrayContaining(['read', 'bash', 'websearch', 'webfetch', 'context_*'])
    )
    expect(securityAuditor!.tools?.allow ?? []).not.toContain('write')
    expect(securityAuditor!.tools?.allow ?? []).not.toContain('edit')
    expect(securityAuditor!.systemPrompt).toContain('Threat Modeling')
    expect(securityAuditor!.systemPrompt).toContain('Authentication and Authorization')
    expect(securityAuditor!.systemPrompt).toContain('Findings')
  })

  test('artifact builder config routes voice replies through inbox and does not allow removed respond_to_voice tool', async () => {
    const parsed = await sync.loadFromDir()
    const artifactBuilder = parsed.find((p) => p.id === 'artifact-builder-default')

    expect(artifactBuilder).toBeTruthy()
    expect(artifactBuilder!.tools?.allow ?? []).not.toContain('respond_to_voice')
    expect(artifactBuilder!.systemPrompt).not.toContain('respond_to_voice')
    expect(artifactBuilder!.systemPrompt).toContain(
      'ficus inbox send workspace "<message>" --recipient-type voice_assistant'
    )
  })

  test('manager and consultant include roadmap-phase-loop and shared planning skills', async () => {
    const parsed = await sync.loadFromDir()
    const manager = parsed.find((p) => p.id === 'manager')
    const consultant = parsed.find((p) => p.id === 'consultant')

    expect(manager).toBeTruthy()
    expect(consultant).toBeTruthy()

    const planningSkills = [
      'brainstorming',
      'writing-plans',
      'using-git-worktrees',
      'work-stream-driven-development',
      'test-driven-development',
      'roadmap-phase-loop',
    ]

    expect(manager!.skills ?? []).toEqual(expect.arrayContaining(['roadmap-phase-loop']))
    expect(consultant!.skills ?? []).toEqual(expect.arrayContaining(planningSkills))

    // Consultant keeps its existing setup/onboarding skills.
    expect(consultant!.skills ?? []).toEqual(expect.arrayContaining(['setup-squad', 'setup-notifications']))
  })

  test('engineering squad prompts include public communication guidance', async () => {
    const parsed = await loadComposed()
    for (const id of ['engineer', 'reviewer', 'manager']) {
      const agentType = parsed.find((p) => p.id === id)
      expect(agentType).toBeTruthy()
      expect(agentType!.systemPrompt).toContain('## Public communication')
      expect(agentType!.systemPrompt).toContain('Never include internal sandbox paths like `{{workspaceRoot}}/...`')
      expect(agentType!.systemPrompt).toContain('Do **not** mention sandbox details')
      expect(agentType!.systemPrompt).toContain('Avoid internal-handoff')
    }
  })

  test('manager, reviewer, and shared prompts document scope adjustment coordination', async () => {
    const parsed = await loadComposed()
    const manager = parsed.find((p) => p.id === 'manager')
    const reviewer = parsed.find((p) => p.id === 'reviewer')

    expect(manager).toBeTruthy()
    expect(reviewer).toBeTruthy()

    const managerPrompt = manager!.systemPrompt
    const normalizedManagerPrompt = managerPrompt.replace(/\s+/g, ' ')
    expect(managerPrompt).toContain('## Scope Adjustments')
    expect(managerPrompt).toContain('ALWAYS update the work stream description FIRST')
    expect(normalizedManagerPrompt).toContain('notify the necessary agent(s) via steering inbox message')
    expect(normalizedManagerPrompt).toContain(
      'steer every affected active agent with the new version and truthful outcomes'
    )
    expect(managerPrompt).toContain('authorized flow revision')
    expect(normalizedManagerPrompt).toContain('Use active=keep for live outcome additions, changes, or removals')
    expect(normalizedManagerPrompt).toContain('without resetting their initial brief, participant, or session')
    expect(normalizedManagerPrompt).toContain(
      'Inspect outcomeUpdates in the revision response (activeOutcomes in flow inspection)'
    )
    expect(normalizedManagerPrompt).toContain(
      'Revised instructions/outputs apply to future attempts, not the preserved brief'
    )
    expect(normalizedManagerPrompt).toContain(
      'Use active=restart only when cancellation and a new attempt with fresh context are intended, even for reuse-within-stream participants'
    )
    expect(normalizedManagerPrompt).toContain(
      'do not instantiate future participants or fabricate an approval to fit an old outcome'
    )

    const reviewerPrompt = reviewer!.systemPrompt
    expect(reviewerPrompt).toContain('## Scope Checking')
    expect(reviewerPrompt).toContain('do NOT automatically revert it as scope creep')
    expect(reviewerPrompt).toContain('ficus workstream get <id>')
    expect(reviewerPrompt).toContain('flag it to the manager as a question')

    for (const id of ['manager', 'architect', 'engineer', 'reviewer']) {
      const agentType = parsed.find((p) => p.id === id)
      expect(agentType).toBeTruthy()
      expect(agentType!.systemPrompt).toContain('## Scope Adjustments')
      expect(agentType!.systemPrompt).toContain('The work stream description is the shared source of truth for scope')
      expect(agentType!.systemPrompt).toContain('steering messages are not visible to every role')
    }
  })

  test('manager prompt asks humans through ask_human and reserves inbox messages for information', async () => {
    const manager = (await loadComposed()).find((item) => item.id === 'manager')!

    expect(manager.systemPrompt).toContain('### Asking Humans')
    expect(manager.systemPrompt).toContain('you never block on a human')
    expect(manager.systemPrompt).toContain('Never ask a decision through an inbox message')
    expect(manager.systemPrompt).toContain('check `requestingUserId`')
    expect(manager.systemPrompt).toContain('--recipient-type user')
    expect(manager.systemPrompt).toContain('ficus inbox send system')
    expect(manager.systemPrompt).not.toContain('Decisions that need human input')
    expect(manager.systemPrompt).not.toContain('Blockers that require human intervention')
  })

  test('squad rules send workers to a blocking ask_human for human decisions, not manual waits', async () => {
    const parsed = await loadComposed()
    for (const id of ['engineer', 'sysops', 'reviewer']) {
      const prompt = parsed.find((item) => item.id === id)?.systemPrompt ?? ''
      expect(prompt).toContain('`ask_human` tool and `blocking: true`')
      expect(prompt).toContain('Never substitute a manual wait or an\ninbox message for a question')
    }
  })

  test('manager prompt creates worktrees and passes branch/worktree flags', async () => {
    const parsed = await loadComposed()
    const manager = parsed.find((p) => p.id === 'manager')
    expect(manager).toBeTruthy()
    const p = manager!.systemPrompt

    // Inline `ficus workstream create` examples include branch/worktree flags.
    expect(p).toContain('--branch <branch>')
    // Namespaced shared-workspace root (interpolated to /workspace/<squadId> at runtime).
    expect(p).toContain('--worktree {{workspaceRoot}}/worktrees/<branch>')
    expect(p).toContain('--base-branch <base>')

    // Manager is responsible for creating the worktree before assigning agents.
    expect(p).toContain('git worktree add')
    expect(p).toContain('before')
    // References the worktree mechanics skills.
    expect(p).toContain('using-git-worktrees')
    expect(p).toContain('work-stream-driven-development')
  })

  test('architect and engineer prompts verify worktree on startup and can create it when metadata exists', async () => {
    const parsed = await loadComposed()
    for (const id of ['architect', 'engineer']) {
      const agentType = parsed.find((p) => p.id === id)
      expect(agentType).toBeTruthy()
      const p = agentType!.systemPrompt
      // Startup verification of worktree metadata.
      expect(p).toContain('ficus workstream get')
      expect(p).toContain('git.worktree')
      expect(p).toContain('git.branch')
      // If metadata exists but the worktree wasn't set up, create it.
      expect(p).toContain('git worktree add')
      // Only request input / escalate when metadata is entirely missing.
      expect(p).toContain('entirely')
      expect(p).toContain('missing')
      expect(p).toContain('request-input')
      expect(p).toContain('request-input')
      expect(p).toContain('on `main`')
    }
  })

  test('all worker types keep expertise and shared flow guidance in the composed prompt', async () => {
    const parsed = await loadComposed()
    const expectations: Record<string, string[]> = {
      architect: ['### Creating Plans', '### Task Structure', '## Design Judgment', 'Testing strategy'],
      engineer: ['### Implementation', '### Self-Review Checklist', '### Revision Feedback', '### Report Format'],
      reviewer: [
        '### Pass 1: Spec Compliance',
        '### Pass 2: Code Quality',
        '## Issue Categorization',
        '## Re-Review on Iteration',
      ],
      general: ['Verify claims', 'non-code work'],
      'security-auditor': ['Threat Modeling', 'Authentication and Authorization', 'Findings'],
      sysops: ['### Incident Response', '### High-Risk Operations Checklist', 'Rollback instructions'],
    }
    for (const [id, expertise] of Object.entries(expectations)) {
      const type = parsed.find((row) => row.id === id)!
      expect(type).not.toHaveProperty('flowPrompt')
      for (const text of expertise) expect(type.systemPrompt).toContain(text)
      expect(type.systemPrompt).toContain('ficus workstream advance')
      expect(type.systemPrompt).toContain('Outside a flow, complete the assigned task')
      expect(type.systemPrompt).toContain('no role may grant itself that authority')
      expect(type.systemPrompt).toContain('Sibling branches can continue')
      expect(type.systemPrompt).not.toMatch(/--to <(?:engineer|reviewer)-id>/)
      expect(type.systemPrompt).not.toContain('reviewer handles that')
    }
  })

  test('manager delivery policy preserves human authority without role-specific completion', async () => {
    const prompt = (await sync.loadFromDir()).find((row) => row.id === 'manager')!.systemPrompt
    for (const text of [
      'pr-merge',
      'pr-auto-merge',
      'review-approval',
      'direct-merge',
      'allowAutoMerge',
      'allowDirectMerge',
      'ficus workflow',
      'human',
      'Never grant yourself',
      '--admin',
    ])
      expect(prompt).toContain(text)
    expect(prompt).not.toContain('The reviewer creates a PR')
  })

  test('squad rules teach verifying worktree dir exists (not CWD) and allow intentional no-worktree', async () => {
    const parsed = await loadComposed()
    // Shared squad-rules include is composed into manager/architect/engineer/reviewer.
    for (const id of ['manager', 'architect', 'engineer', 'reviewer']) {
      const agentType = parsed.find((p) => p.id === id)
      expect(agentType).toBeTruthy()
      const p = agentType!.systemPrompt
      // Verify the worktree directory exists + is on the correct branch, then cd into it.
      expect(p).toContain('git -C <git.worktree> branch --show-current')
      expect(p).toContain('cd <git.worktree>')
      // No CWD-is-the-worktree check.
      expect(p).not.toContain('Confirm your current working directory')
      // Allow the intentional no-worktree case.
      expect(p).toContain('intentionally not used')
    }
  })

  test('worker prompts require follow-up work to be communicated to the manager', async () => {
    const parsed = await loadComposed()

    const reviewer = parsed.find((p) => p.id === 'reviewer')
    const engineer = parsed.find((p) => p.id === 'engineer')
    expect(reviewer).toBeTruthy()
    expect(engineer).toBeTruthy()

    expect(reviewer!.systemPrompt).toContain('Report discovered follow-up work to the owner')
    expect(engineer!.systemPrompt).toContain('If you discover follow-up work')
    expect(engineer!.systemPrompt).toContain('flag them to the work stream owner')

    for (const id of ['manager', 'architect', 'engineer', 'reviewer']) {
      const agentType = parsed.find((p) => p.id === id)
      expect(agentType).toBeTruthy()
      expect(agentType!.systemPrompt).toContain('## Follow-Up Work')
      expect(agentType!.systemPrompt).toContain('must be communicated to the manager')
      expect(agentType!.systemPrompt).toContain("work stream's next-steps metadata")
      expect(agentType!.systemPrompt).toContain('Never rely solely on your own short-term memory')
    }
  })

  test('squad manager and worker prompts include monitor tool guidance', async () => {
    const parsed = await loadComposed()
    for (const id of ['manager', 'architect', 'engineer', 'reviewer']) {
      const agentType = parsed.find((p) => p.id === id)
      expect(agentType).toBeTruthy()
      expect(agentType!.systemPrompt).toContain('Use the `monitor` tool to observe background commands')
      expect(agentType!.systemPrompt).toContain('Do not use a monitor to detach a one-shot build')
      expect(agentType!.systemPrompt).toContain('foreground Bash invocation with timeout up to 3600 seconds')
      expect(agentType!.systemPrompt).toContain('tail -F app.log | grep --line-buffered ERROR')
      expect(agentType!.systemPrompt).toContain('Avoid firehose output')
      expect(agentType!.systemPrompt).toContain('event-driven and quiet')
      expect(agentType!.systemPrompt).toContain('completion, error, readiness, state transition, failure')
      expect(agentType!.systemPrompt).toContain('avoid polling loops that print every interval')
      expect(agentType!.systemPrompt).toContain(
        'loop silently and print only when the job reaches a terminal or actionable state'
      )
      expect(agentType!.systemPrompt).toContain('noisy: `while true; do echo "still running"; sleep 60; done`')
      expect(agentType!.systemPrompt).toContain(
        'quiet: `while true; do if job_done; then echo "complete"; exit 0; fi; if job_failed; then echo "failed"; exit 1; fi; sleep 60; done`'
      )
      expect(agentType!.systemPrompt).toContain('`cancel` them when no longer needed')
      expect(agentType!.systemPrompt).toContain('do not replace normal tests')
    }
  })

  test('top-level subagent-capable prompts include subagent usage guidance', async () => {
    const parsed = await loadComposed()
    const subagentCapableIds = [
      'system-manager',
      'consultant',
      'manager',
      'architect',
      'engineer',
      'reviewer',
      'security-auditor',
      'sysops',
    ]

    for (const id of subagentCapableIds) {
      const agentType = parsed.find((p) => p.id === id)
      expect(agentType).toBeTruthy()
      expect(agentType!.systemPrompt).toContain(
        'Use the `dispatch` tool to send scoped, independent investigation or verification tasks'
      )
      expect(agentType!.systemPrompt).toContain('fresh-context codebase exploration')
      expect(agentType!.systemPrompt).toContain('isolated verification that would otherwise pollute your main context')
      expect(agentType!.systemPrompt).toContain(
        'Give each subagent a narrow role/task, relevant context, and the expected output'
      )
      expect(agentType!.systemPrompt).toContain('wake you when a subagent finishes')
      expect(agentType!.systemPrompt).toContain('rather than sleeping/polling solely to wait for completion')
      expect(agentType!.systemPrompt).toContain("defaults through the subagent's Standard tier")
      expect(agentType!.systemPrompt).toContain('`model` provides an explicit child override')
      expect(agentType!.systemPrompt).toContain(
        "`inheritModel: true` copies the parent's full resolved model fallback chain"
      )
      expect(agentType!.systemPrompt).toContain('`model` and `inheritModel: true` cannot be combined')
      expect(agentType!.systemPrompt).toContain('You can use `check_subagents` to query your subagents')
      expect(agentType!.systemPrompt).toContain('Synthesize subagent results before acting on them')
      expect(agentType!.systemPrompt).toContain(
        'Use `stop_subagent` when a subagent should be canceled or reconstituted'
      )
      expect(agentType!.systemPrompt).toContain('Do not use subagents for durable work-stream ownership')
      expect(agentType!.systemPrompt).toContain('do not expose subagent internals')
    }
  })

  test('subagent usage guidance is excluded from non-top-level or non-capable prompts', async () => {
    const parsed = await loadComposed()

    for (const id of ['subagent', 'artifact-builder-default', 'general']) {
      const agentType = parsed.find((p) => p.id === id)
      expect(agentType).toBeTruthy()
      expect(agentType!.systemPrompt).not.toContain(
        'Use the `dispatch` tool to send scoped, independent investigation or verification tasks'
      )
      expect(agentType!.systemPrompt).not.toContain('Do not use subagents for durable work-stream ownership')
    }
  })

  test('manager and consultant select inline-first flows without eagerly staffing a fixed team', async () => {
    const parsed = await sync.loadFromDir()
    for (const id of ['manager', 'consultant']) {
      const type = parsed.find((row) => row.id === id)!
      expect(type.systemPrompt).toContain('--workflow <preset-id>')
      expect(type.systemPrompt).toContain('--flow-content')
      expect(type.systemPrompt).toContain('--flow-stdin')
      expect(type.systemPrompt).not.toContain('--flow source.yaml')
      expect(type.systemPrompt.replace(/\s+/g, ' ')).toContain('Files remain optional via --flow for saved definitions')
      expect(type.systemPrompt).not.toContain('--agents architect,engineer,reviewer')
      expect(type.systemPrompt).not.toContain('--assign-index 1')
      expect(type.skills).not.toContain('subagent-driven-development')
    }
    expect(parsed.find((row) => row.id === 'consultant')!.systemPrompt).toContain('--owner {{manager.id}}')
  })

  test('includes are kept as a list, not merged into systemPrompt', async () => {
    const parsed = await sync.loadFromDir()
    const withIncludes = parsed.find((p) => p.includes && p.includes.length > 0)!
    expect(withIncludes.includes!.length).toBeGreaterThan(0)
    const files = await loadSharedPromptFiles()
    for (const id of withIncludes.includes!)
      expect(withIncludes.systemPrompt).not.toContain(files.get(id)!.trim().slice(0, 80))
  })

  test('toYaml produces valid YAML', async () => {
    await sync.sync()
    const rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'general'))
    expect(rows).toHaveLength(1)
    const yamlStr = sync.toYaml(rows[0] as any)
    expect(yamlStr).toContain('id: general')
    expect(yamlStr).toContain('name:')
    expect(yamlStr).toContain('model:')
    expect(yamlStr).not.toContain('updatedBy')
    expect(yamlStr).not.toContain('yamlDrift')
    expect(yamlStr).not.toContain('createdAt')
  })

  test('parse accepts a comma-separated model priority list', () => {
    const yaml = [
      'id: fallback-test',
      'name: Fallback Test',
      'model: "zai:glm-5.2:high,anthropic:claude-sonnet-4-5"',
      'systemPrompt: You are a test agent.',
    ].join('\n')
    const parsed = sync.parse(yaml, 'fallback-test.yaml')
    expect(parsed.model).toBe('zai:glm-5.2:high,anthropic:claude-sonnet-4-5')
  })

  test('parse rejects an unknown provider in a priority list', () => {
    const yaml = [
      'id: bad-fallback',
      'name: Bad Fallback',
      'model: "zai:glm-5.2:high,fake:claude-sonnet-4-5"',
      'systemPrompt: You are a test agent.',
    ].join('\n')
    expect(() => sync.parse(yaml, 'bad-fallback.yaml')).toThrow("Unknown provider 'fake'")
  })

  test('setDisabled toggles disabled flag', async () => {
    await sync.sync()
    await sync.setDisabled('engineer', true)
    let rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'engineer'))
    expect(rows[0].disabled).toBe(true)

    await sync.setDisabled('engineer', false)
    rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'engineer'))
    expect(rows[0].disabled).toBe(false)
  })

  test('getTemplateDiff works after sync', async () => {
    await sync.sync()
    const diff = await sync.getTemplateDiff('engineer')
    expect(diff.hasDrift).toBe(false)
    expect(diff.current).toBeTruthy()
    expect(diff.template).toBeTruthy()
  })

  // FIX 2: pin the scopes array round-trip. The manager template declares
  // scopes: [amtp:send], stored as extraScopes in the DB. This asserts
  // that toRecord/toComparable handle the array without producing false drift.
  test('manager getTemplateDiff shows no drift after sync (scopes array round-trip)', async () => {
    await sync.sync()
    expect((await sync.getTemplateDiff('manager')).hasDrift).toBe(false)
  })

  test('revertToTemplate restores after admin edit', async () => {
    await sync.sync()
    const originalRows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'general'))
    const originalName = originalRows[0].name

    await db
      .update(agentTypes)
      .set({ name: 'Changed Name', yamlFieldOverrides: ['name'] })
      .where(eq(agentTypes.id, 'general'))
    await sync.revertToTemplate('general')

    const rows = await db.select().from(agentTypes).where(eq(agentTypes.id, 'general'))
    expect(rows[0].name).toBe(originalName)
    expect(rows[0].yamlFieldOverrides).toEqual([])
  })
})

test('retired flowPrompt config points authors to the shared expertise prompt', () => {
  const base = 'id: worker\nname: Worker\nmodel: anthropic:claude-sonnet-4-5\nsystemPrompt: Domain expertise\n'
  expect(sync.parse(base, 'worker.yaml').systemPrompt).toBe('Domain expertise')
  expect(() => sync.parse(base + 'flowPrompt: Separate expertise\n', 'worker.yaml')).toThrow('flowPrompt was removed')
})
