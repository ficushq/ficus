import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as yaml from 'js-yaml'
import {
  fitPublicVoiceToCap,
  PUBLIC_VOICE_MAX_BYTES,
  publicVoiceBytes,
  publicVoiceProfileInputSchema,
  renderPublicVoicePrompt,
  resolvePublicVoice,
} from '@ficus/shared'
import { assembleScenarioPrompt } from './prompt'
import { SCENARIOS } from './scenarios'
import { gitRefVariant, workingTreeVariant, type PromptVariant } from './variant'

const working = workingTreeVariant()
const voiceModule = 'packages/shared/src/public-voice.ts'
const profilePath = 'config/public-voices/default.yaml'
const temporaryRoots: string[] = []

function fixture(): PromptVariant {
  const root = mkdtempSync(join(tmpdir(), 'ficus-eval-voice-test-'))
  temporaryRoots.push(root)
  for (const path of [
    'config/agent-types',
    'config/roles',
    profilePath,
    voiceModule,
    'apps/core/src/lib/prompts/slot-pools-render.ts',
    'apps/core/src/services/slots/format.ts',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    cpSync(join(working.root, path), join(root, path), { recursive: true })
  }
  symlinkSync(join(working.root, 'node_modules'), join(root, 'node_modules'))
  return { label: 'voice fixture', root }
}

async function promptFor(variant: PromptVariant, agentType = 'engineer'): Promise<string> {
  return (await assembleScenarioPrompt(variant, { ...SCENARIOS[0]!, agentType })).systemPrompt
}

function expectedVoice(root: string): string {
  const profile = publicVoiceProfileInputSchema.parse(yaml.load(readFileSync(join(root, profilePath), 'utf8')))
  return renderPublicVoicePrompt(
    fitPublicVoiceToCap(
      resolvePublicVoice({
        squad: null,
        assigned: null,
        instanceDefault: {
          ...profile,
          description: profile.description ?? null,
          surfaces: profile.surfaces ?? {},
          disabled: false,
        },
      }),
      PUBLIC_VOICE_MAX_BYTES
    ).resolved
  )
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('behaviour eval public voice', () => {
  for (const type of [
    'engineer',
    'reviewer',
    'architect',
    'security-auditor',
    'general',
    'sysops',
    'manager',
    'consultant',
    'system-manager',
    'assistant-worker',
  ]) {
    test(`${type} reads the shipped voice and fixed invariants exactly once`, async () => {
      const prompt = await promptFor(working, type)
      const voice = expectedVoice(working.root)
      expect(voice).not.toBe('')
      expect(publicVoiceBytes(voice)).toBeLessThanOrEqual(PUBLIC_VOICE_MAX_BYTES)
      expect(prompt.split(voice)).toHaveLength(2)
      expect(prompt.split('### Voice')).toHaveLength(2)
      expect(prompt.split('## Public text')).toHaveLength(2)
      expect(prompt.split('Never describe a skipped or bypassed check as passed.')).toHaveLength(2)
      expect(prompt).not.toContain('{{squad.publicVoice}}')
    })
  }

  for (const type of ['assistant', 'subagent', 'artifact-builder-default']) {
    test(`${type} does not acquire irrelevant public voice text`, async () => {
      const prompt = await promptFor(working, type)
      expect(prompt).not.toContain('### Voice')
      expect(prompt).not.toContain(expectedVoice(working.root))
    })
  }

  test('uses the variant profile, deterministically, rather than the working tree profile', async () => {
    const variant = fixture()
    writeFileSync(
      join(variant.root, profilePath),
      yaml.dump({ id: 'default', name: 'Default', base: 'This ref has its own voice.' })
    )
    const prompt = await promptFor(variant)
    expect(prompt).toContain('### Voice\n\nThis ref has its own voice.')
    expect(prompt).not.toContain(expectedVoice(working.root))
    expect(await promptFor(variant)).toBe(prompt)
  })

  test('applies the runtime byte cap and surface dropping order', async () => {
    const variant = fixture()
    writeFileSync(
      join(variant.root, profilePath),
      yaml.dump({
        id: 'default',
        name: 'Default',
        base: 'A short base.',
        surfaces: {
          commits: { mode: 'add', text: 'é'.repeat(650) },
          channels: { mode: 'add', text: '界'.repeat(300) },
        },
      })
    )
    const prompt = await promptFor(variant)
    expect(prompt).toContain(expectedVoice(variant.root))
    expect(prompt).toContain('é'.repeat(650))
    expect(prompt).not.toContain('界'.repeat(300))
  })

  test('keeps the voice once when the public-text include omits its token', async () => {
    const variant = fixture()
    const rulesPath = join(variant.root, 'config/agent-types/shared/public-text.md')
    writeFileSync(rulesPath, readFileSync(rulesPath, 'utf8').replace('{{squad.publicVoice}}', ''))
    const prompt = await promptFor(variant)
    expect(prompt.split(expectedVoice(variant.root))).toHaveLength(2)
    expect(prompt.split('## Public text')).toHaveLength(2)
  })

  test('uses the variant’s own resolver and byte limit', async () => {
    const variant = fixture()
    const modulePath = join(variant.root, voiceModule)
    writeFileSync(
      modulePath,
      readFileSync(modulePath, 'utf8').replace('PUBLIC_VOICE_MAX_BYTES = 2000', 'PUBLIC_VOICE_MAX_BYTES = 700')
    )
    const prompt = await promptFor(variant)
    const {
      renderPublicVoicePrompt: render,
      resolvePublicVoice: resolve,
      fitPublicVoiceToCap: fit,
    } = await import(modulePath)
    const profile = publicVoiceProfileInputSchema.parse(
      yaml.load(readFileSync(join(variant.root, profilePath), 'utf8'))
    )
    const voice = render(
      fit(resolve({ squad: null, assigned: null, instanceDefault: { ...profile, disabled: false } })).resolved
    )
    expect(voice).not.toBe('')
    expect(publicVoiceBytes(voice)).toBeLessThanOrEqual(700)
    expect(prompt).toContain(voice)
    expect(prompt).not.toContain(expectedVoice(working.root))
  })

  test('does not add a voice when the public-text include is unavailable', async () => {
    const variant = fixture()
    rmSync(join(variant.root, 'config/agent-types/shared/public-text.md'))
    expect(await promptFor(variant)).not.toContain('### Voice')
  })

  for (const missing of [profilePath, voiceModule]) {
    test(`does not normalize a baseline missing ${missing} to a newer voice`, async () => {
      const variant = fixture()
      rmSync(join(variant.root, missing))
      expect(await promptFor(variant)).not.toContain('### Voice')
    })
  }

  test('git-ref extraction preserves that ref’s voice resolver and profile', async () => {
    const variant = fixture()
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', variant.root, ...args], { stdio: 'pipe' })
        .toString()
        .trim()
    git('init')
    git('add', 'config', 'packages', 'apps')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Voice fixture')
    const extracted = gitRefVariant('HEAD', variant.root)
    temporaryRoots.push(extracted.root)
    expect(existsSync(join(extracted.root, voiceModule))).toBe(true)
    expect(readFileSync(join(extracted.root, voiceModule), 'utf8')).toBe(
      readFileSync(join(variant.root, voiceModule), 'utf8')
    )
    expect(await promptFor(extracted)).toContain(expectedVoice(variant.root))
  })
})
