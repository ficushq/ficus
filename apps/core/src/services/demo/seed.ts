import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
  agentQuestionRecipients,
  agentQuestions,
  agentTypes,
  deviceTokens,
  messages,
  roleAssignments,
  squads,
  users,
  workStreams,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { InboxMessage } from '../../entities/InboxMessage'
import { Role } from '../../entities/Role'
import { Squad } from '../../entities/Squad'
import { User } from '../../entities/User'
import { WorkStream } from '../../entities/WorkStream'
import { createLogger } from '../../lib/infra/logger'
import { readAccountStore } from '../agent/account-store'
import { publishDeviceTokenRevocation } from '../auth/device-token-events'
import { openWait } from '../work-streams/waits'
import { DEMO_REVIEWER_EMAIL, DEMO_REVIEWER_ROLE_SLUG } from './access'

const log = createLogger('demo-seed')

/**
 * Bump when the content below changes shape enough that an instance seeded
 * with the previous version should be re-curated by hand; the seed itself
 * is additive and never deletes what an operator curated on top.
 */
export const DEMO_SEED_VERSION = 1

// ── Content ───────────────────────────────────────────────────────────────
// What a reviewer sees. Every item has a stable key so re-running the seed
// finds it instead of duplicating it; edit text freely, keep keys unique.

type DemoStreamState = 'active' | 'review' | 'done'

interface DemoStreamSpec {
  key: string
  title: string
  description: string
  priority: 'critical' | 'high' | 'normal' | 'low'
  state: DemoStreamState
  /** The assignee's latest report, shown on the stream. */
  handoffMessage?: string
  /** `review` only: what the reviewer is asked to approve. */
  reviewRequest?: string
}

interface DemoTranscriptTurn {
  key: string
  role: 'human' | 'assistant'
  content: string
}

interface DemoQuestionSpec {
  key: string
  question: string
  options?: { label: string; description?: string }[]
}

interface DemoInboxSpec {
  key: string
  subject: string
  content: string
}

interface DemoSquadSpec {
  key: string
  name: string
  purpose: string
  squadPresetId?: string
  defaultAgents: string[]
  streams: DemoStreamSpec[]
  /** Conversation with the squad manager, oldest first. */
  transcript: DemoTranscriptTurn[]
  /** Open questions the manager is asking the reviewer. */
  questions: DemoQuestionSpec[]
  /** Inbox messages from the manager to the reviewer. */
  inbox: DemoInboxSpec[]
}

