import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { expandTilde } from '@ficus/shared/node'
import type { Command } from 'commander'
import { apiDelete, apiGet, apiGetRaw, apiPost, apiPut } from '../client'
import { isJsonMode, output, outputError, outputTable } from '../output'

type AgentTarget = 'pi' | 'claude-code' | 'codex' | 'custom'

const SUPPORTED_SKILLS = ['ficus-memory', 'ficus', 'ficus-reviewer'] as const

type SupportedSkill = (typeof SUPPORTED_SKILLS)[number]

const PROJECT_TARGETS: Record<Exclude<AgentTarget, 'custom'>, string> = {
  pi: '.agents/skills',
  'claude-code': '.claude/skills',
  codex: '.agents/skills',
}

const GLOBAL_TARGETS: Record<Exclude<AgentTarget, 'custom'>, string> = {
  pi: '~/.pi/agent/skills',
  'claude-code': '~/.claude/skills',
  codex: '~/.codex/skills',
}

interface DynamicSkill {
  id: string
  name: string
  description?: string | null
  disabled: boolean
  updatedBy: string
  yamlDrift: boolean
  hasTemplate: boolean
}

function supportFilesFromOption(value?: string): Record<string, string> | undefined {
  return value ? JSON.parse(value) : undefined
}

async function readSkillPath(path: string): Promise<{ content: string; supportFiles: Record<string, string> }> {
  const absolute = resolve(path)
  const info = await stat(absolute)
  const skillFile = info.isDirectory() ? join(absolute, 'SKILL.md') : absolute
  const root = dirname(skillFile)
  const content = await readFile(skillFile, 'utf-8')
  const supportFiles: Record<string, string> = {}

  async function collect(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) await collect(child)
      else if (entry.isFile() && entry.name.endsWith('.md') && child !== skillFile) {
        supportFiles[relative(root, child)] = await readFile(child, 'utf-8')
      }
    }
  }
  if (info.isDirectory()) await collect(root)
  return { content, supportFiles }
}

async function contentFromOptions(options: {
  content?: string
  file?: string
  stdin?: boolean
}): Promise<string | undefined> {
  if (options.content !== undefined) return options.content
  if (options.file) return readFile(options.file, 'utf-8')
  if (options.stdin) return await new Response(Bun.stdin.stream()).text()
  return undefined
}

interface InstallOptions {
  agent?: AgentTarget
  cwd?: string
  force?: boolean
  global?: boolean
  targetDir?: string
}

function isSupportedSkill(skill: string): skill is SupportedSkill {
  return (SUPPORTED_SKILLS as readonly string[]).includes(skill)
}

function getBundledSkillDir(skill: SupportedSkill): string {
  const thisFile = fileURLToPath(import.meta.url)
  const shareDir = process.env.FICUS_SHARE_DIR ?? join(process.env.HOME ?? '', '.tau/share')
  const sourceCandidates = [
    // Running installed CLI with bundled skills copied to ~/.tau/share/skills.
    resolve(expandTilde(shareDir), 'skills', skill),
    // Running installed CLI from ~/.tau/bin/ficus with bundled skills copied to ~/.tau/share/skills.
    resolve(dirname(thisFile), '../share/skills', skill),
    // Running bundled dev CLI from apps/cli/dist/ficus.js with skills copied beside dist.
    resolve(dirname(thisFile), '../skills', skill),
    // Backward-compatible/dev fallback for assets copied beside the binary.
    resolve(dirname(thisFile), 'skills', skill),
  ]

  // Development fallback when running directly from source without building.
  sourceCandidates.push(resolve(dirname(thisFile), '../../../../external/skills', skill))

  const source = sourceCandidates.find((candidate) => existsSync(join(candidate, 'SKILL.md')))
  if (!source) {
    throw new Error(`bundled skill not found: ${skill}`)
  }
  return source
}

function shellQuoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function installMarkdownFile(sourcePath: string, targetPath: string, cliPath: string) {
  const source = await readFile(sourcePath, 'utf8')
  await writeFile(targetPath, source.replaceAll('<ficus-cli>', shellQuoteIfNeeded(cliPath)))
}

function isBunVirtualPath(path: string | undefined): boolean {
  return !!path && (path.startsWith('/$bunfs/') || path.startsWith('\\$bunfs\\'))
}

function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH ?? ''
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function normalizeInvokedPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path)
}

/**
 * How the installed skill should invoke this CLI: `ficus` when that is what
 * the shell ran (the binary, or the built ficus.js with a `ficus` also on
 * PATH), otherwise the absolute path of whatever ran, so the skill works even
 * off PATH. There is no branch for the pre-rename name: a binary still called
 * that is treated like any other path.
 */
