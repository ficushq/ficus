/** Isolated Harbor trial bootstrap/observer. Never point this at an existing instance. */
import { readFile, writeFile } from 'node:fs/promises'
import { asc, and, eq, isNull } from 'drizzle-orm'
import { db, agents, agentTypes, modelTiers, executions, messages, workStreams, inferenceUsage } from '../db'
import { getSecretStore } from '../services/secrets'
import { getSettingsStore } from '../services/settings'
import { writeAccountStore } from '../services/agent/account-store'
import { Squad } from '../entities/Squad'
import { Agent } from '../entities/Agent'

const root = '/opt/ficus-harbor'
if (process.env.FICUS_HARBOR_TRIAL !== '1' || process.env.HOME_DIR !== `${root}/data`) {
  throw new Error('This script requires the disposable Harbor runtime')
}
const database = new URL(process.env.DATABASE_URL ?? '')
if (database.pathname !== '/ficus_harbor' || !database.hostname.startsWith('ficus-harbor-db-')) {
  throw new Error('Refusing a non-Harbor database')
}
const command = process.argv[2]
const output = process.argv[3]
if (!output?.startsWith(`${root}/`)) throw new Error('Output must be inside the trial runtime')

if (command === 'seed') {
  const config = JSON.parse(await readFile(`${root}/trial.json`, 'utf8')) as {
    model: string
    baseUrl: string
    key: string
    workspace: string
    instruction: string
  }
  if ((await db.select({ id: agents.id }).from(agents).limit(1)).length) throw new Error('Trial database is not empty')
  await getSecretStore().initialize()
  await getSettingsStore().initialize()
  await writeAccountStore(
    {
      version: 1,
      accounts: {
        'harbor-openai': [
          {
            id: 'harbor-trial',
            enabled: true,
            kind: 'openai-compatible',
            providerId: 'harbor-openai',
            credential: { type: 'api_key', key: config.key },
            baseUrl: config.baseUrl,
            model: config.model,
            capabilities: { tools: true, contextWindow: 128000, probedAt: new Date().toISOString() },
          },
        ],
      },
    },
    'harbor'
  )
  const model = `harbor-openai/${config.model}`
  // Pin EVERY role and tier; spawned workers must not silently use another model.
  await db.update(modelTiers).set({ chain: model, yamlFieldOverrides: ['chain'] })
  await db.update(agentTypes).set({ model, yamlFieldOverrides: ['model'] })
  const squad = await Squad.create({
    name: 'Harbor trial',
    purpose: 'Complete the task in the provided local environment with independent review.',
    squadPresetId: 'engineering',
    hostWorkspacePath: config.workspace,
    context: `This is an unattended local in-place delivery run in a disposable, single-task workspace, not a shared checkout. The user has authorized completing the supplied task. The task workspace is ${config.workspace}. Inspect it to resolve ambiguity; no human can answer questions. Deliver completed files in that exact workspace, without requiring GitHub, a pull request, a merge approval, or an external deployment.`,
    metadata: {
      memory: { enabled: false },
      workflow: { kind: 'preset', id: 'builder-reviewer' },
      workflowSetup: {
        guidance:
          'The user requires the With Review flow and local in-place delivery in this disposable, single-task workspace. Inherit the saved default; do not select a PR-based coding flow. No other stream shares this workspace.',
        choices: [{ when: 'All tasks in this isolated run.', source: { kind: 'preset', id: 'builder-reviewer' } }],
      },
    },
    typeContext: {
      manager:
        'Run this task through your squad. Create and start a work stream using the configured With Review workflow, with an engineer producing the deliverable and an independent reviewer checking it. Delegate implementation rather than doing it yourself. Handle rework through that workflow and finish after review. Do not stop at a plan or clarification question: inspect the workspace and make reasonable decisions from the task requirements. Do not use a separate worktree unless the completed changes are put back into the supplied workspace before finishing.',
    },
  })
  const manager = await Agent.mustFind(squad.managerAgentId!)
  await manager.sendMessage(config.instruction, { metadata: { source: 'harbor' } })
  await writeFile(output, JSON.stringify({ squadId: squad.id, managerId: manager.id }))
} else if (command === 'snapshot') {
  // The database belongs to exactly one trial: include all agents, even parented children.
  const [members, turns, streams, usage, pendingMessages] = await Promise.all([
    db
      .select({
        id: agents.id,
        agentTypeId: agents.agentTypeId,
        parentAgentId: agents.parentAgentId,
        status: agents.status,
        questionData: agents.questionData,
      })
      .from(agents),
    db
      .select({
        id: executions.id,
        agentId: executions.agentId,
        status: executions.status,
        error: executions.error,
        usage: executions.usage,
      })
      .from(executions),
    db.select({ id: workStreams.id, title: workStreams.title, status: workStreams.status }).from(workStreams),
    db.select().from(inferenceUsage),
    db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.pending, true), isNull(messages.injectedAt))),
  ])
  await writeFile(output, JSON.stringify({ agents: members, executions: turns, streams, usage, pendingMessages }))
} else if (command === 'export') {
  const transcript = await db
    .select({
      id: messages.id,
      agentId: messages.agentId,
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .orderBy(asc(messages.createdAt))
  await writeFile(output, JSON.stringify(transcript, null, 2))
} else {
  throw new Error('Expected seed, snapshot, or export')
}
process.exit(0)