export const DEMO_CONTENT: DemoSquadSpec[] = [
  {
    key: 'product-engineering',
    name: 'Product Engineering',
    purpose:
      'Builds and maintains the Acme customer web app: onboarding, billing, and the public API. Ships small, reviewed changes daily.',
    squadPresetId: 'engineering',
    defaultAgents: ['architect', 'engineer', 'reviewer'],
    streams: [
      {
        key: 'onboarding-checklist',
        title: 'Redesign the onboarding checklist',
        description:
          'Replace the five-step modal with an inline checklist on the dashboard. Keep progress per workspace, add an empty state for teams with no projects yet, and track completion in analytics.',
        priority: 'high',
        state: 'active',
        handoffMessage:
          'Checklist component and progress persistence are done. Empty state is blocked on the copy decision I asked about; analytics events are wired behind a flag.',
      },
      {
        key: 'webhook-retries',
        title: 'Fix flaky payment webhook retries',
        description:
          'Stripe webhooks occasionally arrive twice within the retry window and the second delivery marks the invoice unpaid. Make handling idempotent by event id and add a regression test.',
        priority: 'critical',
        state: 'review',
        handoffMessage:
          'Root cause: the dedupe key used the invoice id, not the event id. Fixed, tests added for duplicate and out-of-order deliveries. PR #412 is green.',
        reviewRequest: 'PR #412 (idempotent webhook handling) is green and reviewed. Approve to merge and complete.',
      },
      {
        key: 'search-rate-limit',
        title: 'Add rate limiting to the public search API',
        description:
          'Anonymous search traffic spikes are slowing the dashboard. Add a per-key token bucket (60 rpm) with a Retry-After header and document it.',
        priority: 'normal',
        state: 'active',
        handoffMessage: 'Design agreed: token bucket in the API gateway, keyed by API key with an anonymous fallback.',
      },
      {
        key: 'bun-upgrade',
        title: 'Move CI runners to Bun 1.3',
        description:
          'Upgrade the CI images, fix the two test files that depended on the old test runner, and re-pin lockfiles.',
        priority: 'low',
        state: 'done',
        handoffMessage: 'Merged. CI wall-clock dropped from 11m to 7m.',
      },
    ],
    transcript: [
      { key: 'pe-1', role: 'human', content: 'What is the squad working on this week?' },
      {
        key: 'pe-2',
        role: 'assistant',
        content:
          'Three things are in flight:\n\n1. **Redesign the onboarding checklist** (high) — the engineer has the component done and is waiting on a copy decision for the empty state.\n2. **Fix flaky payment webhook retries** (critical) — fixed and in review; PR #412 is green and waiting for your approval.\n3. **Add rate limiting to the public search API** — design agreed, implementation starts after the webhook fix merges.\n\nThe CI runner upgrade shipped Monday.',
      },
      { key: 'pe-3', role: 'human', content: 'Anything blocking?' },
      {
        key: 'pe-4',
        role: 'assistant',
        content:
          'Only the empty-state copy for the onboarding checklist. I asked you a question about it in the Action Center — pick an option there and the engineer will finish the stream today.',
      },
    ],
    questions: [
      {
        key: 'pe-empty-state',
        question:
          'The onboarding checklist needs an empty state for teams with no projects yet. Which direction should we ship?',
        options: [
          { label: 'Guided', description: '"Create your first project" with a one-click sample project.' },
          { label: 'Minimal', description: 'A single line of copy and the New project button, no sample data.' },
        ],
      },
    ],
    inbox: [
      {
        key: 'pe-webhook-review',
        subject: 'Payment webhook fix is ready for review',
        content:
          'PR #412 makes webhook handling idempotent by event id and adds regression tests for duplicate and out-of-order deliveries. CI is green. Approve the review request on the work stream to merge.',
      },
    ],
  },
  {
    key: 'growth',
    name: 'Growth',
    purpose: 'Writes and ships product marketing: launch posts, lifecycle email, and the pricing page.',
    defaultAgents: ['general'],
    streams: [
      {
        key: 'september-update',
        title: 'Draft the September product update',
        description:
          'A short changelog-style email covering the onboarding redesign, faster CI, and the new search limits. Link each item to docs.',
        priority: 'normal',
        state: 'review',
        handoffMessage: 'Draft attached in the stream files. 320 words, three items, one CTA.',
        reviewRequest: 'The September update draft is ready. Approve to schedule it for Tuesday 9am.',
      },
      {
        key: 'pricing-copy',
        title: 'Refresh the pricing page copy',
        description: 'Rewrite the three plan descriptions to lead with outcomes, and align feature names with the app.',
        priority: 'normal',
        state: 'done',
        handoffMessage: 'Shipped. Bounce rate on /pricing down 9% week over week.',
      },
    ],
    transcript: [
      { key: 'g-1', role: 'human', content: 'Can you summarize the September update draft in one line?' },
      {
        key: 'g-2',
        role: 'assistant',
        content:
          '"Onboarding is now a checklist, CI is 40% faster, and the search API has fair-use limits — here is what changed and why." It is waiting for your approval on the work stream.',
      },
    ],
    questions: [
      {
        key: 'g-tone',
        question: 'Which tone should the September update take?',
        options: [
          { label: 'Straightforward', description: 'Plain changelog, no jokes.' },
          { label: 'Playful', description: 'Light, one pun, still scannable.' },
        ],
      },
    ],
    inbox: [],
  },
]

// ── Seeding ───────────────────────────────────────────────────────────────

export interface DemoSeedSummary {
  version: number
  user: { id: string; email: string; role: string }
  squads: { id: string; name: string; agents: number; workStreams: number }[]
  transcriptMessages: number
  questions: number
  inboxMessages: number
  /** Whether any model provider account is connected; without one, agents cannot answer. */
  modelProviderConfigured: boolean
  /** Human-readable list of what this run created (empty when everything already existed). */
  created: string[]
}

export class DemoSeedError extends Error {}

const demoMetadata = { demo: { version: DEMO_SEED_VERSION } }

/**
 * Create or refresh the reviewer account and its world. Every step looks
 * for what it would create before creating it, so the command can be re-run
 * after an upgrade, after curating on top, or after a partial failure.
 */
