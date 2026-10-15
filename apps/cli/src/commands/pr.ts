/**
 * `ficus pr attach`: put screenshots on a pull request or issue with the squad's
 * GitHub integration credential.
 *
 * `gh --attach` uploads through GitHub's user-attachments endpoint, which accepts
 * only user sessions; GitHub App installation tokens (what squads use) are
 * refused with "unsupported authentication type". Instead the files are
 * committed through the Git Data API to `<number>/` on the single orphan branch
 * `ficus/pr-assets` of the PR's own repository, so they share its visibility, and linked by the
 * commit SHA, so a later upload never changes an image already posted.
 *
 * Assets are kept for reference: nothing here ever deletes a branch or file.
 * Every commit made here carries ASSET_COMMIT_MARKER, and an existing branch
 * whose head lacks it is never changed. The credential is sent only in the
 * Authorization header and never printed.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Command } from 'commander'
import { apiPost } from '../client'
import { output, outputError } from '../output'

/** One shared, never-merged branch per repository; each PR or issue gets a `<number>/` folder. */
export const ASSET_BRANCH = 'ficus/pr-assets'
export const ASSET_COMMIT_MARKER = 'ficus pr-assets'
export const MAX_ASSET_BYTES = 10 * 1024 * 1024
export const MAX_ASSET_FILES = 20
const GITHUB_API = 'https://api.github.com'
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])

export type GitHubRequest = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface AssetFile {
  /** Path as given on the command line (without the `#alt` suffix). */
  source: string
  /** File name inside the assets branch. */
  name: string
  alt: string
  content: Uint8Array
}

export interface AttachedAsset {
  name: string
  url: string
  markdown: string
}

interface GitRef {
  object: { sha: string }
}
interface GitCommit {
  sha: string
  message: string
  tree: { sha: string }
}
interface Issue {
  number: number
  html_url: string
  body: string | null
}

/** `owner/repo` from `--repo` or a GitHub remote URL. */
export function parseRepo(value: string): string {
  const trimmed = value.trim().replace(/\.git$/, '')
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/?$/.exec(
      trimmed
    )
  if (!match || match[2] === '.' || match[2] === '..')
    throw new Error(`Not a github.com repository: ${value}. Pass --repo OWNER/REPO.`)
  return `${match[1]}/${match[2]}`
}

export function parseNumber(value: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`Not a pull request or issue number: ${value}`)
  return Number(value)
}

/** Split `path#alt` the way `gh --attach` does. */
export function parseAttachmentArg(arg: string): { source: string; alt?: string } {
  const hash = arg.lastIndexOf('#')
  if (hash <= 0) return { source: arg }
  return { source: arg.slice(0, hash), alt: arg.slice(hash + 1) || undefined }
}

export function assetFileName(source: string): string {
  const name = basename(source)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
  if (!name) throw new Error(`Cannot derive a file name from ${source}`)
  return name
}

function isImage(name: string): boolean {
  return IMAGE_EXTENSIONS.has(name.split('.').pop()?.toLowerCase() ?? '')
}

export function assetPath(number: number, name: string): string {
  return `${number}/${name}`
}

export function assetUrl(repo: string, commit: string, path: string): string {
  return `https://github.com/${repo}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}?raw=true`
}

export function assetMarkdown(file: Pick<AssetFile, 'name' | 'alt'>, url: string): string {
  const alt = file.alt.replace(/[[\]]/g, '')
  return isImage(file.name) ? `![${alt}](${url})` : `[${alt}](${url})`
}

/**
 * Rewrite `![alt](./path)` / `[text](path)` references to an attached file,
 * then append every file the body did not reference.
 */
