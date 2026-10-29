import { expect, spyOn, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agents, inbox } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser } from '../test-utils'
import * as delivery from '../services/inbox/inboxDelivery'
import { inboxRouter } from './inbox'
import { inboxResource, type RequestOptions, type Transport } from '@ficus/client-core'

const app = new Hono()
app.use('*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/inbox', inboxRouter)

test('client-core and real CLI JSON exports preserve safe message/page/send contracts', async () => {
  const prefix = `inbox-export-${crypto.randomUUID()}`
  const owner = await createTestUser({ prefix })
  const reader = await createTestAdmin({ prefix })
  const [agent] = await db
    .insert(agents)
    .values({
      agentTypeId: 'system-manager',
      ownerUserId: owner.id,
      metadata: { name: 'Private Assistant' },
      context: { sentinel: 'SYNTHETIC_EXPORT_PRIVATE_CONTEXT' },
    })
    .returning()
  const content = '  Exact authored context, configuration and credentials λ\n'
  const metadata = {
    sender: { userId: 'synthetic-user', name: 'Authored attribution' },
    context: { authored: 'Do not redact' },
  }
  const [row] = await db
    .insert(inbox)
    .values({
      recipientType: 'user',
      recipientId: reader.id,
      senderType: 'agent',
      senderId: agent.id,
      content,
      metadata,
    })
    .returning()
  const ids = [row.id]
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })
  const deliver = spyOn(delivery, 'deliverInboxMessagesToAgent').mockResolvedValue(undefined)
  const cliModule = new URL('../../../cli/src/commands/inbox.ts', import.meta.url).pathname
  const outputModule = new URL('../../../cli/src/output.ts', import.meta.url).pathname
  const commander = Bun.resolveSync('commander', cliModule)
  const cliSource = `
    import { Command } from ${JSON.stringify(commander)}
    import { registerInboxCommands } from ${JSON.stringify(cliModule)}
    import { setOutputOptions } from ${JSON.stringify(outputModule)}
    setOutputOptions({ json: true })
    const program = new Command()
    registerInboxCommands(program)
    await program.parseAsync(process.argv.slice(1), { from: 'user' })
  `
  try {
    const participant = {
      id: agent.id,
      name: 'Private Assistant',
      agentTypeId: 'system-manager',
      squadId: null,
      ownerUserId: owner.id,
    }
    const assertMessage = (m: any) => {
      expect(m.senderAgent).toEqual(participant)
      expect(m.recipientAgent).toBeNull()
      expect(m.content).toBe(content)
      expect(m.metadata).toEqual(metadata)
      expect(m.createdAt).toBe(row.createdAt.toISOString())
      expect(JSON.stringify(m)).not.toContain('SYNTHETIC_EXPORT_PRIVATE_CONTEXT')
    }
    const transport: Transport = {
      async request<T>(path: string, options?: RequestOptions) {
        const result = await app.request(`/api${path}`, {
          method: options?.method,
          headers: { ...authHeaders(reader.token), 'Content-Type': 'application/json' },
          body: options?.body ? JSON.stringify(options.body) : undefined,
        })
        expect(result.status).toBe(options?.method === 'POST' ? 201 : 200)
        return (await result.json()) as T
      },
      openStream: async () => {
        throw new Error('Not used')
      },
      wsUrl: () => 'ws://synthetic-inbox.invalid',
      url: (path) => `http://synthetic-inbox.invalid/api${path}`,
    }
    const client = inboxResource(transport)
    assertMessage((await client.getMyInbox())[0])
    assertMessage((await client.getMyInboxPage()).items[0])
    assertMessage(await client.getInboxMessage(row.id))
    const sent = await client.sendInboxMessage({ recipientType: 'user', recipientId: reader.id, content })
    ids.push(sent.id)
    expect(sent.senderAgent).toBeNull()
    expect(sent.metadata.sender).toMatchObject({ userId: reader.id, name: reader.displayName })

    // Execute real CLI commands/output against only the test-owned loopback API.
    // A sterile child environment cannot fall back to the operator's credentials.
    for (const args of [['list'], ['list', '--limit', '10'], ['send', agent.id, content]]) {
      const child = Bun.spawn([process.execPath, '--no-install', '-e', cliSource, 'inbox', ...args], {
        cwd: process.env.HOME_DIR,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME_DIR,
          FICUS_AGENT_CONTEXT: '1',
          FICUS_API_URL: `http://127.0.0.1:${server.port}`,
          FICUS_TOKEN: reader.token,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      let text: string
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(stderr).toBe('')
        expect(exit).toBe(0)
        text = stdout
      } finally {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
      const exported = JSON.parse(text)
      if (args[0] === 'list') {
        assertMessage((Array.isArray(exported) ? exported : exported.items).find((m: any) => m.id === row.id))
        if (args.includes('--limit'))
          expect(exported).toMatchObject({ items: expect.any(Array), hasMore: false, nextCursor: null, totalCount: 2 })
      } else {
        ids.push(exported.id)
        expect(exported.recipientAgent).toEqual(participant)
        expect(exported.content).toBe(content)
        expect(exported.metadata.sender).toMatchObject({ userId: reader.id, name: reader.displayName })
        expect(JSON.stringify(exported)).not.toContain('SYNTHETIC_EXPORT_PRIVATE_CONTEXT')
      }
    }
  } finally {
    await server.stop(true)
    deliver.mockRestore()
    await db.delete(inbox).where(inArray(inbox.id, ids))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await cleanupTestRbac(prefix)
  }
})
