import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile, mkdtemp, rm, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  appendArtifactRequest,
  createArtifactInAgentWorkspace,
  readArtifactManifest,
  readArtifactPublishes,
  readArtifactRequests,
} from './artifactWorkspace'
import { MAX_ARTIFACT_HTML_BYTES, MAX_ARTIFACT_MARKDOWN_BYTES, publishArtifact } from './artifactPublish'

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('artifact publish service', () => {
  let agentWorkspacePath: string

  beforeEach(async () => {
    agentWorkspacePath = await mkdtemp(join(tmpdir(), 'ficus-artifact-publish-'))
  })

  afterEach(async () => {
    await rm(agentWorkspacePath, { recursive: true, force: true })
  })

  it('validates presentation.json and updates manifest entry, status, title, and summary', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Draft Deck',
      brief: 'Create a deck',
    })
    const presentationPath = join(created.artifactPath, 'presentation.json')
    await writeFile(
      presentationPath,
      JSON.stringify({
        schemaVersion: 1,
        title: 'Launch Review',
        sections: [
          {
            id: 'overview',
            title: 'Overview',
            blocks: [{ type: 'markdown', content: 'Ready to launch.' }],
          },
        ],
      })
    )

    const result = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'presentation', path: 'presentation.json' },
      title: 'Launch Review',
      summary: 'A polished launch review deck.',
      status: 'ready',
      changeSummary: 'Published the initial polished launch review deck.',
      changeDetails: 'Added an overview section with launch-ready copy.',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.errors.join('\n'))
    expect(result.manifest).toMatchObject({
      id: created.artifactId,
      title: 'Launch Review',
      status: 'ready',
      summary: 'A polished launch review deck.',
      entry: { type: 'presentation', path: 'presentation.json' },
    })
    expect(result.manifest).not.toHaveProperty('publishes')
    expect(result.manifest).not.toHaveProperty('requests')
    expect(result.manifest).not.toHaveProperty('questions')
    expect(result.manifest.updatedAt).toBeString()

    const rawManifest = await readJson(join(created.artifactPath, 'manifest.json'))
    expect(rawManifest).toEqual(result.manifest)
    expect(rawManifest).not.toHaveProperty('publishes')

    await expect(readArtifactPublishes({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual([
      expect.objectContaining({
        entry: { type: 'presentation', path: 'presentation.json' },
        status: 'ready',
        changeSummary: 'Published the initial polished launch review deck.',
        changeDetails: 'Added an overview section with launch-ready copy.',
        title: 'Launch Review',
        summary: 'A polished launch review deck.',
      }),
    ])
  })

  it('returns validation errors for invalid presentation and does not update manifest entry', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Invalid Deck',
      brief: 'Create a deck',
    })
    await writeFile(join(created.artifactPath, 'presentation.json'), JSON.stringify({ schemaVersion: 1, sections: [] }))

    const result = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'presentation', path: 'presentation.json' },
      title: 'Should Not Publish',
      summary: 'Invalid presentation attempt.',
      status: 'ready',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected validation failure')
    expect(result.errors.join('\n')).toContain('presentation')
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      created.manifest
    )
  })

  it('validates markdown file existence and size before updating manifest', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Markdown Report',
      brief: 'Create a report',
    })

    const missing = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'markdown', path: 'report.md' },
      status: 'ready',
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('expected missing file failure')
    expect(missing.errors.join('\n')).toContain('not found')

    await writeFile(join(created.artifactPath, 'report.md'), 'x'.repeat(MAX_ARTIFACT_MARKDOWN_BYTES + 1))
    const tooLarge = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'markdown', path: 'report.md' },
      status: 'ready',
    })
    expect(tooLarge.ok).toBe(false)
    if (tooLarge.ok) throw new Error('expected size failure')
    expect(tooLarge.errors.join('\n')).toContain('exceeds')

    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      created.manifest
    )

    await writeFile(join(created.artifactPath, 'report.md'), '# Report\n\nReady.')
    const published = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'markdown', path: 'report.md' },
      title: 'Published Markdown Report',
      summary: 'Markdown is ready.',
      status: 'ready',
    })

    expect(published.ok).toBe(true)
    if (!published.ok) throw new Error(published.errors.join('\n'))
    expect(published.manifest).toMatchObject({
      title: 'Published Markdown Report',
      summary: 'Markdown is ready.',
      status: 'ready',
      entry: { type: 'markdown', path: 'report.md' },
    })
  })

  it('validates html file existence and size before updating manifest', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'HTML Report',
      brief: 'Create an HTML report',
    })

    const missing = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'html', path: 'report.html' },
      status: 'ready',
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('expected missing file failure')
    expect(missing.errors.join('\n')).toContain('not found')

    await writeFile(join(created.artifactPath, 'report.html'), 'x'.repeat(MAX_ARTIFACT_HTML_BYTES + 1))
    const tooLarge = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'html', path: 'report.html' },
      status: 'ready',
    })
    expect(tooLarge.ok).toBe(false)
    if (tooLarge.ok) throw new Error('expected size failure')
    expect(tooLarge.errors.join('\n')).toContain('exceeds')

    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      created.manifest
    )

    await writeFile(join(created.artifactPath, 'report.html'), '<!doctype html><h1>Ready</h1>')
    const published = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'html', path: 'report.html' },
      title: 'Published HTML Report',
      summary: 'HTML is ready.',
      status: 'ready',
    })

    expect(published.ok).toBe(true)
    if (!published.ok) throw new Error(published.errors.join('\n'))
    expect(published.manifest).toMatchObject({
      title: 'Published HTML Report',
      summary: 'HTML is ready.',
      status: 'ready',
      entry: { type: 'html', path: 'report.html' },
    })
  })

  it('preserves requests appended concurrently with publish', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Concurrent Publish',
      brief: 'Create artifact for concurrent publish',
    })
    await writeFile(join(created.artifactPath, 'report.md'), '# Report\n\nReady.')

    const [published] = await Promise.all([
      publishArtifact({
        agentWorkspacePath,
        artifactId: created.artifactId,
        entry: { type: 'markdown', path: 'report.md' },
        title: 'Published Concurrent Report',
        summary: 'Concurrent publish is ready.',
        status: 'ready',
      }),
      appendArtifactRequest({
        agentWorkspacePath,
        artifactId: created.artifactId,
        action: 'continue',
        brief: 'Concurrent append during publish',
      }),
    ])

    expect(published.ok).toBe(true)
    if (!published.ok) throw new Error(published.errors.join('\n'))

    const manifest = await readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })
    expect(manifest).toMatchObject({
      title: 'Published Concurrent Report',
      status: 'ready',
      summary: 'Concurrent publish is ready.',
      entry: { type: 'markdown', path: 'report.md' },
    })
    expect(manifest).not.toHaveProperty('publishes')
    expect(manifest).not.toHaveProperty('requests')

    const requests = await readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })
    expect(requests.map((request) => request.brief).sort()).toEqual([
      'Concurrent append during publish',
      'Create artifact for concurrent publish',
    ])
    await expect(readArtifactPublishes({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual([
      expect.objectContaining({
        entry: { type: 'markdown', path: 'report.md' },
        status: 'ready',
        title: 'Published Concurrent Report',
        summary: 'Concurrent publish is ready.',
      }),
    ])
  })

  it('rejects symlinked presentation, markdown, and html entries without mutating the manifest', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Symlinked Artifact',
      brief: 'Create an artifact',
    })
    await writeFile(
      join(created.artifactPath, 'target-presentation.json'),
      JSON.stringify({
        schemaVersion: 1,
        sections: [{ id: 'overview', title: 'Overview', blocks: [{ type: 'markdown', content: 'Ready.' }] }],
      })
    )
    await writeFile(join(created.artifactPath, 'target-report.md'), '# Inside\n\nDo not publish through a symlink.')
    await writeFile(join(created.artifactPath, 'target-report.html'), '<!doctype html><h1>Inside</h1>')

    for (const [type, path, target] of [
      ['presentation', 'presentation.json', 'target-presentation.json'],
      ['markdown', 'report.md', 'target-report.md'],
      ['html', 'report.html', 'target-report.html'],
    ] as const) {
      await symlink(target, join(created.artifactPath, path))

      const result = await publishArtifact({
        agentWorkspacePath,
        artifactId: created.artifactId,
        entry: { type, path },
        title: 'Should Not Publish',
        status: 'ready',
      })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error(`expected ${type} symlink rejection`)
      expect(result.errors.join('\n')).toContain(`Invalid ${type} artifact`)
      await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
        created.manifest
      )
    }
  })

  it('rejects sandbox_app publishes as not implemented', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Sandbox App',
      brief: 'Create an app',
    })
    await mkdir(join(created.artifactPath, 'app'))
    await writeFile(join(created.artifactPath, 'app/index.html'), '<h1>App</h1>')

    const result = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'sandbox_app', path: 'app/index.html' },
      status: 'ready',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected sandbox rejection')
    expect(result.errors.join('\n')).toContain('not implemented')
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      created.manifest
    )
  })

  it('rejects path traversal without mutating the manifest', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Path Traversal',
      brief: 'Create an artifact',
    })

    const result = await publishArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      entry: { type: 'markdown', path: '../secret.md' },
      title: 'Should Not Publish',
      status: 'ready',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected path traversal rejection')
    expect(result.errors.join('\n')).toContain('Invalid artifact path')
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      created.manifest
    )
  })
})
