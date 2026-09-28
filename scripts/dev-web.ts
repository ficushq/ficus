import { getAuthStorePath } from '../apps/cli/src/auth-store'
import { randomBytes } from 'node:crypto'

const configuredAccessToken = process.env.FICUS_DEV_ACCESS_TOKEN?.trim()
if (configuredAccessToken && configuredAccessToken.length < 16) {
  throw new Error('FICUS_DEV_ACCESS_TOKEN must be at least 16 characters')
}
const accessToken = configuredAccessToken ?? randomBytes(24).toString('base64url')

if (configuredAccessToken) {
  console.log('Tau dev access-token gate enabled from FICUS_DEV_ACCESS_TOKEN.')
} else {
  console.log(`Tau dev access token: ${accessToken}`)
  console.log('Enter this token in the browser login prompt. It changes on every restart.')
}

const child = Bun.spawn(['bun', 'run', '--filter', 'web', 'dev', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    // Vite receives an absolute path, so its Node-based config loader does not
    // need to import Bun/TypeScript modules from the CLI or duplicate home-dir logic.
    FICUS_DEV_AUTH_STORE_PATH: getAuthStorePath(),
    FICUS_DEV_ACCESS_TOKEN: accessToken,
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

let interrupted = false
const stopChild = () => {
  interrupted = true
  child.kill()
}
process.once('SIGINT', stopChild)
process.once('SIGTERM', stopChild)

const exitCode = await child.exited
process.off('SIGINT', stopChild)
process.off('SIGTERM', stopChild)
process.exit(interrupted ? 0 : exitCode)
