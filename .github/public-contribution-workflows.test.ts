import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'

interface Job {
  permissions?: Record<string, string>
  'runs-on'?: string
  steps?: { run?: string; uses?: string; with?: Record<string, unknown> }[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const directory = new URL('./workflows/', import.meta.url)
const workflows = readdirSync(directory)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({
    file,
    workflow: Bun.YAML.parse(readFileSync(new URL(file, directory), 'utf8')) as Workflow,
  }))
const linuxRunner = 'ubuntu-24.04'

describe('external contribution boundaries', () => {
  for (const { file, workflow } of workflows) {
    if ('pull_request' in workflow.on) {
      test(`${file}: contributor jobs require no stored secrets or write permissions`, () => {
        expect(workflow.permissions).toEqual({ contents: 'read' })
        expect(JSON.stringify(workflow)).not.toMatch(/secrets\s*(?:\.|\[)/)
        expect(workflow.on).not.toHaveProperty('pull_request_target')
        for (const job of Object.values(workflow.jobs)) {
          expect(job.permissions ?? workflow.permissions).toEqual({ contents: 'read' })
          expect(JSON.stringify(job)).not.toContain('softprops/action-gh-release')
          for (const step of job.steps ?? []) {
            if (step.uses?.startsWith('docker/build-push-action@')) expect(step.with?.push).not.toBe(true)
          }
        }
      })
    }
    test(`${file}: public repositories use GitHub-hosted runners`, () => {
      for (const job of Object.values(workflow.jobs)) {
        expect([linuxRunner, 'ubuntu-24.04', 'ubuntu-latest', 'macos-15']).toContain(job['runs-on'])
      }
    })
  }

  test('publishing workflows cannot be triggered by PRs or their completion', () => {
    for (const file of ['cli-binaries.yml', 'publish-images.yml']) {
      const workflow = workflows.find((entry) => entry.file === file)!.workflow
      expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
      expect(workflow.on.push).toEqual({ branches: ['main'], tags: ['v*'] })
    }
  })
})

describe('non-default PR bases', () => {
  const themePrBases = ['main', 'initiative/color-themes', 'ficus/rename']

  for (const file of ['ci.yml', 'lint.yml']) {
    const workflow = workflows.find((entry) => entry.file === file)!.workflow
    test(`${file}: covers main and initiative without temporary stack bases`, () => {
      expect(workflow.on.pull_request).toEqual({ branches: themePrBases })
      // This must not broaden push, publishing, or privileged target events.
      expect(workflow.on.push).toEqual({ branches: ['main'] })
      expect(workflow.on).not.toHaveProperty('pull_request_target')
      expect(workflow.permissions).toEqual({ contents: 'read' })
    })

    test(`${file}: checks the PR merge ref, not a pinned default/base branch`, () => {
      const jobIds = file === 'ci.yml' ? ['test-gates', 'test-typecheck', 'test-core', 'test-web'] : ['lint']
      for (const jobId of jobIds) {
        const checkout = workflow.jobs[jobId]!.steps!.find((step) => step.uses?.startsWith('actions/checkout@'))
        expect(checkout).toBeDefined()
        expect(checkout!.with?.ref).toBeUndefined()
      }
    })
  }

  test('CLA target event already covers every PR base without adding untrusted execution', () => {
    const cla = workflows.find((entry) => entry.file === 'cla.yml')!.workflow
    expect(cla.on.pull_request_target).toEqual({ types: ['opened', 'synchronize', 'reopened'] })
    expect(cla.on).not.toHaveProperty('pull_request')
  })
})
