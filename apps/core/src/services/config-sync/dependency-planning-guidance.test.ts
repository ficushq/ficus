import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../../../')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const normalize = (text: string) => text.replace(/\s+/g, ' ')
const roadmap = normalize(read('config/skills/roadmap-phase-loop/SKILL.md'))
const development = normalize(read('config/skills/work-stream-driven-development/SKILL.md'))
const managerConfig = Bun.YAML.parse(read('config/agent-types/manager.yaml')) as {
  systemPrompt: string
  skills: string[]
}
const manager = normalize(managerConfig.systemPrompt)

// These are instruction contracts, not scheduler tests. Keep the detailed phase
// procedure in the roadmap skill and check the two entry points stay aligned.
describe('dependency planning guidance', () => {
  test('same-repository phases of one design prefer ready rather than serial human merges', () => {
    for (const guidance of [roadmap, development, manager]) {
      expect(guidance).toMatch(/prefer[^.]*:ready/i)
      expect(guidance).toMatch(/same.repository[^.]*phases of one design/i)
      expect(guidance).toMatch(/human[^.]*merge[^.]*delivery, not[^.]*implementation/i)
    }
    expect(managerConfig.skills).toContain('roadmap-phase-loop')
    expect(development).toContain('roadmap-phase-loop')
    expect(manager).toContain('roadmap-phase-loop')
  })

  test('ready means implemented work with a completion-ready flow and bound PR, not merely PR existence', () => {
    expect(roadmap).toContain('`completion-ready`')
    expect(roadmap).toContain('bound delivery PR')
    expect(roadmap).toContain('A PR opened during implementation is not enough')
    expect(roadmap).toContain('platform-owned stacking')
    expect(roadmap).not.toContain('Verify prerequisites have landed')
    expect(roadmap).not.toContain('starts from the actual delivered result')
    expect(roadmap).not.toContain('based on the latest delivered initiative branch')
  })

  test('done remains available for real gates, unavailable runtime state and non-PR delivery', () => {
    for (const guidance of [roadmap, development, manager]) {
      expect(guidance).toContain(':done')
      expect(guidance).toMatch(/explicit[^.]*wait.before.next.phase/i)
      expect(guidance).toMatch(/merged\/deployed[^.]*unavailable on an open branch/i)
      expect(guidance).toMatch(/non-PR[^.]*ready behaves like done/i)
    }
    expect(roadmap).toMatch(/Independent[^.]*no artificial dependency/i)
    expect(roadmap).toMatch(/Cross-repository[^.]*do not[^.]*branch stacking/i)
  })

  test('phase examples retain parent edges, configured bases and initiative isolation', () => {
    expect(roadmap).toContain('--depends-on <parent-id>:ready')
    expect(roadmap).toContain('--base-branch <agreed-base>')
    expect(roadmap).toContain('partial phases must not reach')
    expect(roadmap).toContain('final integration PR targets the original base')
    expect(roadmap).toContain('`git.stackedOn`')
    expect(roadmap).toMatch(/Do not clear[^.]*dependenc/i)
    expect(roadmap).toMatch(/never[^.]*treat an open PR as merged/i)
  })

  test('upstream changes require stack maintenance and delivery still waits for the parent', () => {
    expect(roadmap).toMatch(/upstream[^.]*changes[^.]*merge[^.]*revalidate/i)
    expect(roadmap).toMatch(/parent[^.]*merged[^.]*done[^.]*child[^.]*deliver/i)
    expect(roadmap).toMatch(/merge[^.]*base branch[^.]*before delivery/i)
    expect(roadmap).toContain('verified human merge')
    expect(roadmap).toContain('explicit policy authorization')
  })

  test('edited skills retain valid identifying frontmatter', () => {
    for (const name of ['roadmap-phase-loop', 'work-stream-driven-development']) {
      const source = read(`config/skills/${name}/SKILL.md`)
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)
      expect(frontmatter).not.toBeNull()
      const parsed = Bun.YAML.parse(frontmatter![1]!) as { name: string; description: string }
      expect(parsed.name).toBe(name)
      expect(typeof parsed.description).toBe('string')
      expect(parsed.description.length).toBeGreaterThan(0)
    }
  })
})
