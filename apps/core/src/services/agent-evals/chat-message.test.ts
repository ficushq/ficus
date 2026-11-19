import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { messageTextForModel } from '../chat/message-context'
import { MESSAGE_CONTEXT_PATH, humanChatText } from './chat-message'
import type { ScenarioText } from './define'
import { FIXTURE_BRANCH, FIXTURE_WORKTREE } from './fixtures'
import { resolveText } from './run'
import { SCENARIOS, findScenario } from './scenarios'
import { gitRefVariant, variantContext, workingTreeVariant, type PromptVariant } from './variant'

/** Main's commit that added the sender note (PR 969); its parent is the last renderer without it. */
const SENDER_NOTE_COMMIT = '767d79ed1b3e7a00502ac7611d00bd97231168e5'
const NOAH = { userId: '51846fad-3980-4ec3-943c-1ebe9c822b2e', name: 'noah' }
const PRIYA = { userId: '7a9e3c21-5b4d-4f6e-8a1b-2c3d4e5f6a7b', name: 'priya' }
const note = (sender: { userId: string; name: string }) => `\n\n[Sent by ${JSON.stringify(sender)} (server-stamped)]`

/** Every human chat message in the scenarios, opening and history, with the sender the server stamps. */
const CHATS: { scenario: string; where: 'history' | 'opening'; content: string; sender: typeof NOAH }[] = [
  {
    scenario: 'offer-followup',
    where: 'history',
    content: `Please fix the misspelling "recieve" in docs/wiki/permissions.md. Thanks! The existing worktree is ${FIXTURE_WORKTREE}, on branch ${FIXTURE_BRANCH}.`,
    sender: NOAH,
  },
  { scenario: 'offer-followup', where: 'opening', content: 'Please summarize the change you completed.', sender: NOAH },
  {
    scenario: 'requester-identity',
    where: 'opening',
    content:
      'Please open a work stream to fix the flaky host budget test in apps/core/src/services/slots/host-budget.test.ts, and make me the reviewer.',
    sender: NOAH,
  },
  {
    scenario: 'new-work-request',
    where: 'opening',
    content: 'Could you open a new work stream to migrate the docs site to Astro? Noah wants it this quarter.',
    sender: PRIYA,
  },
  {
    scenario: 'cli-discovery',
    where: 'opening',
    content:
      'Before you start on PR 950, check your inbox for any earlier messages about it, including ones you have already marked as read, and tell me what they say.',
    sender: NOAH,
  },
]

const temporaryRoots: string[] = []
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The renderer and its direct imports at a commit (the imports differ between the two versions). */
const RENDERER_FILES = [
  MESSAGE_CONTEXT_PATH,
  'apps/core/src/services/routing/assistant-routing-note.ts',
  'apps/core/src/services/chat/review-consultation-note.ts',
  'apps/core/src/services/inference-usage/types.ts',
]

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ficus-eval-chat-test-'))
  temporaryRoots.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
      .toString()
      .trim()
  git('init')
  // The installed dependencies are linked into each extraction, as for real refs.
  writeFileSync(join(root, '.gitignore'), 'node_modules\n')
  symlinkSync(join(workingTreeVariant().root, 'node_modules'), join(root, 'node_modules'))
  const write = (path: string, source: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  const commit = () => {
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Chat fixture')
    const sha = git('rev-parse', 'HEAD')
    temporaryRoots.push(join(tmpdir(), 'ficus-agent-evals', sha))
    return sha
  }
  return { root, write, commit }
}

