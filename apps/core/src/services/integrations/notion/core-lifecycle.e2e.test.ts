import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('notion')
import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { eq } from 'drizzle-orm'
import { db, integrationConnections, integrationProjectionStates, squads, users } from '../../../db'
import { githubCommandBindings, regenerateEnvFileForSquad } from '../../squad/env'
import { ensureSquadWorkspace } from '../../squad/workspace'
import { getSecretStore } from '../../secrets'
import { ensureSandboxToolchain } from '../../sandbox/toolchain/provision'
import { IntegrationAuthorizationService } from '../authorization/service'
import { DbOAuthStateRepository } from '../authorization/db-state-repository'
import { ConnectionAuthorizationLease } from '../authorization/connection-lease'
import { IntegrationRefreshService } from '../authorization/refresh-service'
import { DbAuthorizationFlowReceiptRepository } from '../authorization/flow-repository'
import { RevocationArtifactStager } from '../authorization/revocation-artifact-stager'
import { parseOAuthCredential } from '../authorization/credential-bundle'
import type { OAuthTransport } from '../authorization/transport'
import { IntegrationConnectionService } from '../connection-service'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { DbIntegrationProjectionStateRepository } from '../projection/db-state-repository'
import { resolveAssignedIntegrationRefs } from '../projection/agent-refs'
import { IntegrationProjectionReconciler } from '../projection/reconciler'
import { IntegrationProjectionWorker } from '../projection/worker'
import { NotionClient, type NotionTokenResponse } from '@ficus/shared/oauth-providers/notion/client'
import { parseNotionConfiguration } from '@ficus/shared/oauth-providers/notion/config'
import { NotionConnectionAuthorizer } from './connection-authorizer'
import { createNotionPlugin } from './plugin'
import { expectCleanExit, expectFailedExit, runCapturedProcess } from '../../../test-utils/captured-process'

const binary = join(dirname(Bun.resolveSync('ntn/package.json', import.meta.dir)), 'bin', 'ntn')

