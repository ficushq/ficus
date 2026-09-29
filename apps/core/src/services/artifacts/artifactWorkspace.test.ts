import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  appendArtifactQuestionResponses,
  appendArtifactQuestions,
  appendArtifactRequest,
  appendArtifactRequests,
  archiveArtifact,
  createArtifactInAgentWorkspace,
  deleteArtifact,
  failNextArtifactManifestWritesForTests,
  listArtifactManifests,
  readArtifactHistory,
  readArtifactManifest,
  readArtifactPublishes,
  readArtifactQuestions,
  readArtifactRequests,
  resolveArtifactPath,
  updateArtifactManifestWithPublish,
} from './artifactWorkspace'

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('artifact workspace service', () => {
  let agentWorkspacePath: string
  const consoleSpies: Array<{ mockRestore: () => void }> = []

  beforeEach(async () => {
    agentWorkspacePath = await mkdtemp(join(tmpdir(), 'ficus-artifact-workspace-'))
  })

  afterEach(async () => {
    for (const spy of consoleSpies.splice(0)) {
      spy.mockRestore()
    }
    await rm(agentWorkspacePath, { recursive: true, force: true })
  })

  it('generates stable slugs with collision suffixes', async () => {
    const first = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Quarterly Roadmap!',
      brief: 'Create the first roadmap',
    })
    const second = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Quarterly Roadmap',
      brief: 'Create another roadmap',
    })

    expect(first.artifactId).toBe('quarterly-roadmap')
    expect(second.artifactId).toBe('quarterly-roadmap-2')
  })

  it('creates the artifact folder and backend-owned compact manifest with request sidecar', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Launch Brief',
      brief: 'Build a launch brief deck',
      references: [{ type: 'url', url: 'https://example.com/spec', note: 'source spec' }],
      displayModeHint: 'presentation',
    })

    expect(existsSync(created.artifactPath)).toBe(true)
    expect(created.manifest).toMatchObject({
      id: 'launch-brief',
      title: 'Launch Brief',
      status: 'working',
      archived: false,
    })
    expect('requests' in created.manifest).toBe(false)
    expect('questions' in created.manifest).toBe(false)
    expect('publishes' in created.manifest).toBe(false)
    expect(created.manifest.createdAt).toEqual(created.manifest.updatedAt)

    const manifestOnDisk = await readJson(join(created.artifactPath, 'manifest.json'))
    expect(manifestOnDisk).toEqual(created.manifest)
    expect('requests' in (manifestOnDisk as Record<string, unknown>)).toBe(false)
    expect('questions' in (manifestOnDisk as Record<string, unknown>)).toBe(false)
    expect('publishes' in (manifestOnDisk as Record<string, unknown>)).toBe(false)
    await expect(readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      {
        from: 'voice',
        action: 'create',
        brief: 'Build a launch brief deck',
        references: [{ type: 'url', url: 'https://example.com/spec', note: 'source spec' }],
      },
    ])
    expect(existsSync(join(created.artifactPath, '.manifest.backend.json'))).toBe(false)
  })

  it('rolls back publish sidecar append when compact manifest write fails', async () => {
    const { artifactId } = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Rollback Publish',
      brief: 'Create an artifact',
    })

    await expect(
      updateArtifactManifestWithPublish({
        agentWorkspacePath,
        artifactId,
        publish: {
          at: new Date().toISOString(),
          entry: { type: 'markdown', path: 'report.md' },
          status: 'ready',
          changeSummary: 'This publish should roll back.',
        },
        mutate: (manifest) => Promise.resolve({ ...manifest, title: '' }),
      })
    ).rejects.toThrow()

    await expect(readArtifactPublishes({ agentWorkspacePath, artifactId })).resolves.toEqual([])
  })

  it('reads valid manifests', async () => {
    const { artifactId, manifest } = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Research Summary',
      brief: 'Summarize the research',
    })

    await expect(readArtifactManifest({ agentWorkspacePath, artifactId })).resolves.toEqual(manifest)
  })

  it('ignores malformed manifests and logs a warning when listing', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    consoleSpies.push(warning)
    const valid = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Valid Artifact',
      brief: 'Create a valid artifact',
    })
    const malformedPath = join(agentWorkspacePath, 'artifacts', 'broken-artifact')
    await mkdir(malformedPath, { recursive: true })
    await writeFile(join(malformedPath, 'manifest.json'), '{not json')

    const manifests = await listArtifactManifests({ agentWorkspacePath })

    expect(manifests.map((manifest) => manifest.id)).toEqual([valid.artifactId])
    expect(warning).toHaveBeenCalled()
  })

  it('drops invalid sidecar lines with a warning when reading request history', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    consoleSpies.push(warning)
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Invalid Sidecar Line',
      brief: 'Create artifact',
    })
    await writeFile(
      join(created.artifactPath, 'manifest.requests.jsonl'),
      [
        JSON.stringify({ at: new Date().toISOString(), from: 'voice', action: 'create', brief: 'Valid request' }),
        '{not-json',
        JSON.stringify({ at: '', from: 'voice', action: 'continue', brief: '' }),
        '',
      ].join('\n')
    )

    await expect(readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { brief: 'Valid request' },
    ])
    expect(warning).toHaveBeenCalled()
  })

  it('appends artifact requests to the request sidecar and keeps manifest compact', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Append Request Sidecar',
      brief: 'Create artifact',
    })

    const updated = await appendArtifactRequest({
      agentWorkspacePath,
      artifactId: created.artifactId,
      action: 'continue',
      brief: 'Continue artifact',
    })

    expect('requests' in updated).toBe(false)
    await expect(readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { action: 'create', brief: 'Create artifact' },
      { action: 'continue', brief: 'Continue artifact' },
    ])
    await expect(readArtifactHistory({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject({
      requests: [{ action: 'create' }, { action: 'continue' }],
      questions: [],
      publishes: [],
    })
  })

  it('rolls back request sidecar append when compact manifest write fails', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Request Manifest Failure',
      brief: 'Create artifact',
    })
    const requestsPath = join(created.artifactPath, 'manifest.requests.jsonl')
    const originalRequests = await readFile(requestsPath, 'utf8')

    failNextArtifactManifestWritesForTests()
    await expect(
      appendArtifactRequest({
        agentWorkspacePath,
        artifactId: created.artifactId,
        action: 'continue',
        brief: 'This request should roll back',
      })
    ).rejects.toThrow('Injected artifact manifest write failure')

    await expect(readFile(requestsPath, 'utf8')).resolves.toBe(originalRequests)
    await expect(readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { action: 'create', brief: 'Create artifact' },
    ])
  })

  it('does not advance manifest when appending request sidecar fails', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Request Sidecar Failure',
      brief: 'Create artifact',
    })
    const originalManifest = await readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })
    const requestsPath = join(created.artifactPath, 'manifest.requests.jsonl')
    await rm(requestsPath)
    await mkdir(requestsPath)

    await expect(
      appendArtifactRequest({
        agentWorkspacePath,
        artifactId: created.artifactId,
        action: 'continue',
        brief: 'This sidecar write should fail',
      })
    ).rejects.toThrow()

    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      originalManifest
    )
  })

  it('archives artifacts and appends an archive request', async () => {
    const { artifactId } = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Archive Me',
      brief: 'Create an artifact to archive',
    })

    const archived = await archiveArtifact({
      agentWorkspacePath,
      artifactId,
      brief: 'No longer needed',
    })

    expect(archived.archived).toBe(true)
    expect('requests' in archived).toBe(false)
    await expect(readArtifactRequests({ agentWorkspacePath, artifactId })).resolves.toMatchObject([
      { action: 'create' },
      {
        from: 'voice',
        action: 'archive',
        brief: 'No longer needed',
      },
    ])
    const manifestOnDisk = await readJson(join(agentWorkspacePath, 'artifacts', artifactId, 'manifest.json'))
    expect('requests' in (manifestOnDisk as Record<string, unknown>)).toBe(false)
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId })).resolves.toEqual(archived)
    await expect(listArtifactManifests({ agentWorkspacePath })).resolves.toEqual([])
    await expect(listArtifactManifests({ agentWorkspacePath, includeArchived: true })).resolves.toEqual([archived])
  })

  it('rolls back question sidecar write when compact manifest write fails', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Question Manifest Failure',
      brief: 'Create artifact',
    })
    await appendArtifactQuestions({
      agentWorkspacePath,
      artifactId: created.artifactId,
      questions: [{ question: 'Existing?', responseMode: 'free_text' }],
    })
    const questionsPath = join(created.artifactPath, 'manifest.questions.jsonl')
    const originalQuestions = await readFile(questionsPath, 'utf8')

    failNextArtifactManifestWritesForTests()
    await expect(
      appendArtifactQuestions({
        agentWorkspacePath,
        artifactId: created.artifactId,
        questions: [{ question: 'New?', responseMode: 'free_text' }],
      })
    ).rejects.toThrow('Injected artifact manifest write failure')

    await expect(readFile(questionsPath, 'utf8')).resolves.toBe(originalQuestions)
    await expect(readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { id: 'q_1', question: 'Existing?' },
    ])
  })

  it('appends artifact questions with stable ids and preserves existing requests', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Dashboard',
      brief: 'Build it',
    })

    const withQuestions = await appendArtifactQuestions({
      agentWorkspacePath,
      artifactId: created.artifactId,
      questions: [
        { question: 'Theme?', responseMode: 'single_select', choices: ['Light', 'Dark'] },
        { question: 'Metrics?', responseMode: 'free_text' },
      ],
    })

    const questions = await readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })
    expect('questions' in withQuestions.manifest).toBe(false)
    expect(withQuestions.questions.map((question) => question.id)).toEqual(['q_1', 'q_2'])
    expect(questions.map((question) => question.id)).toEqual(['q_1', 'q_2'])
    expect(questions).toMatchObject([
      {
        id: 'q_1',
        question: 'Theme?',
        responseMode: 'single_select',
        choices: ['Light', 'Dark'],
        status: 'open',
      },
      {
        id: 'q_2',
        question: 'Metrics?',
        responseMode: 'free_text',
        status: 'open',
      },
    ])
    expect(questions.every((question) => typeof question.at === 'string' && question.at.length > 0)).toBe(true)
    await expect(readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toHaveLength(1)
    expect(withQuestions.manifest.updatedAt).toEqual(questions[0]?.at ?? '')
    expect(await readJson(join(created.artifactPath, 'manifest.json'))).toEqual(withQuestions.manifest)
  })

  it('returns deterministically added artifact questions from concurrent appends', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Concurrent Questions',
      brief: 'Build it',
    })

    const [first, second] = await Promise.all([
      appendArtifactQuestions({
        agentWorkspacePath,
        artifactId: created.artifactId,
        questions: [
          { question: 'First?', responseMode: 'free_text' },
          { question: 'Second?', responseMode: 'free_text' },
        ],
      }),
      appendArtifactQuestions({
        agentWorkspacePath,
        artifactId: created.artifactId,
        questions: [{ question: 'Third?', responseMode: 'free_text' }],
      }),
    ])

    const returnedQuestionIds = [
      first.questions.map((question) => question.id),
      second.questions.map((question) => question.id),
    ].sort((left, right) => left[0]!.localeCompare(right[0]!))
    expect(returnedQuestionIds).toEqual([['q_1', 'q_2'], ['q_3']])
    await expect(readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { id: 'q_1' },
      { id: 'q_2' },
      { id: 'q_3' },
    ])
  })

  it('generates artifact question ids from the highest existing q-number', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Tampered Question IDs',
      brief: 'Build it',
    })
    await writeFile(
      join(created.artifactPath, 'manifest.questions.jsonl'),
      `${JSON.stringify({
        id: 'q_2',
        at: new Date().toISOString(),
        question: 'Existing tampered question?',
        responseMode: 'free_text',
        status: 'open',
      })}\n`
    )

    await appendArtifactQuestions({
      agentWorkspacePath,
      artifactId: created.artifactId,
      questions: [{ question: 'Next question?', responseMode: 'free_text' }],
    })

    await expect(readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { id: 'q_2' },
      { id: 'q_3' },
    ])
  })

  it('rejects answering artifact questions when the manifest has duplicate question ids', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Duplicate Question IDs',
      brief: 'Build it',
    })
    const question = {
      id: 'q_1',
      at: new Date().toISOString(),
      question: 'Theme?',
      responseMode: 'free_text',
      status: 'open',
    }
    await writeFile(
      join(created.artifactPath, 'manifest.questions.jsonl'),
      `${JSON.stringify(question)}\n${JSON.stringify({ ...question, question: 'Metrics?' })}\n`
    )
    const before = await readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })

    await expect(
      appendArtifactQuestionResponses({
        agentWorkspacePath,
        artifactId: created.artifactId,
        brief: 'Answer duplicate id',
        answers: [{ questionId: 'q_1', answer: 'Dark' }],
      })
    ).rejects.toThrow('Duplicate artifact question id in manifest')
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(before)
  })

  it('does not advance manifest when writing question sidecar fails', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Question Sidecar Failure',
      brief: 'Create artifact',
    })
    const originalManifest = await readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })
    await mkdir(join(created.artifactPath, 'manifest.questions.jsonl'))

    await expect(
      appendArtifactQuestions({
        agentWorkspacePath,
        artifactId: created.artifactId,
        questions: [{ question: 'Will this fail?', responseMode: 'free_text' }],
      })
    ).rejects.toThrow()

    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      originalManifest
    )
  })

  it('rejects appending artifact questions to archived artifacts', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Archived Questions',
      brief: 'Create an artifact to archive',
    })
    const archived = await archiveArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      brief: 'Archive before asking questions',
    })

    await expect(
      appendArtifactQuestions({
        agentWorkspacePath,
        artifactId: created.artifactId,
        questions: [{ question: 'Theme?', responseMode: 'free_text' }],
      })
    ).rejects.toThrow('Artifact is archived')
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      archived
    )
  })

  it('records separate artifact question answers and appends one continue request', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Answered Questions',
      brief: 'Build it',
    })
    await appendArtifactQuestions({
      agentWorkspacePath,
      artifactId: created.artifactId,
      questions: [
        { question: 'Theme?', responseMode: 'single_select', choices: ['Light', 'Dark'] },
        { question: 'Metrics?', responseMode: 'free_text' },
      ],
    })

    const answered = await appendArtifactQuestionResponses({
      agentWorkspacePath,
      artifactId: created.artifactId,
      brief: 'Continue with answers',
      references: [{ type: 'url', url: 'https://example.com/answer', note: 'answer source' }],
      answers: [
        { questionId: 'q_1', answer: 'Dark' },
        { questionId: 'q_2', answer: 'Revenue and retention' },
      ],
    })

    const answeredQuestions = await readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })
    expect('questions' in answered).toBe(false)
    expect(answeredQuestions).toMatchObject([
      {
        id: 'q_1',
        status: 'answered',
        response: { from: 'voice', answer: 'Dark', brief: 'Continue with answers' },
      },
      {
        id: 'q_2',
        status: 'answered',
        response: { from: 'voice', answer: 'Revenue and retention', brief: 'Continue with answers' },
      },
    ])
    expect(answeredQuestions[0]?.response?.at).toEqual(answered.updatedAt)
    expect(answeredQuestions[1]?.response?.at).toEqual(answered.updatedAt)
    const answeredRequests = await readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })
    expect(answeredRequests).toHaveLength(2)
    expect(answeredRequests.at(-1)).toMatchObject({
      from: 'voice',
      action: 'continue',
      brief: 'Continue with answers',
      references: [{ type: 'url', url: 'https://example.com/answer', note: 'answer source' }],
    })
  })

  it('overwrites an already answered artifact question', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Overwrite Answer',
      brief: 'Build it',
    })
    await appendArtifactQuestions({
      agentWorkspacePath,
      artifactId: created.artifactId,
      questions: [{ question: 'Theme?', responseMode: 'single_select', choices: ['Light', 'Dark'] }],
    })
    await appendArtifactQuestionResponses({
      agentWorkspacePath,
      artifactId: created.artifactId,
      brief: 'Use first answer',
      answers: [{ questionId: 'q_1', answer: 'Light' }],
    })

    await appendArtifactQuestionResponses({
      agentWorkspacePath,
      artifactId: created.artifactId,
      brief: 'Use corrected answer',
      answers: [{ questionId: 'q_1', answer: 'Dark' }],
    })

    const overwrittenQuestions = await readArtifactQuestions({ agentWorkspacePath, artifactId: created.artifactId })
    expect(overwrittenQuestions[0]).toMatchObject({
      id: 'q_1',
      status: 'answered',
      response: { from: 'voice', answer: 'Dark', brief: 'Use corrected answer' },
    })
    const overwrittenRequests = await readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })
    expect(overwrittenRequests.map((request) => request.brief)).toEqual([
      'Build it',
      'Use first answer',
      'Use corrected answer',
    ])
  })

  it('rejects artifact question responses atomically when any question id is missing or duplicate', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Atomic Answers',
      brief: 'Build it',
    })
    const withQuestions = await appendArtifactQuestions({
      agentWorkspacePath,
      artifactId: created.artifactId,
      questions: [
        { question: 'Theme?', responseMode: 'free_text' },
        { question: 'Metrics?', responseMode: 'free_text' },
      ],
    })

    await expect(
      appendArtifactQuestionResponses({
        agentWorkspacePath,
        artifactId: created.artifactId,
        brief: 'Answer with missing id',
        answers: [
          { questionId: 'q_1', answer: 'Dark' },
          { questionId: 'q_missing', answer: 'Revenue' },
        ],
      })
    ).rejects.toThrow('Artifact question not found')
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      withQuestions.manifest
    )

    await expect(
      appendArtifactQuestionResponses({
        agentWorkspacePath,
        artifactId: created.artifactId,
        brief: 'Answer with duplicate id',
        answers: [
          { questionId: 'q_1', answer: 'Light' },
          { questionId: 'q_1', answer: 'Dark' },
        ],
      })
    ).rejects.toThrow('Duplicate artifact question response')
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      withQuestions.manifest
    )
  })

  it('rejects archive and delete actions through appendArtifactRequest', async () => {
    const { artifactId, manifest } = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Append Action Guard',
      brief: 'Create an artifact for append action guards',
    })

    for (const action of ['archive', 'delete'] as const) {
      await expect(
        appendArtifactRequest({
          agentWorkspacePath,
          artifactId,
          action: action as never,
          brief: `Invalid ${action} append`,
        })
      ).rejects.toThrow('Invalid append artifact action')
    }

    await expect(readArtifactManifest({ agentWorkspacePath, artifactId })).resolves.toEqual(manifest)
  })

  it('deletes the artifact folder', async () => {
    const { artifactId, artifactPath } = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Delete Me',
      brief: 'Create an artifact to delete',
    })

    await deleteArtifact({ agentWorkspacePath, artifactId })

    expect(existsSync(artifactPath)).toBe(false)
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId })).resolves.toBeNull()
  })

  it('canonicalizes public manifest fields while request history stays in sidecar', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Canonical Fields',
      brief: 'Create an artifact',
    })
    const manifestPath = join(created.artifactPath, 'manifest.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...created.manifest,
        id: 'agent-tampered-id',
        status: 'not-a-status',
        requests: [
          {
            at: '2026-01-01T00:00:00.000Z',
            from: 'voice',
            action: 'continue',
            brief: 'Ignored compact manifest request',
          },
        ],
        createdAt: '',
        updatedAt: '',
        archived: 'yes',
        extra: 'removed',
      })
    )

    const updated = await appendArtifactRequest({
      agentWorkspacePath,
      artifactId: created.artifactId,
      action: 'continue',
      brief: 'Continue with the canonicalized artifact',
    })

    expect(updated.id).toBe(created.artifactId)
    expect(updated.title).toBe(created.manifest.title)
    expect(updated.status).toBe('working')
    expect(updated.archived).toBe(false)
    expect(updated.createdAt).not.toBe('')
    expect(updated.updatedAt).not.toBe('')
    await expect(readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { brief: 'Create an artifact' },
      { brief: 'Continue with the canonicalized artifact' },
    ])
    expect(await readJson(manifestPath)).toEqual(updated)
    expect(existsSync(join(created.artifactPath, '.manifest.backend.json'))).toBe(false)
  })

  it('archives using request sidecar history and keeps manifest compact', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Archive Canonical Fields',
      brief: 'Create an artifact',
    })
    await writeFile(
      join(created.artifactPath, 'manifest.json'),
      JSON.stringify({
        ...created.manifest,
        requests: [
          { at: '2026-01-01T00:00:00.000Z', from: 'voice', action: 'delete', brief: '' },
          {
            at: '2026-01-01T00:00:00.000Z',
            from: 'voice',
            action: 'continue',
            brief: 'Keep this valid public manifest request',
          },
        ],
        archived: false,
      })
    )

    const archived = await archiveArtifact({
      agentWorkspacePath,
      artifactId: created.artifactId,
      brief: 'Archive using canonicalized state',
    })

    await expect(readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { brief: 'Create an artifact' },
      { brief: 'Archive using canonicalized state' },
    ])
    expect('requests' in archived).toBe(false)
    expect(archived.archived).toBe(true)
  })

  it('ignores artifact directories with unsafe names when listing', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    consoleSpies.push(warning)
    const valid = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Safe Artifact',
      brief: 'Create a safe artifact',
    })
    const unsafePath = join(agentWorkspacePath, 'artifacts', '..bad')
    await mkdir(unsafePath, { recursive: true })
    await writeFile(join(unsafePath, 'manifest.json'), JSON.stringify(valid.manifest))

    const manifests = await listArtifactManifests({ agentWorkspacePath })

    expect(manifests.map((manifest) => manifest.id)).toEqual([valid.artifactId])
    expect(warning).toHaveBeenCalled()
  })

  it('resolves local artifact paths and rejects traversal', async () => {
    const { artifactId, artifactPath } = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Path Test',
      brief: 'Create path test artifact',
    })

    expect(resolveArtifactPath({ agentWorkspacePath, artifactId, localPath: 'nested/file.md' })).toBe(
      join(artifactPath, 'nested/file.md')
    )
    for (const localPath of ['../secret.md', '/tmp/secret.md', 'C:/secret.md', 'nested\\file.md']) {
      expect(() => resolveArtifactPath({ agentWorkspacePath, artifactId, localPath })).toThrow('Invalid artifact path')
    }
  })

  it('rejects local artifact paths that escape through symlinks', async () => {
    const { artifactId, artifactPath } = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Symlink Path Test',
      brief: 'Create symlink path test artifact',
    })
    const outsidePath = await mkdtemp(join(tmpdir(), 'ficus-artifact-outside-'))

    try {
      await symlink(outsidePath, join(artifactPath, 'nested'))

      expect(() => resolveArtifactPath({ agentWorkspacePath, artifactId, localPath: 'nested/file.md' })).toThrow(
        'Invalid artifact path'
      )
    } finally {
      await rm(outsidePath, { recursive: true, force: true })
    }
  })

  it('rejects paths when artifacts root is a symlink to the workspace root', async () => {
    await rm(join(agentWorkspacePath, 'artifacts'), { recursive: true, force: true })
    await symlink(agentWorkspacePath, join(agentWorkspacePath, 'artifacts'))

    expect(() =>
      resolveArtifactPath({
        agentWorkspacePath,
        artifactId: 'artifacts',
        localPath: 'file.md',
      })
    ).toThrow('Invalid artifact path')
    await expect(listArtifactManifests({ agentWorkspacePath })).rejects.toThrow('Invalid artifact path')
    await expect(deleteArtifact({ agentWorkspacePath, artifactId: 'artifacts' })).rejects.toThrow(
      'Invalid artifact path'
    )
    await expect(
      createArtifactInAgentWorkspace({
        agentWorkspacePath,
        title: 'Workspace Root Symlink Test',
        brief: 'Should not create through in-workspace artifacts symlink',
      })
    ).rejects.toThrow('Invalid artifact path')
  })

  it('rejects paths when artifacts root is a symlink to another workspace directory', async () => {
    const otherDirectory = join(agentWorkspacePath, 'other-artifacts')
    await mkdir(otherDirectory)
    await rm(join(agentWorkspacePath, 'artifacts'), { recursive: true, force: true })
    await symlink(otherDirectory, join(agentWorkspacePath, 'artifacts'))

    await expect(listArtifactManifests({ agentWorkspacePath })).rejects.toThrow('Invalid artifact path')
    await expect(
      createArtifactInAgentWorkspace({
        agentWorkspacePath,
        title: 'Other Directory Symlink Test',
        brief: 'Should not create through in-workspace artifacts symlink',
      })
    ).rejects.toThrow('Invalid artifact path')
  })

  it('rejects paths when artifacts root itself is a symlink outside the workspace', async () => {
    const outsideArtifactsPath = await mkdtemp(join(tmpdir(), 'ficus-artifacts-root-outside-'))
    await rm(join(agentWorkspacePath, 'artifacts'), { recursive: true, force: true })
    await symlink(outsideArtifactsPath, join(agentWorkspacePath, 'artifacts'))

    try {
      await mkdir(join(outsideArtifactsPath, 'artifacts-root-symlink-test'))

      expect(() =>
        resolveArtifactPath({
          agentWorkspacePath,
          artifactId: 'artifacts-root-symlink-test',
          localPath: 'file.md',
        })
      ).toThrow('Invalid artifact path')
      await expect(
        createArtifactInAgentWorkspace({
          agentWorkspacePath,
          title: 'Artifacts Root Symlink Test',
          brief: 'Should not create outside workspace',
        })
      ).rejects.toThrow('Invalid artifact path')
    } finally {
      await rm(outsideArtifactsPath, { recursive: true, force: true })
    }
  })

  it('refuses to list manifests when artifacts root is a symlink outside the workspace', async () => {
    const outsideArtifactsPath = await mkdtemp(join(tmpdir(), 'ficus-list-artifacts-root-outside-'))
    await rm(join(agentWorkspacePath, 'artifacts'), { recursive: true, force: true })
    await symlink(outsideArtifactsPath, join(agentWorkspacePath, 'artifacts'))

    try {
      await expect(listArtifactManifests({ agentWorkspacePath })).rejects.toThrow('Invalid artifact path')
    } finally {
      await rm(outsideArtifactsPath, { recursive: true, force: true })
    }
  })

  it('returns null instead of reading a symlinked manifest outside the workspace', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Manifest Read Symlink Test',
      brief: 'Create manifest read symlink test artifact',
    })
    const outsidePath = await mkdtemp(join(tmpdir(), 'ficus-manifest-read-outside-'))
    const outsideManifestPath = join(outsidePath, 'manifest.json')
    await writeFile(
      outsideManifestPath,
      JSON.stringify({
        ...created.manifest,
        id: created.artifactId,
        title: 'Outside Manifest',
      })
    )

    try {
      await rm(join(created.artifactPath, 'manifest.json'), { force: true })
      await symlink(outsideManifestPath, join(created.artifactPath, 'manifest.json'))

      await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toBeNull()
    } finally {
      await rm(outsidePath, { recursive: true, force: true })
    }
  })

  it('refuses to delete through a symlinked artifacts root', async () => {
    const outsideArtifactsPath = await mkdtemp(join(tmpdir(), 'ficus-delete-artifacts-root-outside-'))
    const outsideArtifactPath = join(outsideArtifactsPath, 'delete-root-symlink-test')
    await mkdir(outsideArtifactPath)
    await writeFile(join(outsideArtifactPath, 'keep.txt'), 'do not delete')
    await rm(join(agentWorkspacePath, 'artifacts'), { recursive: true, force: true })
    await symlink(outsideArtifactsPath, join(agentWorkspacePath, 'artifacts'))

    try {
      await expect(deleteArtifact({ agentWorkspacePath, artifactId: 'delete-root-symlink-test' })).rejects.toThrow(
        'Invalid artifact path'
      )
      expect(existsSync(join(outsideArtifactPath, 'keep.txt'))).toBe(true)
    } finally {
      await rm(outsideArtifactsPath, { recursive: true, force: true })
    }
  })

  it('refuses to delete through a symlinked artifact directory', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Delete Symlink Test',
      brief: 'Create delete symlink test artifact',
    })
    const outsidePath = await mkdtemp(join(tmpdir(), 'ficus-delete-artifact-outside-'))
    await writeFile(join(outsidePath, 'keep.txt'), 'do not delete')

    try {
      await rm(created.artifactPath, { recursive: true, force: true })
      await symlink(outsidePath, created.artifactPath)

      await expect(deleteArtifact({ agentWorkspacePath, artifactId: created.artifactId })).rejects.toThrow(
        'Invalid artifact path'
      )
      expect(existsSync(join(outsidePath, 'keep.txt'))).toBe(true)
    } finally {
      await rm(outsidePath, { recursive: true, force: true })
    }
  })

  it('refuses to append or archive through a symlinked artifact directory', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Manifest Symlink Test',
      brief: 'Create manifest symlink test artifact',
    })
    const outsidePath = await mkdtemp(join(tmpdir(), 'ficus-manifest-write-outside-'))

    try {
      await rm(created.artifactPath, { recursive: true, force: true })
      await symlink(outsidePath, created.artifactPath)
      await writeFile(join(outsidePath, 'manifest.json'), JSON.stringify(created.manifest))

      await expect(
        appendArtifactRequest({
          agentWorkspacePath,
          artifactId: created.artifactId,
          action: 'continue',
          brief: 'Should not write outside workspace',
        })
      ).rejects.toThrow('Invalid artifact path')
      await expect(
        archiveArtifact({
          agentWorkspacePath,
          artifactId: created.artifactId,
          brief: 'Should not archive outside workspace',
        })
      ).rejects.toThrow('Invalid artifact path')
    } finally {
      await rm(outsidePath, { recursive: true, force: true })
    }
  })

  it('rejects paths when the artifact directory itself is a symlink outside artifacts root', async () => {
    const { artifactId, artifactPath } = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Root Symlink Test',
      brief: 'Create root symlink path test artifact',
    })
    const outsidePath = await mkdtemp(join(tmpdir(), 'ficus-artifact-root-outside-'))

    try {
      await rm(artifactPath, { recursive: true, force: true })
      await symlink(outsidePath, artifactPath)

      expect(() => resolveArtifactPath({ agentWorkspacePath, artifactId, localPath: 'file.md' })).toThrow(
        'Invalid artifact path'
      )
    } finally {
      await rm(outsidePath, { recursive: true, force: true })
    }
  })

  it('rejects sibling artifact directory aliases without modifying the target artifact', async () => {
    const target = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Target Artifact',
      brief: 'Create target artifact',
    })
    const aliasId = 'alias-artifact'
    const aliasPath = join(agentWorkspacePath, 'artifacts', aliasId)
    await symlink(target.artifactPath, aliasPath)

    await expect(
      appendArtifactRequest({
        agentWorkspacePath,
        artifactId: aliasId,
        action: 'continue',
        brief: 'Should not append through alias',
      })
    ).rejects.toThrow('Invalid artifact path')
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: aliasId })).rejects.toThrow(
      'Invalid artifact path'
    )
    expect(() => resolveArtifactPath({ agentWorkspacePath, artifactId: aliasId, localPath: 'file.md' })).toThrow(
      'Invalid artifact path'
    )
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: target.artifactId })).resolves.toEqual(
      target.manifest
    )
  })

  it('cleans up artifact directory when create manifest validation fails', async () => {
    await expect(
      createArtifactInAgentWorkspace({
        agentWorkspacePath,
        title: 'Failed Create Cleanup',
        brief: '',
      })
    ).rejects.toThrow()

    expect(existsSync(join(agentWorkspacePath, 'artifacts', 'failed-create-cleanup'))).toBe(false)
  })

  it('rejects backend-created manifests with invalid request data instead of repairing them', async () => {
    await expect(
      createArtifactInAgentWorkspace({
        agentWorkspacePath,
        title: 'Invalid Create Request',
        brief: 'Create artifact with invalid references',
        references: [{ type: 'url', url: 'not a url' }] as never,
      })
    ).rejects.toThrow()

    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Invalid Append Request',
      brief: 'Create artifact for invalid append',
    })
    await expect(
      appendArtifactRequest({
        agentWorkspacePath,
        artifactId: created.artifactId,
        action: 'continue',
        brief: '',
      })
    ).rejects.toThrow()
    await expect(readArtifactManifest({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toEqual(
      created.manifest
    )
  })

  it('serializes exported sidecar appends with manifest mutations', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Exported Sidecar Queue',
      brief: 'Create artifact for exported sidecar queue',
    })

    await Promise.all([
      appendArtifactRequest({
        agentWorkspacePath,
        artifactId: created.artifactId,
        action: 'continue',
        brief: 'High-level queued append',
      }),
      appendArtifactRequests({
        agentWorkspacePath,
        artifactId: created.artifactId,
        requests: [
          {
            at: new Date().toISOString(),
            from: 'voice',
            action: 'continue',
            brief: 'Exported sidecar append',
          },
        ],
      }),
    ])

    await expect(readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })).resolves.toMatchObject([
      { brief: 'Create artifact for exported sidecar queue' },
      { brief: 'High-level queued append' },
      { brief: 'Exported sidecar append' },
    ])
  })

  it('preserves all requests from concurrent appends through real and symlinked workspace paths', async () => {
    const created = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: 'Concurrent Append Artifact',
      brief: 'Create artifact for concurrent appends',
    })

    const symlinkWorkspacePath = join(tmpdir(), `ficus-workspace-link-${Date.now()}-${Math.random()}`)
    await symlink(agentWorkspacePath, symlinkWorkspacePath)

    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          appendArtifactRequest({
            agentWorkspacePath: index % 2 === 0 ? agentWorkspacePath : symlinkWorkspacePath,
            artifactId: created.artifactId,
            action: 'continue',
            brief: `Concurrent append ${index}`,
          })
        )
      )
    } finally {
      await rm(symlinkWorkspacePath, { force: true })
    }

    const requests = await readArtifactRequests({ agentWorkspacePath, artifactId: created.artifactId })
    expect(requests).toHaveLength(21)
    expect(requests.map((request) => request.brief).sort()).toEqual([
      'Concurrent append 0',
      'Concurrent append 1',
      'Concurrent append 10',
      'Concurrent append 11',
      'Concurrent append 12',
      'Concurrent append 13',
      'Concurrent append 14',
      'Concurrent append 15',
      'Concurrent append 16',
      'Concurrent append 17',
      'Concurrent append 18',
      'Concurrent append 19',
      'Concurrent append 2',
      'Concurrent append 3',
      'Concurrent append 4',
      'Concurrent append 5',
      'Concurrent append 6',
      'Concurrent append 7',
      'Concurrent append 8',
      'Concurrent append 9',
      'Create artifact for concurrent appends',
    ])
  })

  it('truncates long title slugs while preserving collision suffixes', async () => {
    const longTitle = 'Very Long Artifact Title '.repeat(20)

    const first = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: longTitle,
      brief: 'Create first long-title artifact',
    })
    const second = await createArtifactInAgentWorkspace({
      agentWorkspacePath,
      title: longTitle,
      brief: 'Create second long-title artifact',
    })

    expect(first.artifactId.length).toBeLessThanOrEqual(100)
    expect(second.artifactId.length).toBeLessThanOrEqual(100)
    expect(second.artifactId.endsWith('-2')).toBe(true)
    expect(second.artifactId.slice(0, -2)).toBe(first.artifactId.slice(0, second.artifactId.length - 2))
  })

  it('creates unique collision suffixes for concurrent creates with the same title', async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createArtifactInAgentWorkspace({
          agentWorkspacePath,
          title: 'Concurrent Artifact',
          brief: `Create concurrent artifact ${index}`,
        })
      )
    )

    expect(created.map((artifact) => artifact.artifactId).sort()).toEqual([
      'concurrent-artifact',
      'concurrent-artifact-2',
      'concurrent-artifact-3',
      'concurrent-artifact-4',
      'concurrent-artifact-5',
    ])
  })
})
