import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dir, '..')
const integration = resolve(root, 'apps/core/src/services/integrations')

function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function alias(file: ts.SourceFile, name: string): string {
  const declaration = file.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === name)
  expect(declaration, `Missing actual type alias ${name}`).toBeDefined()
  return declaration!.getText(file)
}

// One bounded semantic program includes the shipped Bun/standard-library declarations, not Core's full project.
test('concrete execution plugins fit OAuth-only boundaries without widening resolver inputs', () => {
  const authorityPath = resolve(integration, 'authorization/authority.ts')
  const authority = source(authorityPath)
  const refresh = source(resolve(integration, 'authorization/refresh-service.ts'))
  const dependencies = refresh.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'IntegrationRefreshDependencies'
  )
  const resolvePlugin = dependencies?.members.find(
    (node) => ts.isMethodSignature(node) && node.name.getText(refresh) === 'resolvePlugin'
  )
  expect(resolvePlugin, 'Compile the actual refresh resolver boundary').toBeDefined()

  const fixture = resolve(root, '.github/integration-execution-types.fixture.ts')
  const text = `
    import type { IntegrationPluginV1, IntegrationExecutionDeclaration } from ${JSON.stringify(resolve(integration, 'plugin'))}
    import { oauthPluginView } from ${JSON.stringify(resolve(integration, 'oauth-plugin-view'))}
    import type { OAuthCredentialBundleV1 } from ${JSON.stringify(resolve(integration, 'authorization/credential-bundle'))}
    ${alias(refresh, 'OAuthPlugin')}
    interface RefreshBoundary { ${resolvePlugin!.getText(refresh)} }

    type Config = { workspaceId: string }
    type SlackConfig = { version: 1; teamId?: string; botUserId?: string; teamName?: string; appId?: string }
    type SlackCredential = { botToken: string; signingSecret: string }
    declare const oauth: IntegrationPluginV1<Config, OAuthCredentialBundleV1>
    declare const manual: IntegrationPluginV1<Config, { token: string }>
    declare const channel: IntegrationPluginV1<SlackConfig, SlackCredential>
    const trueView = oauthPluginView(oauth, 'local')!
    const managedView = oauthPluginView(manual, 'platform_broker')!
    oauthPluginView(channel, 'platform_broker')
    const configuration: Config = managedView.connection.parseConfiguration({})
    const credential: OAuthCredentialBundleV1 = managedView.connection.credential.parse('synthetic')
    managedView.authorization.validate({ configuration, credential })
    // A manual resolver cannot be advertised as accepting the swapped OAuth codec's bundle.
    // @ts-expect-error OAuth-only views do not expose execution callbacks
    managedView.execution
    const refreshBoundary: RefreshBoundary = { resolvePlugin: () => oauth }
    const refreshFromView: RefreshBoundary = { resolvePlugin: () => trueView }
    void refreshBoundary; void refreshFromView

    const execution: IntegrationExecutionDeclaration<Config, OAuthCredentialBundleV1> = {
      binaries: ['fake'],
      environment: { TOKEN: ({ configuration, credential }) => {
        const workspace: string = configuration.workspaceId
        const access: string = credential.accessToken
        // @ts-expect-error concrete OAuth credentials do not become manual credentials
        credential.botToken
        // @ts-expect-error contextual configuration typing stays precise
        const invalid: number = configuration.workspaceId
        return workspace + access
      } }
    }
    // @ts-expect-error callbacks cannot safely accept arbitrary unknown configuration/credentials
    const widened: IntegrationExecutionDeclaration<unknown, unknown> = execution
    void widened
  `
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['bun'],
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (file === fixture) return ts.createSourceFile(file, text, languageVersion, true)
    // The real authority union is needed, not its SecretStore/DB value bootstrap.
    // All plugin/view/credential source and the extracted refresh boundary stay real.
    if (file === authorityPath)
      return ts.createSourceFile(file, alias(authority, 'OAuthAuthority'), languageVersion, true)
    return getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
  }
  const program = ts.createProgram([fixture], options, host)
  const coreFiles = program.getSourceFiles().filter((file) => file.fileName.startsWith(resolve(root, 'apps/core')))
  expect(coreFiles.length, 'Never turn this focused guard into a full Core typecheck').toBeLessThanOrEqual(6)
  expect(coreFiles.some((file) => file.fileName.endsWith('/oauth-plugin-view.ts'))).toBe(true)
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  expect(
    errors.map((diagnostic) => `${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
  ).toEqual([])
}, 15000)