export function composeBody(body: string, files: AssetFile[], assets: AttachedAsset[]): string {
  let result = body
  const unreferenced: string[] = []
  files.forEach((file, index) => {
    const asset = assets[index]!
    const plain = file.source.replace(/^\.\//, '')
    let referenced = false
    for (const candidate of new Set([plain, `./${plain}`])) {
      const target = `](${candidate})`
      if (result.includes(target)) {
        result = result.split(target).join(`](${asset.url})`)
        referenced = true
      }
    }
    if (!referenced) unreferenced.push(asset.markdown)
  })
  if (unreferenced.length === 0) return result
  return [result.trimEnd(), unreferenced.join('\n')].filter(Boolean).join('\n\n')
}

export async function loadAssetFiles(args: string[]): Promise<AssetFile[]> {
  if (args.length === 0) throw new Error('Name at least one file to attach')
  if (args.length > MAX_ASSET_FILES) throw new Error(`Attach at most ${MAX_ASSET_FILES} files at once`)
  const files: AssetFile[] = []
  const names = new Set<string>()
  for (const arg of args) {
    const { source, alt } = parseAttachmentArg(arg)
    const info = await stat(source).catch(() => undefined)
    if (!info?.isFile()) throw new Error(`Not a file: ${source}`)
    if (info.size === 0) throw new Error(`File is empty: ${source}`)
    if (info.size > MAX_ASSET_BYTES) throw new Error(`File is larger than 10 MB: ${source}`)
    const name = assetFileName(source)
    if (names.has(name)) throw new Error(`Two files would both be stored as ${name}; rename one`)
    names.add(name)
    files.push({ source, name, alt: alt ?? name, content: new Uint8Array(await readFile(source)) })
  }
  return files
}

function isAssetCommit(commit: Pick<GitCommit, 'message'>): boolean {
  return commit.message.startsWith(ASSET_COMMIT_MARKER)
}

async function getRef(github: GitHubRequest, repo: string, branch: string): Promise<GitRef | undefined> {
  try {
    return await github<GitRef>('GET', `/repos/${repo}/git/ref/heads/${branch}`)
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return undefined
    throw error
  }
}

const MAX_REF_UPDATE_ATTEMPTS = 5

/**
 * Commit `files` under `<number>/` on the shared ASSET_BRANCH and return
 * commit-pinned links. Other agents may advance the branch concurrently, so a
 * rejected fast-forward rebuilds the commit on the new head and tries again.
 */
export async function uploadAssets(
  github: GitHubRequest,
  repo: string,
  number: number,
  files: AssetFile[]
): Promise<{ branch: string; commit: string; assets: AttachedAsset[] }> {
  const branch = ASSET_BRANCH
  const tree: { path: string; mode: string; type: string; sha: string }[] = []
  for (let attempt = 1; ; attempt++) {
    const existing = await getRef(github, repo, branch)
    let parent: GitCommit | undefined
    if (existing) {
      parent = await github<GitCommit>('GET', `/repos/${repo}/git/commits/${existing.object.sha}`)
      if (!isAssetCommit(parent))
        throw new Error(`${repo} branch ${branch} was not created by ficus pr attach; refusing to change it`)
    }
    // Upload the blobs once, after the branch passed the check above.
    if (tree.length === 0)
      for (const file of files) {
        const blob = await github<{ sha: string }>('POST', `/repos/${repo}/git/blobs`, {
          content: Buffer.from(file.content).toString('base64'),
          encoding: 'base64',
        })
        tree.push({ path: assetPath(number, file.name), mode: '100644', type: 'blob', sha: blob.sha })
      }
    const newTree = await github<{ sha: string }>('POST', `/repos/${repo}/git/trees`, {
      ...(parent ? { base_tree: parent.tree.sha } : {}),
      tree,
    })
    const commit = await github<{ sha: string }>('POST', `/repos/${repo}/git/commits`, {
      message: `${ASSET_COMMIT_MARKER}: attachments for #${number}\n\nNot for merge. Kept for reference.`,
      tree: newTree.sha,
      parents: parent ? [parent.sha] : [],
    })
    try {
      if (existing) await github('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false })
      else await github('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
    } catch (error) {
      // 422: the branch moved (not a fast-forward) or was created meanwhile.
      if (error instanceof GitHubError && error.status === 422 && attempt < MAX_REF_UPDATE_ATTEMPTS) continue
      throw error
    }
    return {
      branch,
      commit: commit.sha,
      assets: files.map((file) => {
        const url = assetUrl(repo, commit.sha, assetPath(number, file.name))
        return { name: file.name, url, markdown: assetMarkdown(file, url) }
      }),
    }
  }
}

export function createGitHubRequest(token: string, fetcher: typeof fetch = fetch): GitHubRequest {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetcher(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const detail = await response
        .json()
        .then((json: { message?: string }) => json.message)
        .catch(() => undefined)
      throw new GitHubError(
        response.status,
        `GitHub ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`
      )
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}

export interface PrCommandDependencies {
  /** GitHub client authenticated with the squad's integration credential. */
  github: (options: { squad?: string; connection?: string }) => Promise<GitHubRequest>
  /** `owner/repo` of the current directory's origin remote. */
  originRepo: () => Promise<string>
  readBodyFile: (path: string) => Promise<string>
}

async function integrationGitHub(options: { squad?: string; connection?: string }): Promise<GitHubRequest> {
  const squad = options.squad ?? process.env.FICUS_SQUAD_ID
  if (!squad) throw new Error('Pass --squad (FICUS_SQUAD_ID is not set)')
  const { environment } = await apiPost<{ environment: Record<string, string> }>(
    `/api/squads/${encodeURIComponent(squad)}/integrations/github/execute-environment`,
    options.connection ? { connectionId: options.connection } : {}
  )
  const token = environment?.GH_TOKEN
  if (!token) throw new Error('This squad has no GitHub integration credential')
  return createGitHubRequest(token)
}

async function gitOriginRepo(): Promise<string> {
  const child = Bun.spawn(['git', 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'ignore' })
  const url = (await new Response(child.stdout).text()).trim()
  if ((await child.exited) !== 0 || !url) throw new Error('No origin remote here; pass --repo OWNER/REPO')
  return parseRepo(url)
}

const defaultDependencies: PrCommandDependencies = {
  github: integrationGitHub,
  originRepo: gitOriginRepo,
  readBodyFile: (path) => (path === '-' ? new Response(Bun.stdin.stream()).text() : readFile(path, 'utf8')),
}

export function registerPrCommands(program: Command, dependencies: PrCommandDependencies = defaultDependencies): void {
  const pr = program
    .command('pr')
    .description('Pull request helpers that use the squad GitHub integration (screenshots on PRs)')

  pr.command('attach <number> <files...>')
    .description(
      'Attach screenshots or recordings to a pull request or issue: commits them to <number>/ on the orphan branch ficus/pr-assets of the same repository (kept permanently), then posts a comment showing them (links are pinned to the commit). Use PATH#ALT for alt text; a ![alt](./PATH) reference in the body is replaced by the uploaded file, other files are appended. Replaces gh --attach, which GitHub App credentials cannot use.'
    )
    .option('-R, --repo <owner/repo>', 'Repository (default: the origin remote of the current directory)')
    .option('-b, --body <text>', 'Comment text')
    .option('-F, --body-file <path>', 'Read comment text from a file ("-" for stdin)')
    .option('--edit-body', 'Append to the pull request or issue description instead of posting a comment')
    .option('--no-comment', 'Only upload and print the Markdown; post nothing')
    .option('--squad <uuid>', 'Squad whose GitHub integration to use (default: $FICUS_SQUAD_ID)')
    .option('--connection <uuid>', 'Use a specific attached GitHub account')
    .action(
      run(async (numberArg: string, fileArgs: string[], options) => {
        const number = parseNumber(numberArg)
        const repo = options.repo ? parseRepo(options.repo) : await dependencies.originRepo()
        if (options.body !== undefined && options.bodyFile !== undefined)
          throw new Error('Use either --body or --body-file')
        if (!options.comment && (options.body !== undefined || options.bodyFile !== undefined || options.editBody))
          throw new Error('--no-comment cannot be combined with --body, --body-file or --edit-body')
        const files = await loadAssetFiles(fileArgs)
        const body =
          options.bodyFile !== undefined ? await dependencies.readBodyFile(options.bodyFile) : (options.body ?? '')
        const github = await dependencies.github(options)
        const issue = await github<Issue>('GET', `/repos/${repo}/issues/${number}`).catch((error) => {
          if (error instanceof GitHubError && error.status === 404)
            throw new Error(
              `No pull request or issue ${number} in ${repo} (or the squad's GitHub account cannot see it)`
            )
          throw error
        })
        const upload = await uploadAssets(github, repo, number, files)
        const markdown = composeBody(body, files, upload.assets)
        let posted: string | undefined
        if (options.comment && options.editBody) {
          const description = [issue.body?.trimEnd(), markdown].filter(Boolean).join('\n\n')
          posted = (await github<Issue>('PATCH', `/repos/${repo}/issues/${number}`, { body: description })).html_url
        } else if (options.comment) {
          posted = (
            await github<{ html_url: string }>('POST', `/repos/${repo}/issues/${number}/comments`, { body: markdown })
          ).html_url
        }
        output(
          { repo, number, ...upload, markdown, ...(posted ? { posted } : {}) },
          posted ? `Posted ${posted}` : markdown
        )
      })
    )
}

function run<T extends unknown[]>(handler: (...args: T) => Promise<void>): (...args: T) => Promise<void> {
  return async (...args) => {
    try {
      await handler(...args)
    } catch (error) {
      outputError(error as Error)
    }
  }
}