/** Source of a repository file at a commit of this repository (CI checks out full history). */
function sourceAt(commit: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['-C', workingTreeVariant().root, 'show', `${commit}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

async function chatTexts(variant: PromptVariant) {
  const context = variantContext(variant)
  const texts: string[] = []
  for (const chat of CHATS) {
    const scenario = findScenario(chat.scenario)!
    const entries: ScenarioText[] =
      chat.where === 'opening'
        ? scenario.messages
        : (scenario.history ?? []).flatMap((entry) => ('user' in entry ? [entry.user] : []))
    const rendered = await Promise.all(entries.map((entry) => resolveText(entry, context)))
    const text = rendered.find((candidate) => candidate.startsWith(chat.content))
    expect(text).toBeDefined()
    texts.push(text!)
  }
  return texts
}

test('each real ref renders every chat, opening and history, with its own renderer', async () => {
  const repo = repository()
  const oldFiles = RENDERER_FILES.map((path) => [path, sourceAt(`${SENDER_NOTE_COMMIT}^`, path)] as const)
  const newFiles = RENDERER_FILES.map((path) => [path, sourceAt(SENDER_NOTE_COMMIT, path)] as const)
  // The pre-note renderer neither imports nor needs the usage types; the noted one does.
  expect(oldFiles.find(([path]) => path === MESSAGE_CONTEXT_PATH)![1]).not.toContain('chatSenderNote')
  expect(newFiles.find(([path]) => path === MESSAGE_CONTEXT_PATH)![1]).toContain('chatSenderNote')
  for (const [path, source] of oldFiles) if (source !== undefined) repo.write(path, source)
  const oldRef = repo.commit()
  for (const [path, source] of newFiles) repo.write(path, source!)
  const newRef = repo.commit()
  // Uncommitted edits must never reach either ref.
  repo.write(MESSAGE_CONTEXT_PATH, 'export function messageTextForModel() { return "uncommitted" }\n')

  const old = gitRefVariant(oldRef, repo.root)
  const newer = gitRefVariant(newRef, repo.root)
  expect(readFileSync(join(old.root, MESSAGE_CONTEXT_PATH), 'utf8')).toBe(oldFiles[0]![1]!)
  expect(readFileSync(join(newer.root, MESSAGE_CONTEXT_PATH), 'utf8')).toBe(newFiles[0]![1]!)

  const oldTexts = await chatTexts(old)
  const newTexts = await chatTexts(newer)
  CHATS.forEach((chat, index) => {
    // The old runtime added no note, so the baseline reads the bare message, as before this harness.
    expect(oldTexts[index]).toBe(chat.content)
    expect(newTexts[index]).toBe(chat.content + note(chat.sender))
  })
  // Both refs keep their own renderer across repeated runs (no module or cache bleed-through).
  expect(await chatTexts(old)).toEqual(oldTexts)
})

test('the working tree renders chats with the working renderer and leaves other messages literal', async () => {
  const context = variantContext(workingTreeVariant())
  for (const chat of CHATS) {
    const metadata = { source: 'user_chat' as const, sender: chat.sender }
    expect(await humanChatText(context, chat.content, chat.sender)).toBe(
      messageTextForModel({ content: chat.content, metadata })
    )
  }
  expect(
    (await chatTexts(workingTreeVariant())).every((text, index) => text.endsWith(note(CHATS[index]!.sender)))
  ).toBe(true)
  // Inbox notices and step assignments are not human chat and stay exactly as written.
  for (const name of ['ask-human-decision', 'automerge-clean', 'completion-ready'])
    for (const message of findScenario(name)!.messages) expect(typeof message).toBe('string')
  // Every chat call site is covered above: no other scenario renders through the chat renderer.
  const chatScenarios = new Set(CHATS.map((chat) => chat.scenario))
  for (const scenario of SCENARIOS.filter((candidate) => !chatScenarios.has(candidate.name)))
    for (const message of scenario.messages)
      if (typeof message === 'function') expect(scenario.name).toStartWith('restart-')
})

test('a ref without the chat renderer fails explicitly instead of borrowing the working one', async () => {
  const repo = repository()
  const variant = gitRefVariant(repo.commit(), repo.root)
  expect(existsSync(join(variant.root, MESSAGE_CONTEXT_PATH))).toBe(false)
  await expect(humanChatText(variantContext(variant), 'Hello', NOAH)).rejects.toThrow(
    `Missing ${MESSAGE_CONTEXT_PATH} in variant ${variant.label}`
  )
  // Every chat scenario fails the same way, so none silently runs on the working renderer.
  await expect(chatTexts(variant)).rejects.toThrow(`Missing ${MESSAGE_CONTEXT_PATH}`)
})

test('a renderer module without messageTextForModel fails explicitly', async () => {
  const repo = repository()
  repo.write(MESSAGE_CONTEXT_PATH, 'export const unrelated = 1\n')
  const variant = gitRefVariant(repo.commit(), repo.root)
  await expect(humanChatText(variantContext(variant), 'Hello', NOAH)).rejects.toThrow(
    'does not export messageTextForModel'
  )
})
