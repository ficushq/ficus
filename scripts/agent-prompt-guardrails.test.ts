import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  PUBLIC_VOICE_MAX_BYTES,
  publicVoiceProfileInputSchema,
  renderProfileAlone,
} from '../packages/shared/src/public-voice'

/**
 * Guardrails that keep the always-loaded agent guidance from growing back.
 *
 * The composed static prompt of an agent type is its own systemPrompt followed
 * by each include, joined by blank lines: the same join the runtime uses
 * (apps/core/src/services/agent-types/compose-prompt.ts) before it adds the
 * runner sections. Runner sections, CLI help and tool descriptions are not
 * counted here.
 */

const root = join(import.meta.dir, '..')
const typeDirectory = join(root, 'config/agent-types')
const sharedDirectory = join(typeDirectory, 'shared')

interface AgentTypeFile {
  id: string
  includes?: string[]
  systemPrompt: string
}

const sharedPrompts = new Map(
  readdirSync(sharedDirectory)
    .filter((file) => file.endsWith('.md'))
    .map((file) => [file.slice(0, -'.md'.length), readFileSync(join(sharedDirectory, file), 'utf8')])
)

const agentTypes = readdirSync(typeDirectory)
  .filter((file) => file.endsWith('.yaml'))
  .map((file) => Bun.YAML.parse(readFileSync(join(typeDirectory, file), 'utf8')) as AgentTypeFile)

function composeStaticPrompt(type: AgentTypeFile): string {
  return [type.systemPrompt, ...(type.includes ?? []).map((id) => sharedPrompts.get(id)!)].join('\n\n')
}

/**
 * Byte budget for each built-in agent type's composed static prompt. A budget
 * is the measured size rounded up to the next 500 bytes. Raising one is a
 * reviewed change: say in the pull request what the new text is for and why it
 * must be loaded on every turn rather than delivered where it is used. Lower a
 * budget when guidance is removed.
 */
const STATIC_PROMPT_BYTE_BUDGETS: Record<string, number> = {
  manager: 58_000,
  consultant: 41_500,
  reviewer: 34_000,
  sysops: 32_500,
  architect: 31_500,
  'security-auditor': 31_500,
  engineer: 30_500,
  general: 26_000,
  'system-manager': 20_500,
  'assistant-worker': 19_500,
  'artifact-builder-default': 9_000,
  assistant: 7_500,
  subagent: 6_000,
}

/** Paragraphs shorter than this (headings, code fence lines, template tokens) may repeat. */
const MIN_CHECKED_PARAGRAPH_LENGTH = 40

/** Paragraphs that appear more than once in one text, whitespace-normalized. */
function repeatedParagraphs(text: string): string[] {
  const counts = new Map<string, number>()
  for (const paragraph of text.split(/\n\s*\n/)) {
    const normalized = paragraph.replace(/\s+/g, ' ').trim()
    if (normalized.length < MIN_CHECKED_PARAGRAPH_LENGTH) continue
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count > 1).map(([paragraph]) => paragraph)
}

test('every include named by a built-in agent type exists', () => {
  const missing = agentTypes.flatMap((type) =>
    (type.includes ?? []).filter((id) => !sharedPrompts.has(id)).map((id) => `${type.id}: ${id}`)
  )
  expect(missing).toEqual([])
})

describe('static prompt byte budgets', () => {
  test('every built-in agent type has a budget, and every budget has a type', () => {
    expect(agentTypes.map((type) => type.id).sort()).toEqual(Object.keys(STATIC_PROMPT_BYTE_BUDGETS).sort())
  })

  for (const type of agentTypes) {
    test(`${type.id} stays within its budget`, () => {
      const bytes = Buffer.byteLength(composeStaticPrompt(type), 'utf8')
      expect({ type: type.id, bytes, withinBudget: bytes <= STATIC_PROMPT_BYTE_BUDGETS[type.id]! }).toEqual({
        type: type.id,
        bytes,
        withinBudget: true,
      })
    })
  }
})

