import { spawn } from 'child_process'
import { Command } from 'commander'
import { buildInfo } from '../build-info'
import { output, outputError } from '../output'

const DEFAULT_INSTALLER_URL = 'https://ficus.sh/cli/install.sh'
const DEFAULT_MANIFEST_URL = 'https://ficus.sh/cli/manifest.json'

interface InstallOptions {
  url?: string
  manifestUrl?: string
  /** true for --auth, false for --no-auth (commander folds both into `auth`), else unset. */
  auth?: boolean
  force?: boolean
}

interface CliManifest {
  version: string
  commit: string
  buildDate: string
  baseUrl?: string
}

function shortCommit(commit: string): string {
  return commit.length > 12 ? commit.slice(0, 12) : commit
}

async function fetchManifest(url: string): Promise<CliManifest> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`failed to fetch manifest: ${response.status}`)
  return (await response.json()) as CliManifest
}

function isCurrent(manifest: CliManifest): boolean {
  return manifest.commit === buildInfo.commit || shortCommit(manifest.commit) === buildInfo.commit
}

function runInstaller(url: string, options: InstallOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (options.auth !== undefined) env.FICUS_INSTALL_AUTH = options.auth ? '1' : '0'

    const child = spawn('sh', ['-c', `curl -fsSL "$1" | sh`, 'ficus-install', url], {
      stdio: 'inherit',
      env,
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else if (signal) reject(new Error(`installer exited with signal ${signal}`))
      else reject(new Error(`installer exited with code ${code}`))
    })
  })
}

export function registerInstallCommands(program: Command) {
  program
    .command('install')
    .description('Install or upgrade the Ficus CLI from the public installer')
    .option('--url <url>', 'Installer URL', DEFAULT_INSTALLER_URL)
    .option('--manifest-url <url>', 'CLI manifest URL', DEFAULT_MANIFEST_URL)
    .option('--auth', 'Force installer authentication prompts or env-based auth')
    .option('--no-auth', 'Skip installer authentication setup')
    .option('--force', 'Run installer even when current CLI matches the latest manifest')
    .action(async (options: InstallOptions) => {
      try {
        const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL
        const installerUrl = options.url ?? DEFAULT_INSTALLER_URL
        const latest = await fetchManifest(manifestUrl)

        output(
          {
            current: buildInfo,
            latest,
          },
          `Current Ficus CLI: ${buildInfo.version} (${shortCommit(buildInfo.commit)}, ${buildInfo.buildDate})\n` +
            `Latest Ficus CLI:  ${latest.version} (${shortCommit(latest.commit)}, ${latest.buildDate})`
        )

        if (!options.force && isCurrent(latest)) {
          output({ current: buildInfo, latest }, 'Ficus CLI is already up to date. Use --force to reinstall.')
          return
        }

        await runInstaller(installerUrl, options)
        output({ installer: installerUrl, latest }, 'Ficus CLI install completed.')
      } catch (error) {
        outputError(error as Error)
      }
    })
}