export async function seedDemoInstance(): Promise<DemoSeedSummary> {
  const created: string[] = []

  const role = await ensureBundledConfig(created)

  let user = await User.findByEmail(DEMO_REVIEWER_EMAIL)
  if (!user) {
    // A shared account: it doesn't get the farm (it may only look at what the demo reviewer role allows).
    user = await User.create({ email: DEMO_REVIEWER_EMAIL, displayName: 'App Review', withoutDefaultRoles: true })
    created.push(`user ${DEMO_REVIEWER_EMAIL}`)
  } else if (user.disabledAt) {
    // A previous revocation disabled the account; seeding is the explicit re-enable.
    await db.update(users).set({ disabledAt: null, updatedAt: new Date() }).where(eq(users.id, user.id))
    user = (await User.findByEmail(DEMO_REVIEWER_EMAIL))!
    created.push('re-enabled the demo account')
  }
  const [assignment] = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.subjectId, user.id),
        eq(roleAssignments.roleId, role.id),
        eq(roleAssignments.scope, 'system')
      )
    )
  if (!assignment) {
    await db
      .insert(roleAssignments)
      .values({ subjectType: 'user', subjectId: user.id, roleId: role.id, scope: 'system' })
      .onConflictDoNothing()
    created.push(`role ${role.slug}`)
  }
  const sender = { userId: user.id, name: user.displayName || user.email }

  const summary: DemoSeedSummary = {
    version: DEMO_SEED_VERSION,
    user: { id: user.id, email: user.email, role: role.slug },
    squads: [],
    transcriptMessages: 0,
    questions: 0,
    inboxMessages: 0,
    modelProviderConfigured: hasModelProvider(),
    created,
  }

  for (const spec of DEMO_CONTENT) {
    const squad = await ensureSquad(spec, created)
    const manager = await squad.getManagerAgent()
    if (!manager) throw new DemoSeedError(`Squad ${spec.name} has no manager agent`)
    const agents = await squad.getAgents()

    let streamCount = 0
    for (const stream of spec.streams) {
      await ensureStream(squad, manager, user.id, stream, created)
      streamCount++
    }
    for (const turn of spec.transcript) {
      if (await ensureTranscriptTurn(manager.id, turn, sender)) created.push(`message ${spec.key}/${turn.key}`)
      summary.transcriptMessages++
    }
    for (const question of spec.questions) {
      if (await ensureQuestion(manager.id, squad.id, user.id, question)) created.push(`question ${question.key}`)
      summary.questions++
    }
    for (const message of spec.inbox) {
      const result = await InboxMessage.sendOnce(
        {
          recipientType: 'user',
          recipientId: user.id,
          senderType: 'agent',
          senderId: manager.id,
          subject: message.subject,
          content: message.content,
          metadata: demoMetadata,
        },
        `demo:${DEMO_SEED_VERSION}:inbox:${message.key}`
      )
      if (result.created) created.push(`inbox ${message.key}`)
      summary.inboxMessages++
    }

    summary.squads.push({ id: squad.id, name: squad.name, agents: agents.length, workStreams: streamCount })
  }

  log.info(`Demo seed v${DEMO_SEED_VERSION}: ${created.length ? created.join(', ') : 'nothing to create'}`)
  return summary
}

/** Revoke every device the demo account has paired. Returns how many were live. */
export async function revokeDemoReviewerDevices(): Promise<number> {
  const user = await User.findByEmail(DEMO_REVIEWER_EMAIL)
  if (!user) return 0
  const revoked = await db
    .update(deviceTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(deviceTokens.userId, user.id), isNull(deviceTokens.revokedAt)))
    .returning({ id: deviceTokens.id })
  for (const { id } of revoked) await publishDeviceTokenRevocation(id)
  return revoked.length
}

// ── Steps ─────────────────────────────────────────────────────────────────

/**
 * The seed leans on bundled config (the reviewer role, agent types, the
 * engineering preset and its workflows) that boot syncs from config/. A
 * database that has not booted on this version gets the missing pieces
 * synced here rather than a failure, so the command works in any order.
 */
async function ensureBundledConfig(created: string[]): Promise<Role> {
  const sync = await import('../config-sync')
  let role = await Role.findBySlug(DEMO_REVIEWER_ROLE_SLUG)
  if (!role) {
    await sync.roleSync.sync()
    role = await Role.findBySlug(DEMO_REVIEWER_ROLE_SLUG)
    if (!role) throw new DemoSeedError(`Role "${DEMO_REVIEWER_ROLE_SLUG}" is missing from config/roles/defaults.yaml.`)
    created.push('bundled roles synced')
  }

  // Bundled definitions the content relies on, inserted only when missing:
  // the boot sync owns updates and removals.
  const requiredTypes = [...new Set(['manager', ...DEMO_CONTENT.flatMap((squad) => squad.defaultAgents)])]
  const presetIds = [...new Set(DEMO_CONTENT.flatMap((squad) => (squad.squadPresetId ? [squad.squadPresetId] : [])))]
  const inserted = [
    ...(await sync.workflowSync.syncMissing()),
    ...(await sync.squadPresetSync.syncMissing(presetIds)),
    ...(await sync.agentTypeSync.syncMissing(requiredTypes)),
  ]
  const tierSlugs = (
    await db.select({ tier: agentTypes.tier }).from(agentTypes).where(inArray(agentTypes.id, requiredTypes))
  ).flatMap((row) => (row.tier ? [row.tier] : []))
  if (tierSlugs.length) inserted.push(...(await sync.modelTierSync.syncMissing(tierSlugs)))
  if (inserted.length) created.push(`bundled config inserted (${inserted.join(', ')})`)
  return role
}