test('GitHub bindings work in POSIX sh and remain inherited by child Bash shells', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-integration-shell-'))
  const squadId = crypto.randomUUID()
  const bindings = githubCommandBindings(squadId)
  try {
    // Own the executable so this regression needs no provider or installed CLI.
    const ficus = join(root, 'ficus')
    writeFileSync(ficus, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
    for (const [shell, command] of [
      ['sh', 'gh pr list'],
      ['bash', "bash -c 'gh pr list'"],
    ]) {
      const result = await runCapturedProcess([shell, '-c', `${bindings}\n${command}`], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, BASH_ENV: undefined, ENV: undefined },
        timeoutMs: 3_000,
      })
      expectCleanExit(result)
      expect(result.stdout.trim().split('\n')).toEqual([
        'integration',
        'exec',
        'github',
        '--squad',
        squadId,
        '--',
        'gh',
        'pr',
        'list',
      ])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Git credential operations reach the squad integration with their operation argument', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-git-credential-'))
  try {
    writeFileSync(
      join(root, 'ficus'),
      '#!/bin/sh\nfor arg; do operation="$arg"; done\nprintf "%s\\n" "$@" >> "$FICUS_TEST_ARGS"\ncat >/dev/null\nif [ "$operation" = get ]; then printf "username=fixture\\npassword=fixture-token\\n"; fi\n',
      { mode: 0o700 }
    )
    for (const operation of ['fill', 'approve', 'reject']) {
      const args = join(root, operation)
      const result = await runCapturedProcess(
        [
          'sh',
          '-c',
          `${githubCommandBindings('fixture-squad')}\nprintf 'protocol=https\\nhost=github.com\\nusername=fixture\\n${operation === 'fill' ? '' : 'password=fixture-token\\n'}\\n' | git credential ${operation}`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            FICUS_TEST_ARGS: args,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            BASH_ENV: undefined,
            ENV: undefined,
          },
          timeoutMs: 3000,
        }
      )
      expectCleanExit(result)
      expect((await Bun.file(args).text()).trim().split('\n')).toEqual([
        'integration',
        'exec',
        'github',
        '--squad',
        'fixture-squad',
        '--',
        'gh',
        'auth',
        'git-credential',
        { fill: 'get', approve: 'store', reject: 'erase' }[operation]!,
      ])
      if (operation === 'fill') expect(result.stdout).toContain('password=fixture-token')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Core connect assign reconcile real CLI rotate without reinstall and unassign', async () => {
  const priorEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
  process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey ?? '0'.repeat(64)
  const root = mkdtempSync(join(tmpdir(), 'tau-notion-core-e2e-'))
  const envFile = join(root, '.env')
  const egressLog = join(root, 'egress.log')
  const egressGuard = join(root, 'egress-guard.cjs')
  writeFileSync(
    egressGuard,
    `const fs=require('node:fs');const net=require('node:net');const tls=require('node:tls');
const host=a=>typeof a[0]==='object'?a[0]?.host:(typeof a[1]==='string'?a[1]:'localhost');
const allowed=h=>!h||h==='localhost'||h==='127.0.0.1'||h==='::1';
for(const [m,k] of [[net,'connect'],[net,'createConnection'],[tls,'connect']]){const original=m[k];m[k]=function(...a){const h=host(a);if(!allowed(h)){fs.appendFileSync(process.env.FICUS_EGRESS_LOG,h+'\\n');throw new Error('non-loopback egress blocked')}return original.apply(this,a)}};`
  )
  const secretStore = getSecretStore()
  await secretStore.initialize()
  const accepted: string[] = []
  const workspaceId = crypto.randomUUID()
  const workspaceName = `Workspace ${workspaceId}`
  let tokenExchange = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/v1/oauth/token') {
        tokenExchange += 1
        return Response.json({
          access_token: tokenExchange === 1 ? 'access-one' : 'access-two',
          refresh_token: tokenExchange === 1 ? 'refresh-one' : 'refresh-two',
          workspace_id: workspaceId,
          workspace_name: workspaceName,
          workspace_icon: null,
          bot_id: 'bot-id',
          token_type: 'bearer',
          owner: { type: 'user', user: { object: 'user', id: 'user-id' } },
          duplicated_template_id: null,
        })
      }
      if (path === '/v1/users/me')
        return Response.json({ object: 'user', id: 'bot-id', type: 'bot', name: null, avatar_url: null, bot: {} })
      if (path === '/v1/search') {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
        if (!['access-one', 'access-two'].includes(token)) {
          // A rejected token is exit 4 rather than 5, so distinguishing it in
          // the log separates "wrong credential" from "request never landed".
          console.error('[notion-fake] rejecting unknown bearer token')
          return Response.json({ code: 'unauthorized' }, { status: 401 })
        }
        accepted.push(token)
        return Response.json({
          object: 'list',
          results: [],
          next_cursor: null,
          has_more: false,
          type: 'page_or_database',
          page_or_database: {},
        })
      }
      // Name the request instead of 404ing silently. `ntn` reports any
      // non-2xx as the same "Failed to execute public API request" and exits 5,
      // so a request this fake API does not know is indistinguishable from a
      // refused connection in the child's own output — which is what made this
      // the top flake with no usable diagnosis
      // (docs/history/design/ci-stability-and-flake-eradication.md, Part A).
      console.error(`[notion-fake] unhandled ${request.method} ${path}`)
      return new Response('unexpected', { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const notionClient = new NotionClient({
    fetch: (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      expect(url.origin).toBe('https://api.notion.com')
      return fetch(new Request(`${origin}${url.pathname}${url.search}`, request))
    },
  })
  const plugin = createNotionPlugin(notionClient)
  const grantFrom = (token: NotionTokenResponse) => ({
    tokens: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
    },
    configuration: parseNotionConfiguration({
      version: 1,
      workspaceId: token.workspaceId,
      workspaceName: token.workspaceName,
      workspaceIcon: token.workspaceIcon,
      botId: token.botId,
    }),
    displayName: token.workspaceName?.trim().slice(0, 200) || 'Notion workspace',
  })
  const transport: OAuthTransport = {
    authority: 'local',
    async authorizationUrl(input) {
      const url = notionClient.buildAuthorizationUrl({
        clientId: 'client-id',
        redirectUri: 'https://ficus.example/oauth/callback',
        state: input.localFlowId,
      })
      return { authorizationUrl: url.toString(), expiresAt: new Date(Date.now() + 600_000).toISOString() }
    },
    async completeAuthorization(input) {
      return grantFrom(
        await notionClient.exchangeCode({
          code: input.code!,
          redirectUri: input.redirectUri!,
          clientId: 'client-id',
          clientSecret: 'client-secret',
        })
      )
    },
    async refresh(input) {
      return grantFrom(
        await notionClient.refresh({
          refreshToken: input.refreshToken,
          clientId: 'client-id',
          clientSecret: 'client-secret',
        })
      )
    },
    async revoke(input) {
      await notionClient.revoke({ token: input.token, clientId: 'client-id', clientSecret: 'client-secret' })
    },
  }
  const repository = new DbIntegrationConnectionRepository()
  const credentialStore = secretStore
  const connectionService = new IntegrationConnectionService({
    repository,
    assignments: repository,
    credentials: credentialStore,
    resolveProvider: () => plugin.runtime.provider,
    allowsManualCredential: () => false,
    safeConfiguration: (_key, value) =>
      plugin.connection.safeConfiguration(plugin.connection.parseConfiguration(value)),
    requiresRemoteRevocation: () => true,
  })
  const flowReceipts = new DbAuthorizationFlowReceiptRepository()
  const authorizer = new NotionConnectionAuthorizer({
    repository: {
      get: (id) => repository.get(id),
      getByAuthorizationFlow: (localFlowId) => repository.getByAuthorizationFlow(localFlowId),
      list: (key) => repository.list(key),
      installAuthorizedMaterial: (input) => repository.installAuthorizedMaterial!(input),
      enqueueRevocation: (input) => repository.scheduleRevocation!(input),
      ownsRevocation: (input) => repository.ownsRevocation(input),
      abandonPendingAuthorization: (input) => repository.abandonPendingAuthorization(input),
    },
    flowReceipts,
    stageRevocationArtifact: (input) => new RevocationArtifactStager(secretStore).stage(input),
    connectionService,
    credentials: credentialStore,
    plugin,
    transport,
    lease: new ConnectionAuthorizationLease(),
  })
  const authorization = new IntegrationAuthorizationService({
    states: new DbOAuthStateRepository(),
    flowReceipts,
    resolvePlugin: () => plugin,
    transport,
    callbackUrl: () => 'https://ficus.example/oauth/callback',
    installGrant: ({ state, exchange, userId }) => authorizer.install({ intent: state, exchange, userId }),
  })
  const projectionStates = new DbIntegrationProjectionStateRepository()
  let installedFingerprint: string | null = null
  let observedSkills: readonly string[] = []
  let observedEnv = ''
  let installCount = 0
  let readinessCount = 0
  const reconciler = new IntegrationProjectionReconciler({
    connections: repository,
    regenerateEnv: async (squadId) => {
      await regenerateEnvFileForSquad(squadId)
      const generated = join(ensureSquadWorkspace(squadId), '.tau', '.env')
      observedEnv = await Bun.file(generated).text()
      observedSkills = (await resolveAssignedIntegrationRefs(squadId)).skills
      writeFileSync(envFile, observedEnv, { mode: 0o600 })
      chmodSync(envFile, 0o600)
    },
    manager: {
      attachExistingSandbox: async () => true,
      reconcileToolchain: async (_sandboxId: string, _options: unknown, desired: any) => {
        if (!desired.config) {
          installedFingerprint = null
          return
        }
        if (installedFingerprint !== desired.fingerprint) {
          installCount += 1
          installedFingerprint = desired.fingerprint
        }
        readinessCount += 1
        expect(desired.config.packages).toContain('nodejs@24.12.0')
        expect(desired.config.setupScript).toContain('npm pack --silent ntn@0.22.10')
        expect(desired.readiness).toContainEqual({
          id: 'notion-cli',
          command: 'ntn --version',
          expectedSubstring: '0.22.10',
        })
        expect(Bun.spawnSync([binary, '--version'], { stdout: 'pipe' }).stdout.toString()).toContain('0.22.10')
      },
    } as any,
    targets: async () => [{ sandboxId: 'squad-box', options: { workspacePath: root } }],
    reconcileToolchain: ensureSandboxToolchain,
  })
  const worker = new IntegrationProjectionWorker({
    repository: projectionStates,
    reconcile: (claim) => reconciler.reconcile(claim),
  })
  // Captured, not discarded: `ntn` exits 101 on a Rust panic, and the bare
  // status alone made that indistinguishable from an ordinary rejection.
  const runCli = () =>
    runCapturedProcess(['sh', '-c', 'set -a; . "$ENV_FILE"; set +a; exec "$NTN" api v1/search --data "{}"'], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ENV_FILE: envFile,
        NTN: binary,
        NOTION_API_BASE_URL: origin,
        NOTION_API_DOCS_BASE_URL: origin,
        NOTION_API_VERSION: '2026-03-11',
        NOTION_HOME: join(root, 'home'),
        CI: '1',
        NO_PROXY: '127.0.0.1,localhost',
        NODE_OPTIONS: `--require ${egressGuard}`,
        FICUS_EGRESS_LOG: egressLog,
        // So a panic carries a frame instead of only exit 101.
        RUST_BACKTRACE: '1',
      },
    })
  const [squad] = await db
    .insert(squads)
    .values({ name: `Notion E2E ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const [earlierSquad] = await db
    .insert(squads)
    .values({ name: `Earlier projection ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  await projectionStates.invalidate({
    squadId: earlierSquad.id,
    providerKey: 'notion',
    now: new Date(0),
  })
  let createdConnectionId: string | null = null
  let createdCredentialRef: string | null = null
  const drainUntilOwnProjectionReady = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await projectionStates.get(squad.id, 'notion')
      if (state?.status === 'ready') return state
      if (!(await worker.runOnce())) break
    }
    throw new Error('test projection did not become ready within the bounded drain')
  }
  const userId = crypto.randomUUID()
  try {
    await db.insert(users).values({ id: userId, email: `notion-e2e-${userId}@example.test` })
    const second = await authorization.start({
      providerKey: 'notion',
      userId,
      returnTo: '/settings',
      intent: { kind: 'connect' },
    })
    await authorization.callback({
      providerKey: 'notion',
      userId,
      state: new URL(second.authorizationUrl).searchParams.get('state')!,
      code: 'code',
    })
    const connection = (await repository.list('notion')).find(
      (candidate) => (candidate.configuration as { workspaceId?: string }).workspaceId === workspaceId
    )
    createdConnectionId = connection!.id
    createdCredentialRef = connection!.credentialRef
    await repository.assign(squad.id, 'notion', connection!.id)
    expect(await drainUntilOwnProjectionReady()).toMatchObject({ status: 'ready' })
    expect(installCount).toBe(1)
    expect(observedEnv).toContain('NOTION_API_TOKEN')
    expect(observedSkills).toEqual(['notion'])
    expectCleanExit(await runCli())

    const refresh = new IntegrationRefreshService({
      connections: repository,
      credentials: secretStore,
      resolvePlugin: () => plugin,
      transport,
      lease: new ConnectionAuthorizationLease(),
      invalidateAssignments: async (id) => {
        const row = await repository.get(id)
        const revision = BigInt(parseOAuthCredential(secretStore.get(row!.credentialRef)!).tokenRevision)
        await projectionStates.invalidate({
          squadId: squad.id,
          providerKey: 'notion',
          credentialRevision: revision,
          now: new Date(),
        })
      },
    })
    expect((await refresh.refresh(connection!.id, 'explicit')).status).toBe('refreshed')
    expect(await drainUntilOwnProjectionReady()).toMatchObject({
      status: 'ready',
      appliedCredentialRevision: 2n,
    })
    expect(installCount).toBe(1)
    expect(readinessCount).toBe(2)
    expectCleanExit(await runCli())

    await repository.unassign(squad.id, 'notion')
    expect(await drainUntilOwnProjectionReady()).toMatchObject({ status: 'ready' })
    expect(observedSkills).toEqual([])
    expect(installedFingerprint).toBeNull()
    expect(installCount).toBe(1)
    expectFailedExit(await runCli())
    expect(accepted).toEqual(['access-one', 'access-two'])
    expect(existsSync(egressLog)).toBe(false)
  } finally {
    server.stop(true)
    await db.delete(integrationProjectionStates).where(eq(integrationProjectionStates.squadId, squad.id))
    await db.delete(integrationProjectionStates).where(eq(integrationProjectionStates.squadId, earlierSquad.id))
    if (createdConnectionId)
      await db.delete(integrationConnections).where(eq(integrationConnections.id, createdConnectionId))
    if (createdCredentialRef) await secretStore.delete(createdCredentialRef)
    await db.delete(users).where(eq(users.id, userId))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(squads).where(eq(squads.id, earlierSquad.id))
    rmSync(root, { recursive: true, force: true })
    if (priorEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey
  }
}, 30_000)
