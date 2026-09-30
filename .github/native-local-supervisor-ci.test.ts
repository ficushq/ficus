import { describe, expect, test } from 'bun:test'
import { DEFAULT_INSTANCE_LABEL } from '../packages/shared/src/local-instance'

interface WorkflowStep {
  name?: string
  run?: string
}

const workflow = Bun.YAML.parse(await Bun.file(new URL('./workflows/ci.yml', import.meta.url)).text()) as {
  jobs: Record<string, { steps: WorkflowStep[] }>
}

const step = (name: string) => workflow.jobs['local-setup'].steps.find((item) => item.name === name)

describe('native local-setup CI authority', () => {
  test('requires the Linux-native supervisor in status and updater evidence', () => {
    const run = step('Health, status, and API-native updater support')?.run ?? ''

    expect(run).toContain("s.supervisor!=='systemd-user'")
    expect(run).toContain("r.flavor.supervisor!=='systemd-user'")
    expect(run).not.toContain("r.flavor.supervisor!=='pm2'")
  })

  test('collects native supervisor diagnostics rather than querying pm2', () => {
    const run = step('Show logs on failure')?.run ?? ''

    // The default local instance's label, and its logs in the CLI home.
    expect(run).toContain(`server logs --instance ${DEFAULT_INSTANCE_LABEL}`)
    expect(run).toContain('systemctl --user status')
    expect(run).toContain('~/.ficus/logs/ficus-api.log')
    expect(run).not.toContain('bunx pm2 logs')
  })
})
