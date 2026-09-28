import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { renderEnvForSecrets } from '../../squad/env'
import { projectIntegrationAssignments } from '../projection/projector'
import { resolveProtectedBindings } from '../projection/protected-env'
import { IntegrationProjectionReconciler } from '../projection/reconciler'
import { NotionClient, type NotionTokenResponse } from '@ficus/shared/oauth-providers/notion/client'
import { parseNotionConfiguration } from '@ficus/shared/oauth-providers/notion/config'
import { classifyNotionError, registerOAuthProviderAdapterForTest } from '@ficus/shared/oauth-providers'
import type { OAuthProviderGrant } from '@ficus/shared/oauth-providers/types'
import { createLocalTransport } from '../authorization/transport'
import { createNotionPlugin } from './plugin'
import { expectCleanExit, expectFailedExit, runCapturedProcess } from '../../../test-utils/captured-process'

const binary = join(dirname(Bun.resolveSync('ntn/package.json', import.meta.dir)), 'bin', 'ntn')

/** Always-run, zero-external-call smoke over the locked real CLI and generated protected env. */
test('pinned Notion CLI uses rotated generated credentials and loses access on unassignment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-notion-cli-'))
  const envFile = join(root, '.env')
  const acceptedTokens: string[] = []
  let tokenExchange = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/v1/oauth/token') {
        tokenExchange += 1
        return Response.json({
          access_token: tokenExchange === 1 ? 'access-one' : 'access-two',
          refresh_token: tokenExchange === 1 ? 'refresh-one' : 'refresh-two',
          workspace_id: 'workspace-id',
          workspace_name: 'Workspace',
          workspace_icon: null,
          bot_id: 'bot-id',
          token_type: 'bearer',
          owner: { type: 'user', user: { object: 'user', id: 'user-id' } },
          duplicated_template_id: null,
        })
      }
      if (url.pathname === '/v1/users/me')
        return Response.json({ object: 'user', id: 'bot-id', type: 'bot', name: null, avatar_url: null, bot: {} })
      if (url.pathname === '/v1/search') {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
        if (token !== 'access-one' && token !== 'access-two') {
          // A rejected token is exit 4 rather than 5, so distinguishing it in
          // the log separates "wrong credential" from "request never landed".
          console.error('[notion-fake] rejecting unknown bearer token')
          return Response.json({ code: 'unauthorized' }, { status: 401 })
        }
        acceptedTokens.push(token)
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
      console.error(`[notion-fake] unhandled ${request.method} ${url.pathname}`)
      return new Response('unexpected', { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const controlledFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    expect(url.origin).toBe('https://api.notion.com')
    return fetch(new Request(`${origin}${url.pathname}${url.search}`, request))
  }
  const notionClient = new NotionClient({ fetch: controlledFetch })
  const restoreAdapter = registerOAuthProviderAdapterForTest({
    key: 'notion',
    authorizeHosts: ['api.notion.com'],
    buildAuthorizationUrl: (input) => notionClient.buildAuthorizationUrl(input),
    exchangeCode: async (input) => grantFromToken(await notionClient.exchangeCode(input)),
    refresh: async (input) => grantFromToken(await notionClient.refresh(input)),
    revoke: (input) => notionClient.revoke(input),
    classifyError: classifyNotionError,
  })
  const transport = createLocalTransport({
    resolveClientCredentials: () => ({ clientId: 'client-id', clientSecret: 'client-secret' }),
    callbackUrl: () => 'https://tau.example/callback',
  })
  const plugin = createNotionPlugin(notionClient)
  if (plugin.authorization.kind !== 'oauth2') throw new Error('oauth unavailable')

  // Captured, not discarded — see core-lifecycle.e2e.test.ts.
  const runCli = () =>
    runCapturedProcess(['sh', '-c', 'set -a; . "$ENV_FILE"; set +a; exec "$NTN_BIN" api v1/search --data "{}"'], {
      cwd: root,
      env: {
        PATH: processEnvPath(),
        ENV_FILE: envFile,
        NTN_BIN: binary,
        NOTION_API_BASE_URL: origin,
        NOTION_API_DOCS_BASE_URL: origin,
        NOTION_API_VERSION: '2026-03-11',
        NOTION_HOME: join(root, 'notion-home'),
        CI: '1',
        NO_PROXY: '127.0.0.1,localhost',
        RUST_BACKTRACE: '1',
      },
    })

  try {
    const version = Bun.spawnSync([binary, '--version'], { stdout: 'pipe', stderr: 'pipe' })
    expect(version.exitCode).toBe(0)
    expect(version.stdout.toString()).toContain('0.22.10')

    const exchanged = await transport.completeAuthorization({
      providerKey: 'notion',
      localFlowId: 'local-flow',
      code: 'code',
      redirectUri: 'https://tau.example/callback',
    })
    const grant = {
      configuration: parseNotionConfiguration(exchanged.configuration),
      credential: { version: 1 as const, ...exchanged.tokens, tokenRevision: 1 },
    }
    const connection = {
      id: 'connection-id',
      providerKey: 'notion',
      adapterVersion: plugin.adapterVersion,
      configuration: grant.configuration,
      credentialRef: 'credential-ref',
      materialRevision: 'material-revision',
    }
    const credentials = new Map([['credential-ref', plugin.connection.credential.serialize(grant.credential)]])
    const project = () =>
      projectIntegrationAssignments([{ plugin, connection }], {
        resolveCredential: async (reference) => credentials.get(reference),
      })
    const assigned = project()
    let currentProjection = assigned
    let installedFingerprint: string | null = null
    let installCount = 0
    const writeEnv = async () => {
      const bindings = await resolveProtectedBindings(currentProjection)
      writeFileSync(
        envFile,
        renderEnvForSecrets('', [], () => undefined, bindings),
        { mode: 0o600 }
      )
      chmodSync(envFile, 0o600)
    }
    const reconciler = new IntegrationProjectionReconciler({
      connections: { get: async () => null, getAssigned: async () => null },
      regenerateEnv: writeEnv,
      manager: { attachExistingSandbox: async () => true } as any,
      targets: async () => [{ sandboxId: 'squad-id', options: { workspacePath: root, squadId: 'squad-id' } }],
      reconcileToolchain: async () => {
        if (installedFingerprint !== currentProjection.fingerprint) {
          installCount += 1
          installedFingerprint = currentProjection.fingerprint
        }
      },
      desiredFingerprint: async () => currentProjection.fingerprint,
    })
    const reconcile = () => reconciler.reconcile({ squadId: 'squad-id', providerKey: 'notion' } as any)
    expect(assigned.publicDeclaration.readiness).toContainEqual({
      id: 'notion-cli',
      command: 'ntn --version',
      expectedSubstring: '0.22.10',
    })
    await reconcile()
    expect(installCount).toBe(1)
    expectCleanExit(await runCli())

    const rotated = await transport.refresh({
      providerKey: 'notion',
      connectionId: connection.id,
      materialRevision: connection.materialRevision,
      tokenRevision: grant.credential.tokenRevision,
      refreshToken: grant.credential.refreshToken!,
    })
    credentials.set(
      'credential-ref',
      plugin.connection.credential.serialize({
        ...grant.credential,
        accessToken: rotated.tokens.accessToken,
        refreshToken: rotated.tokens.refreshToken,
        expiresAt: rotated.tokens.expiresAt,
        tokenRevision: 2,
      })
    )
    const rotatedProjection = project()
    expect(rotatedProjection.fingerprint).toBe(assigned.fingerprint)
    currentProjection = rotatedProjection
    await reconcile()
    expect(installCount).toBe(1)
    expectCleanExit(await runCli())
    expect(acceptedTokens).toEqual(['access-one', 'access-two'])

    const unassigned = projectIntegrationAssignments([])
    expect(unassigned.publicDeclaration.packages).toEqual([])
    currentProjection = unassigned
    await reconcile()
    expectFailedExit(await runCli())
    expect(acceptedTokens).toEqual(['access-one', 'access-two'])
    expect(await Bun.file(envFile).text()).not.toContain('NOTION_API_TOKEN')
  } finally {
    restoreAdapter()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

function grantFromToken(token: NotionTokenResponse): OAuthProviderGrant {
  return {
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
  }
}

function processEnvPath(): string {
  return process.env.PATH ?? '/usr/bin:/bin'
}