export function invokedCliName(
  process_: { env: NodeJS.ProcessEnv; argv: readonly string[] } = { env: process.env, argv: process.argv }
): string {
  const invoked = process_.env._
  const argvPath = process_.argv[1]
  const invokedName = basename(invoked ?? '')

  if (invokedName === 'ficus') return 'ficus'
  if (invokedName === 'ficus.js' && findOnPath('ficus', process_.env)) return 'ficus'
  if (argvPath && !isBunVirtualPath(argvPath)) return normalizeInvokedPath(argvPath)
  if (findOnPath('ficus', process_.env)) return 'ficus'
  if (invoked && !isBunVirtualPath(invoked)) return normalizeInvokedPath(invoked)
  return 'ficus'
}

function resolveTargetDir(skill: SupportedSkill, options: InstallOptions): string {
  if (options.targetDir) return resolve(expandTilde(options.targetDir), skill)

  const agent = options.agent ?? 'pi'
  if (agent === 'custom') {
    throw new Error('custom agent requires --target-dir')
  }
  const root = options.global ? GLOBAL_TARGETS[agent] : join(options.cwd ?? process.cwd(), PROJECT_TARGETS[agent])
  return resolve(expandTilde(root), skill)
}

export async function installSkill(skill: string, options: InstallOptions = {}) {
  if (!isSupportedSkill(skill)) {
    throw new Error(`unsupported skill: ${skill}. Supported skills: ${SUPPORTED_SKILLS.join(', ')}`)
  }

  const source = getBundledSkillDir(skill)
  const target = resolveTargetDir(skill, options)

  if (existsSync(target)) {
    if (!options.force) {
      throw new Error(`skill already exists at ${target}. Rerun with --force to overwrite.`)
    }
    await rm(target, { recursive: true, force: true })
  }

  await mkdir(target, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  const cliPath = invokedCliName()
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => installMarkdownFile(join(source, entry.name), join(target, entry.name), cliPath))
  )

  await writeFile(
    join(target, 'SKILL.md'),
    `${await readFile(join(target, 'SKILL.md'), 'utf8')}\n## Installed Ficus CLI\n\nUse this exact Ficus CLI path in every Ficus command from this skill. Do not rely on shell variables persisting between commands.\n\n\`\`\`bash\n${shellQuoteIfNeeded(cliPath)}\n\`\`\`\n`
  )

  output(
    { skill, agent: options.agent ?? 'pi', target },
    `Installed ${skill} to ${target}\nRestart or reload your agent in this project to use it.`
  )
}

