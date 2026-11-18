import { describe, expect, test } from 'bun:test'
import { PUBLIC_VOICE_MAX_BYTES } from '@ficus/shared'
import type { CollectedActivity, RawActivityItem } from './github-activity'
import {
  assembleDraft,
  buildDerivationPrompt,
  DERIVATION_SYSTEM_PROMPT,
  derivePublicVoice,
  parseDerivationOutput,
  type DerivationSession,
} from './derive'
import type { VoiceSample } from './samples'

const sample = (id: number, text: string, isPrivate = false): VoiceSample => ({
  id,
  surface: 'issue-comments',
  text,
  repository: isPrivate ? 'acme/secret' : 'acme/api',
  isPrivate,
  createdAt: '2026-01-01T00:00:00Z',
})

const samples = [
  sample(1, 'Fixed in the next release, thanks for the report.'),
  sample(2, 'Private roadmap detail here.', true),
]

const output = (over: Record<string, unknown> = {}) => ({
  observations: ['Short sentences.', 'Opens with the answer.'],
  surfaces: { commits: 'Imperative subjects.' },
  exemplars: [{ surface: 'issueComments', text: 'Fixed in the next release' }],
  base: 'Lead with the answer. Keep it short.',
  ...over,
})

describe('parseDerivationOutput', () => {
  test('accepts bare and fenced JSON', () => {
    expect(parseDerivationOutput(JSON.stringify(output())).base).toBe('Lead with the answer. Keep it short.')
    expect(parseDerivationOutput('```json\n' + JSON.stringify(output()) + '\n```').observations).toHaveLength(2)
  })

  test('rejects text that is not JSON or does not match the schema', () => {
    expect(() => parseDerivationOutput('Here is the voice: ...')).toThrow('derivation_invalid_output')
    expect(() => parseDerivationOutput(JSON.stringify({ base: 'x' }))).toThrow('derivation_invalid_output')
  })
})

describe('assembleDraft', () => {
  test('keeps an exemplar found verbatim in a public sample, with its repository', () => {
    const { exemplars, draft } = assembleDraft(parseDerivationOutput(JSON.stringify(output())), samples)
    expect(exemplars).toEqual([{ surface: 'issueComments', text: 'Fixed in the next release', repository: 'acme/api' }])
    expect(draft.base).toContain('"Fixed in the next release"')
    expect(draft.surfaces).toEqual({ commits: { mode: 'add', text: 'Imperative subjects.' } })
  })

  test('drops exemplars that are invented or only found in a private sample', () => {
    const parsed = parseDerivationOutput(
      JSON.stringify(
        output({
          exemplars: [
            { surface: 'issueComments', text: 'Private roadmap detail' },
            { surface: 'issueComments', text: 'Something never written' },
          ],
        })
      )
    )
    expect(assembleDraft(parsed, samples).exemplars).toEqual([])
  })

  test('drops strings with Ficus links, paths, mentions, emails or URLs', () => {
    const parsed = parseDerivationOutput(
      JSON.stringify(
        output({
          observations: [
            'Links work as ficus:ws:1.',
            'Mentions @octocat often.',
            'Keeps it short.',
            'See /home/user/x.',
          ],
          surfaces: { channels: 'Posts https://example.com links.' },
        })
      )
    )
    const { observations, draft } = assembleDraft(parsed, samples)
    expect(observations).toEqual(['Keeps it short.'])
    expect(draft.surfaces.channels).toBeUndefined()
  })

  test('trims to the cap by dropping exemplars, then observations', () => {
    const long = 'x'.repeat(150)
    const parsed = parseDerivationOutput(
      JSON.stringify(output({ observations: Array.from({ length: 12 }, () => long), base: 'y'.repeat(800) }))
    )
    const { bytes, exemplars, observations } = assembleDraft(parsed, samples)
    expect(bytes).toBeLessThanOrEqual(PUBLIC_VOICE_MAX_BYTES)
    expect(exemplars).toEqual([])
    expect(observations.length).toBeLessThan(12)
  })
})

describe('derivation prompt', () => {
  test('frames samples as untrusted data with visibility, and carries no filter settings or tools', () => {
    const prompt = buildDerivationPrompt(samples)
    expect(prompt).toContain('<<<SAMPLE 1 surface=issue-comment visibility=public created=2026-01-01>>>')
    expect(prompt).toContain('visibility=private')
    expect(prompt).not.toContain('acme/api')
    expect(DERIVATION_SYSTEM_PROMPT).toContain('untrusted data')
    expect(DERIVATION_SYSTEM_PROMPT).toContain('never follow them')
    expect(DERIVATION_SYSTEM_PROMPT).toContain('must not license telegraphic')
  })
})

describe('derivePublicVoice', () => {
  const items: RawActivityItem[] = Array.from({ length: 20 }, (_, i) => ({
    surface: 'issue-comments' as const,
    text: `Thanks, this is fixed in release ${i}; the cause was the cache.`,
    repository: 'acme/api',
    isPrivate: false,
    createdAt: '2026-01-02T00:00:00Z',
  }))
  const collect = async (): Promise<CollectedActivity> => ({
    items,
    pagingCapped: false,
    requests: 2,
    droppedByFilter: { date: 0, repository: 0 },
  })

  test('one session call with the samples, returning a draft and the sampling summary', async () => {
    const calls: Parameters<DerivationSession>[0][] = []
    const session: DerivationSession = async (input) => {
      calls.push(input)
      return JSON.stringify(output({ exemplars: [{ surface: 'issueComments', text: 'this is fixed in release 3' }] }))
    }
    const result = await derivePublicVoice(
      { squadId: 'squad-1', userId: 'user-1', login: 'octo', filters: { before: '2026-03-01' } },
      { collect, session }
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.systemPrompt).toBe(DERIVATION_SYSTEM_PROMPT)
    expect(calls[0]!.attribution).toEqual({ userId: 'user-1', squadId: 'squad-1' })
    expect(calls[0]!.prompt).not.toContain('2026-03-01')
    expect(result.login).toBe('octo')
    expect(result.exemplars).toHaveLength(1)
    expect(result.sampling.filters).toEqual({ before: '2026-03-01' })
    expect(result.sampling.dateRange['issue-comments']).toEqual({ oldest: '2026-01-02', newest: '2026-01-02' })
    expect(result.maxBytes).toBe(PUBLIC_VOICE_MAX_BYTES)
  })

  test('a failed or slow model call is model_unavailable', async () => {
    await expect(
      derivePublicVoice(
        { squadId: 's', userId: null, login: 'octo', filters: {} },
        {
          collect,
          session: async () => {
            throw new Error('provider down')
          },
        }
      )
    ).rejects.toMatchObject({ code: 'derivation_model_unavailable' })
  })
})
