import { Command } from 'commander'
import { defaultDesktopDeps, desktopStatus, installDesktop, type DesktopDeps } from '../desktop-installer'
import { output, outputError } from '../output'

export function registerDesktopCommands(program: Command, deps: DesktopDeps = defaultDesktopDeps()): void {
  const desktop = program.command('desktop').description('Install or inspect the Ficus Desktop app on macOS')
  const install = async (options: { open: boolean }) => {
    try {
      const result = await installDesktop(deps, options.open)
      output(
        result,
        result.upToDate
          ? `Ficus Desktop ${result.version} is up to date at ${result.path}${result.openError ? `. ${result.openError}` : ''}`
          : `Installed Ficus Desktop ${result.version} at ${result.path}${result.openError ? `. ${result.openError}` : ''}`
      )
    } catch (error) {
      outputError(error as Error)
    }
  }
  desktop.option('--no-open', 'Do not open Desktop after installation').action(install)
  desktop
    .command('install')
    .description('Install the latest signed Desktop release')
    .option('--no-open', 'Do not open Desktop after installation')
    .action(install)
  desktop
    .command('status')
    .description('Show installed and latest Desktop versions')
    .action(async () => {
      try {
        const result = await desktopStatus(deps)
        output(
          result,
          result.installed
            ? `Ficus Desktop ${result.installed} at ${result.path}; latest ${result.latest}`
            : `Ficus Desktop is not installed; latest ${result.latest}`
        )
      } catch (error) {
        outputError(error as Error)
      }
    })
}