export function registerSkillCommands(program: Command) {
  const skill = program.command('skill').alias('skills').description('Manage bundled and dynamic Ficus agent skills')

  skill
    .command('install')
    .description('Install a bundled Ficus skill into the current project for an agent')
    .argument('<skill>', `Skill to install (${SUPPORTED_SKILLS.join(', ')})`)
    .requiredOption('--agent <agent>', 'Target agent: pi, claude-code, codex, or custom')
    .option('--cwd <dir>', 'Project directory. Defaults to current working directory')
    .option('--target-dir <dir>', 'Override skill parent directory')
    .option('--global', 'Install globally for the selected agent instead of into the current project')
    .option('--force', 'Overwrite an existing installed skill')
    .action(async (skillName: string, options: InstallOptions) => {
      const agent = options.agent
      if (agent !== 'pi' && agent !== 'claude-code' && agent !== 'codex' && agent !== 'custom') {
        throw new Error('invalid --agent. Expected pi, claude-code, codex, or custom.')
      }
      await installSkill(skillName, options)
    })

  skill
    .command('list')
    .description('List dynamic skills')
    .action(async () => {
      try {
        const skills = await apiGet<DynamicSkill[]>('/api/skills')
        if (isJsonMode()) return output(skills)
        outputTable(
          skills.map((s) => ({
            id: s.id,
            name: s.name,
            disabled: s.disabled ? 'yes' : 'no',
            source: s.hasTemplate ? 'template' : 'custom',
            drift: s.yamlDrift ? 'yes' : 'no',
          })),
          ['id', 'name', 'disabled', 'source', 'drift']
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  skill
    .command('get <id>')
    .alias('info')
    .description('Get dynamic skill details')
    .action(async (id) => {
      try {
        output(await apiGet(`/api/skills/${id}`))
      } catch (error) {
        outputError(error as Error)
      }
    })

  skill
    .command('create')
    .description('Create a custom dynamic skill')
    .requiredOption('--id <id>', 'Skill ID')
    .requiredOption('--name <name>', 'Display name')
    .option('--description <desc>', 'Description')
    .option('--content <markdown>', 'Skill markdown content')
    .option('--file <path>', 'Read skill markdown content from file')
    .option('--stdin', 'Read skill markdown content from stdin')
    .option('--support-files <json>', 'Support markdown files as JSON map of relative path to content')
    .action(async (options) => {
      try {
        const content = await contentFromOptions(options)
        if (!content) throw new Error('Skill content is required (--content, --file, or --stdin)')
        const result = await apiPost('/api/skills', {
          id: options.id,
          name: options.name,
          description: options.description,
          content,
          supportFiles: supportFilesFromOption(options.supportFiles),
        })

        output(result, `Created skill "${options.id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  skill
    .command('import [path]')
    .description('Import a dynamic skill from a skill folder or SKILL.md file')
    .option('--id <id>', 'Optional skill ID (otherwise derived from H1)')
    .option('--content <markdown>', 'Deprecated: skill markdown content')
    .option('--file <path>', 'Deprecated: read skill markdown content from file')
    .option('--stdin', 'Deprecated: read skill markdown content from stdin')
    .option('--support-files <json>', 'Deprecated: support markdown files as JSON map')
    .action(async (path, options) => {
      try {
        const fromPath = path ? await readSkillPath(path) : undefined
        const content = (await contentFromOptions(options)) ?? fromPath?.content
        if (!content) throw new Error('Skill path or content is required')
        const result = await apiPost('/api/skills/import', {
          id: options.id,
          content,
          supportFiles: supportFilesFromOption(options.supportFiles) ?? fromPath?.supportFiles,
        })

        output(result, 'Imported skill')
      } catch (error) {
        outputError(error as Error)
      }
    })

  skill
    .command('update <id>')
    .alias('sync')
    .description('Update a dynamic skill, optionally syncing from a skill folder or SKILL.md file')
    .option('--from <path>', 'Read SKILL.md and markdown support files from a folder or file')
    .option('--name <name>', 'New display name')
    .option('--description <desc>', 'New description')
    .option('--content <markdown>', 'New markdown content')
    .option('--file <path>', 'Read new markdown content from file')
    .option('--stdin', 'Read new markdown content from stdin')
    .option('--support-files <json>', 'Replace support markdown files as JSON map of relative path to content')
    .action(async (id, options) => {
      try {
        const existing = await apiGet<any>(`/api/skills/${id}`)
        const fromPath = options.from ? await readSkillPath(options.from) : undefined
        const content = (await contentFromOptions(options)) ?? fromPath?.content
        const result = await apiPut(`/api/skills/${id}`, {
          name: options.name ?? existing.name,
          description: options.description ?? existing.description,
          content: content ?? existing.content,
          supportFiles: supportFilesFromOption(options.supportFiles) ?? fromPath?.supportFiles ?? existing.supportFiles,
        })

        output(result, `Updated skill "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  skill
    .command('support-file <id> <path>')
    .description('Add or update one skill support file from disk')
    .option('--as <relative-path>', 'Relative support file path to store (defaults to file basename)')
    .action(async (id, path, options) => {
      try {
        const content = await readFile(path, 'utf-8')
        const storedPath = options.as ?? basename(path)
        const result = await apiPut(`/api/skills/${id}/support-file`, { path: storedPath, content })
        output(result, `Updated support file "${storedPath}" for skill "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  skill
    .command('remove-support-file <id> <relative-path>')
    .description('Remove one support file from a skill')
    .action(async (id, path) => {
      try {
        const result = await apiDelete(`/api/skills/${id}/support-file`, { path })
        output(result, `Removed support file "${path}" from skill "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  skill
    .command('delete <id>')
    .alias('rm')
    .description('Delete a custom dynamic skill')
    .action(async (id) => {
      try {
        await apiDelete(`/api/skills/${id}`)
        output({ id, deleted: true }, `Deleted skill "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })
  skill
    .command('template-diff <id>')
    .description('Show diff against repository template')
    .action(async (id) => {
      try {
        output(await apiGet(`/api/skills/${id}/template-diff`))
      } catch (error) {
        outputError(error as Error)
      }
    })
  skill
    .command('revert <id>')
    .description('Revert a template-backed skill to its repository template')
    .action(async (id) => {
      try {
        await apiPost(`/api/skills/${id}/revert-to-template`)
        output({ id, reverted: true }, `Reverted skill "${id}" to template`)
      } catch (error) {
        outputError(error as Error)
      }
    })
  skill
    .command('disable <id>')
    .description('Disable a dynamic skill')
    .action(async (id) => {
      try {
        await apiPost(`/api/skills/${id}/disable`)
        output({ id, disabled: true }, `Disabled skill "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })
  skill
    .command('enable <id>')
    .description('Enable a dynamic skill')
    .action(async (id) => {
      try {
        await apiPost(`/api/skills/${id}/enable`)
        output({ id, enabled: true }, `Enabled skill "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })
  skill
    .command('export <id>')
    .description('Export dynamic skill markdown')
    .action(async (id) => {
      try {
        console.log(await (await apiGetRaw(`/api/skills/${id}/export`)).text())
      } catch (error) {
        outputError(error as Error)
      }
    })
}