describe('no paragraph appears twice in one composed prompt', () => {
  test('the checker finds a repeated paragraph and ignores short ones', () => {
    const rule = 'Write every text field in normal, readable prose with normal spacing.'
    expect(repeatedParagraphs(`${rule}\n\n### Inbox\n\n${rule.replace(/ /g, '\n')}\n\n### Inbox`)).toEqual([rule])
  })

  for (const type of agentTypes) {
    test(type.id, () => {
      expect(repeatedParagraphs(composeStaticPrompt(type))).toEqual([])
    })
  }
})

describe('public voice', () => {
  const defaultProfile = publicVoiceProfileInputSchema.parse(
    Bun.YAML.parse(readFileSync(join(root, 'config/public-voices/default.yaml'), 'utf8'))
  )
  const renderedDefault = renderProfileAlone({
    ...defaultProfile,
    description: defaultProfile.description ?? null,
    surfaces: defaultProfile.surfaces ?? {},
    disabled: false,
  })

  test('the shipped default voice renders within the cap', () => {
    expect(Buffer.byteLength(renderedDefault, 'utf8')).toBeLessThanOrEqual(PUBLIC_VOICE_MAX_BYTES)
  })

  test('the fixed public-text rules plus the default voice stay small', () => {
    const publicText = sharedPrompts.get('public-text')!
    expect(publicText).toContain('{{squad.publicVoice}}')
    const composed = publicText.replace('{{squad.publicVoice}}', renderedDefault)
    expect(Buffer.byteLength(composed, 'utf8')).toBeLessThanOrEqual(
      Buffer.byteLength(publicText, 'utf8') + PUBLIC_VOICE_MAX_BYTES
    )
    expect(Buffer.byteLength(composed, 'utf8')).toBeLessThanOrEqual(2_693)
  })

  test('agents that cannot post publicly do not load the public-text rules', () => {
    const withPublicText = agentTypes.filter((type) => type.includes?.includes('public-text')).map((type) => type.id)
    for (const id of ['assistant', 'artifact-builder-default', 'subagent']) expect(withPublicText).not.toContain(id)
  })
})

test('CI runs these database-free guardrails', () => {
  const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> }>
  }
  expect(Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])).toContainEqual({
    name: 'Validate agent prompt size and duplication guardrails',
    run: 'bun test ../scripts/agent-prompt-guardrails.test.ts',
    'working-directory': '.github',
  })
})

// The routing and stop rules must be known before a tool/command is chosen;
// payload details are discoverable at the point of use, not paid for every turn.
describe('questions and waits in composed squad prompts', () => {
  for (const type of agentTypes.filter((type) => type.includes?.includes('squad-rules'))) {
    test(type.id, () => {
      const prompt = composeStaticPrompt(type)
      expect(prompt.split('Use `ask_human` for every human')).toHaveLength(2)
      expect(prompt.split('When owner instructions conflict, newer text does')).toHaveLength(2)
      expect(prompt).toContain('ask with `ask_human` before exploring or implementing either')
      expect(prompt).toContain('Do clearly in-scope follow-up work without asking')
      expect(prompt).toContain('ask only for work outside scope, and never end a turn with an offer')
      expect(prompt).toContain('Chat questions are allowed in casual conversation with an actively chatting')
      expect(prompt).toContain('human, never for a work decision')
      expect(prompt).toContain('End your turn while blocked or paused')
      expect(prompt).toContain('A pause requires explicit resume')
      expect(prompt).toContain('check remaining waits and continue the saved attempt')
      expect(prompt).toContain('`actor: owner` when the stream owner must')
      expect(prompt).toContain('request-input --help')
      expect(prompt).toContain('resolve-input --help')
      expect(prompt).toContain('ficus agent-question resolve --help')
      expect(prompt).not.toContain('Pick the wait by who must act')
      expect(prompt).not.toContain('"kind":"decide"')
    })
  }
})