function hasModelProvider(): boolean {
  try {
    return Object.values(readAccountStore().accounts).some((accounts) => accounts.some((account) => account.enabled))
  } catch {
    return false
  }
}

async function ensureSquad(spec: DemoSquadSpec, created: string[]): Promise<Squad> {
  const [existing] = await db
    .select({ id: squads.id })
    .from(squads)
    .where(and(eq(squads.name, spec.name), sql`${squads.metadata}->'demo' IS NOT NULL`))
    .limit(1)
  if (existing) {
    const squad = await Squad.mustFind(existing.id)
    await squad.reconcileAgents()
    return squad
  }
  const squad = await Squad.create({
    name: spec.name,
    purpose: spec.purpose,
    squadPresetId: spec.squadPresetId,
    defaultAgents: spec.defaultAgents,
    metadata: { ...demoMetadata, demoKey: spec.key },
  })
  created.push(`squad ${spec.name}`)
  return squad
}

async function ensureStream(
  squad: Squad,
  manager: Agent,
  requestingUserId: string,
  spec: DemoStreamSpec,
  created: string[]
): Promise<WorkStream> {
  const [existing] = await db
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(and(eq(workStreams.squadId, squad.id), eq(workStreams.title, spec.title)))
    .limit(1)
  if (existing) return WorkStream.mustFind(existing.id)

  if (spec.state === 'done') {
    // Finished work has no flow to drive: a completed row, the way streams
    // from before flows are stored, so nothing tries to resume it.
    const [row] = await db
      .insert(workStreams)
      .values({
        squadId: squad.id,
        title: spec.title,
        description: spec.description,
        status: 'done',
        autoCleanupWorktree: true,
        priority: spec.priority,
        ownerAgentId: manager.id,
        requestingUserId,
        handoffMessage: spec.handoffMessage ?? null,
        metadata: { ...demoMetadata, demoKey: spec.key },
      })
      .returning({ id: workStreams.id })
    created.push(`work stream ${spec.title}`)
    return WorkStream.mustFind(row.id)
  }

  const stream = await WorkStream.create({
    squadId: squad.id,
    title: spec.title,
    description: spec.description,
    priority: spec.priority,
    requestingUserId,
    handoffMessage: spec.handoffMessage ?? null,
    metadata: { ...demoMetadata, demoKey: spec.key },
  })
  created.push(`work stream ${spec.title}`)

  if (spec.state === 'review') {
    await openWait(db, {
      workStreamId: stream.id,
      type: 'review',
      message: spec.reviewRequest ?? 'Ready for review.',
      createdBy: 'agent',
      createdByAgentId: manager.id,
      completesOnApproval: true,
    })
  }
  return stream
}

async function ensureTranscriptTurn(
  agentId: string,
  turn: DemoTranscriptTurn,
  sender: { userId: string; name: string }
): Promise<boolean> {
  const [existing] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.agentId, agentId), sql`${messages.metadata}->'demo'->>'key' = ${turn.key}`))
    .limit(1)
  if (existing) return false
  await db.insert(messages).values({
    agentId,
    role: turn.role,
    content: turn.content,
    metadata:
      turn.role === 'human'
        ? { source: 'user_chat', sender, demo: { version: DEMO_SEED_VERSION, key: turn.key } }
        : { demo: { version: DEMO_SEED_VERSION, key: turn.key } },
    pending: false,
    injectedAt: new Date(),
  })
  return true
}

async function ensureQuestion(
  agentId: string,
  squadId: string,
  recipientUserId: string,
  spec: DemoQuestionSpec
): Promise<boolean> {
  const [existing] = await db
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.agentId, agentId), sql`${agentQuestions.questionData}->>'demoKey' = ${spec.key}`))
    .limit(1)
  if (existing) return false
  const [question] = await db
    .insert(agentQuestions)
    .values({
      agentId,
      squadId,
      executionId: null,
      status: 'open',
      audienceResolution: 'resolved',
      audienceResolvedAt: new Date(),
      questionData: {
        demoKey: spec.key,
        questions: [
          {
            id: spec.key,
            type: spec.options ? 'select' : 'text',
            question: spec.question,
            ...(spec.options
              ? {
                  options: spec.options.map((option) => ({
                    value: option.label,
                    label: option.description ? `${option.label} — ${option.description}` : option.label,
                  })),
                }
              : {}),
          },
        ],
      },
    })
    .returning({ id: agentQuestions.id })
  await db
    .insert(agentQuestionRecipients)
    .values({ questionId: question.id, userId: recipientUserId, reason: 'workstream-requester' })
    .onConflictDoNothing()
  return true
}
