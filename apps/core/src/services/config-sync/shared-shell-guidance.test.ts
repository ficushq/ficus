import { describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import { join } from 'path'

const repoRoot = join(import.meta.dir, '../../../../../')
const readRepoFile = (path: string) => readFile(join(repoRoot, path), 'utf8')

describe('local app deployment guidance', () => {
  /**
   * The deploy-app skill used to teach `--port 5173` and a command with the
   * port baked in. That is the exact pattern that breaks on the VM runtime,
   * where every squad's box shares one machine loopback — and it says nothing
   * about the path prefix, so a default Vite build's /assets/* all 404 while
   * the page itself returns 200. Agents read the skill, not CLI flag help, so
   * the guidance is the thing that has to be right.
   */
  test('deploy-app tells agents to let Ficus assign the port and to set the base path', async () => {
    const skill = await readRepoFile('config/skills/deploy-app/SKILL.md')

    expect(skill).toContain('FICUS_APP_BASE_PATH')
    expect(skill).toContain('$PORT')
    // The managed-start example must not hand back a hard-coded port.
    expect(skill).toContain('Do not pass `--port`')
    expect(skill).not.toContain('--port 5173 \\')

    expect(skill).toContain('Always honor `$FICUS_APP_BASE_PATH`')
    expect(skill).toMatch(/hosted[\s\S]*?`\/`/i)
    expect(skill).toContain('root-absolute asset URLs work by default')
    expect(skill).toMatch(/self-hosted[\s\S]*?`\/api\/app\/<id>\/`/i)
    expect(skill).toMatch(/hosted `\.app` URLs[\s\S]*?HTTPS/i)
    expect(skill).toContain('The URL is the credential')

    // Each framework needs telling in its own vocabulary; a bare mention of the
    // variable does not help an agent holding a Next app. Next rejects both `/`
    // and a trailing slash, so the documented expression must normalize them.
    for (const setting of ['base', 'basePath', 'PUBLIC_URL']) expect(skill).toContain(setting)
    expect(skill).toContain("basePath: process.env.FICUS_APP_BASE_PATH?.replace(/\\/$/, '')")

    expect(skill).toContain('WebSocket upgrades are not supported')
    expect(skill).toMatch(/SSE|polling/)
  })

  test('visual review uses a Ficus-managed app with an assigned port', async () => {
    const skill = await readRepoFile('config/skills/frontend-visual-review/SKILL.md')
    expect(skill).toContain('tau deploy local start')
    expect(skill).toContain('$PORT')
    expect(skill).toContain('$FICUS_APP_BASE_PATH')
    expect(skill).not.toContain('nohup')
    expect(skill).not.toContain('tau deploy local attach')
  })
})

describe('shared-first shell guidance', () => {
  test('deployment and visual-review skills select squad_bash', async () => {
    const skills = [
      'deploy-app',
      'deploy-vercel',
      'deploy-netlify',
      'deploy-cloudflare',
      'deploy-github-pages',
      'deploy-railway',
      'deploy-supabase',
      'deploy-digitalocean',
      'frontend-visual-review',
    ]
    for (const skill of skills) expect(await readRepoFile(`config/skills/${skill}/SKILL.md`)).toContain('squad_bash')
    const [deploy, visual] = await Promise.all([
      readRepoFile('config/skills/deploy-app/SKILL.md'),
      readRepoFile('config/skills/frontend-visual-review/SKILL.md'),
    ])
    for (const content of [deploy, visual]) {
      expect(content).toContain('localhost')
      expect(content).toContain('shared runtime')
    }
    expect(visual).toContain('RUN_NAME')
    expect(visual).toContain('--name "$RUN_NAME"')
    expect(visual).toContain('tau deploy local start')
    expect(visual).toContain('port $PORT')
    expect(visual).not.toContain('--port 5173')
    expect(visual).not.toContain('http.server 5173')
    expect(visual).not.toContain('PORT=5173')
    const worktrees = await readRepoFile('config/skills/using-git-worktrees/SKILL.md')
    for (const content of [deploy, visual, worktrees]) {
      expect(content).toContain('If `squad_bash` is unavailable')
      expect(content).toContain('delegate')
    }
  })

  test('workflow skills use dynamic metadata-first paths', async () => {
    for (const skill of ['using-git-worktrees', 'work-stream-driven-development', 'roadmap-phase-loop']) {
      const content = await readRepoFile(`config/skills/${skill}/SKILL.md`)
      expect(content).toContain('squad_bash')
      expect(content).not.toMatch(/\/Users\//)
      expect(content).not.toMatch(/\/workspace(?:\/|\b)/)
    }
    const worktrees = await readRepoFile('config/skills/using-git-worktrees/SKILL.md')
    expect(worktrees).toContain('tau workstream get')
    expect(worktrees).toContain('git.worktree')
    expect(worktrees).toContain('git.branch')
    expect(worktrees).toContain('do not create a second worktree')
  })

  test('active Ficus instruction sources are shared-first', async () => {
    for (const path of [
      'docs/wiki/agent-runners.md',
      'config/agent-types/manager.yaml',
      'config/agent-types/consultant.yaml',
      'config/agent-types/sysops.yaml',
    ]) {
      const content = await readRepoFile(path)
      expect(content).toContain('squad_bash')
      expect(content).not.toMatch(/work there by default|default to it for your work|Use it ONLY when/i)
    }
    const manager = await readRepoFile('config/agent-types/manager.yaml')
    expect(manager).toContain('Run all repository/worktree git commands through `squad_bash`')
    expect(manager).not.toMatch(/If your `bash` cannot access[\s\S]*?squad_bash instead/)
    // These types retain their configured tool allow-list; skills must remain capability-aware.
  })
})
