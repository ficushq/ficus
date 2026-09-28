/**
 * Git Sync Adapter
 *
 * Handles Git operations for memory sync:
 * - Clone/pull from remote repository
 * - Push local changes to remote
 * - Conflict detection and handling
 *
 * Uses squad SSH keys for authentication.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readdirSync, rmSync, renameSync } from 'fs'
import { join } from 'path'
import { ensureSquadMemoryPath } from '../paths'
import { getSquadSshPath } from '../../squad/ssh'
import * as squadSsh from '../../squad/ssh'
import type { GitSyncConfig, SyncAdapter, SyncPullResult, SyncPushResult } from './types'

const execAsync = promisify(exec)

interface GitStatus extends Record<string, unknown> {
  initialized: boolean
  branch: string | null
  hasChanges: boolean
  ahead: number
  behind: number
  lastCommit: string | null
}

export class GitAdapter implements SyncAdapter {
  private squadId: string
  private config: GitSyncConfig
  private memoryPath: string

  constructor(squadId: string, config: GitSyncConfig) {
    this.squadId = squadId
    this.config = config
    this.memoryPath = ensureSquadMemoryPath(squadId)
  }

  /**
   * Validate git config before use.
   */
  static validateConfig(config: GitSyncConfig): void {
    // Validate URL format
    const urlPatterns = [
      /^git@[\w.-]+:[\w./-]+\.git$/, // SSH format
      /^https?:\/\/[\w.-]+\/[\w./-]+\.git$/, // HTTPS format
      /^ssh:\/\/[\w.-]+\/[\w./-]+\.git$/, // SSH URL format
    ]

    const isValidUrl = urlPatterns.some((pattern) => pattern.test(config.repoUrl))
    if (!isValidUrl) {
      throw new Error('Invalid git URL format. Expected SSH (git@...) or HTTPS (https://...) URL')
    }

    // Validate branch name (no spaces or special chars except - and /)
    if (!/^[\w./-]+$/.test(config.branch)) {
      throw new Error('Invalid branch name')
    }

    // SSH key name required for SSH URLs
    if (config.repoUrl.startsWith('git@') && !config.sshKeyName) {
      throw new Error('SSH key name is required for SSH git URLs')
    }
  }

  /**
   * Build git command with SSH config.
   */
  private buildGitEnv(): Record<string, string> {
    const sshPath = getSquadSshPath(this.squadId)
    const keyPath = squadSsh.ensurePrivateSshKeyPermissions(this.squadId, this.config.sshKeyName)
    const knownHostsPath = join(sshPath, 'known_hosts')

    // Build SSH command with our key and known hosts
    const sshCommand = `ssh -i "${keyPath}" -o UserKnownHostsFile="${knownHostsPath}" -o StrictHostKeyChecking=accept-new`

    return {
      ...process.env,
      GIT_SSH_COMMAND: sshCommand,
      GIT_TERMINAL_PROMPT: '0', // Disable prompts
    }
  }

  /**
   * Execute a git command in the memory directory.
   */
  private async git(command: string): Promise<{ stdout: string; stderr: string }> {
    const env = this.buildGitEnv()
    return execAsync(`git ${command}`, {
      cwd: this.memoryPath,
      env,
      timeout: 60000, // 60 second timeout
    })
  }

  /**
   * Check if git repo is initialized.
   */
  async isInitialized(): Promise<boolean> {
    return existsSync(join(this.memoryPath, '.git'))
  }

  /**
   * Initialize the repository (clone if needed).
   * Handles empty remote repos by initializing locally and pushing.
   */
  async initialize(): Promise<{ success: boolean; error?: string }> {
    try {
      if (await this.isInitialized()) {
        // Already initialized, just fetch
        await this.git('fetch origin')
        return { success: true }
      }

      // Ensure memory directory exists
      mkdirSync(this.memoryPath, { recursive: true })

      // Try to clone the repository.
      // We clone into a temp directory first, then move the .git folder
      // into the memory path. This handles the case where the memory folder
      // already exists (created on boot) and may contain pre-existing files
      // (e.g. from switching sync providers or adding sync after use).
      const env = this.buildGitEnv()
      const tmpClonePath = `${this.memoryPath}.clone-tmp`
      try {
        // Clean up any leftover tmp dir from a previous failed attempt
        if (existsSync(tmpClonePath)) {
          rmSync(tmpClonePath, { recursive: true })
        }

        await execAsync(`git clone --branch ${this.config.branch} "${this.config.repoUrl}" "${tmpClonePath}"`, {
          env,
          timeout: 120000, // 2 minute timeout for clone
        })

        // Move .git directory from temp clone into memory path
        const destGit = join(this.memoryPath, '.git')
        if (existsSync(destGit)) {
          rmSync(destGit, { recursive: true })
        }
        renameSync(join(tmpClonePath, '.git'), destGit)

        // Copy cloned files (not .git) into memory path, without overwriting existing files
        const clonedEntries = readdirSync(tmpClonePath)
        for (const entry of clonedEntries) {
          const src = join(tmpClonePath, entry)
          const dest = join(this.memoryPath, entry)
          if (!existsSync(dest)) {
            renameSync(src, dest)
          }
        }

        // Clean up temp directory
        rmSync(tmpClonePath, { recursive: true })

        return { success: true }
      } catch (cloneError) {
        const errorMsg = (cloneError as Error).message

        // Check if this is an empty repo (branch not found)
        if (errorMsg.includes('Remote branch') && errorMsg.includes('not found')) {
          return this.initializeEmptyRepo(env)
        }

        // Re-throw other errors
        throw cloneError
      }
    } catch (e) {
      const error = e as Error
      return { success: false, error: error.message }
    }
  }

  /**
   * Initialize a new repo when remote is empty.
   */
  private async initializeEmptyRepo(env: Record<string, string>): Promise<{ success: boolean; error?: string }> {
    try {
      // Initialize empty git repo
      await execAsync('git init', {
        cwd: this.memoryPath,
        env,
      })

      // Add remote
      await execAsync(`git remote add origin "${this.config.repoUrl}"`, {
        cwd: this.memoryPath,
        env,
      })

      // Create initial branch
      await execAsync(`git checkout -b ${this.config.branch}`, {
        cwd: this.memoryPath,
        env,
      })

      // Create initial README
      const { writeFileSync } = await import('fs')
      writeFileSync(join(this.memoryPath, 'README.md'), '# Memory\n\nThis repository stores squad memory for Ficus.\n')

      // Commit and push
      await execAsync('git add -A', { cwd: this.memoryPath, env })
      await execAsync('git commit -m "Initialize memory repository"', {
        cwd: this.memoryPath,
        env,
      })
      await execAsync(`git push -u origin ${this.config.branch}`, {
        cwd: this.memoryPath,
        env,
        timeout: 60000,
      })

      return { success: true }
    } catch (e) {
      const error = e as Error
      return { success: false, error: `Failed to initialize empty repo: ${error.message}` }
    }
  }

  /**
   * Pull changes from remote.
   */
  async pull(): Promise<SyncPullResult> {
    try {
      // Initialize if needed
      if (!(await this.isInitialized())) {
        const initResult = await this.initialize()
        if (!initResult.success) {
          return { success: false, error: initResult.error }
        }
        // Count files after initial clone
        const filesChanged = await this.countFiles()
        return { success: true, filesChanged, conflicts: [] }
      }

      // Stash any local changes first
      await this.git('stash --include-untracked').catch(() => {})

      // Fetch and check for conflicts
      await this.git('fetch origin')

      // Check if we can fast-forward
      const { stdout: mergeBase } = await this.git(`merge-base HEAD origin/${this.config.branch}`)
      const { stdout: localHead } = await this.git('rev-parse HEAD')
      const { stdout: remoteHead } = await this.git(`rev-parse origin/${this.config.branch}`)

      const localTrimmed = localHead.trim()
      const remoteTrimmed = remoteHead.trim()
      const baseTrimmed = mergeBase.trim()

      let filesChanged = 0
      const conflicts: string[] = []

      if (localTrimmed === remoteTrimmed) {
        // Already up to date
        filesChanged = 0
      } else if (baseTrimmed === localTrimmed) {
        // Can fast-forward
        const { stdout: diffstat } = await this.git(`diff --stat ${localTrimmed}..${remoteTrimmed}`)
        filesChanged = diffstat.split('\n').filter((l) => l.includes('|')).length

        await this.git(`merge --ff-only origin/${this.config.branch}`)
      } else {
        // Need to merge - this may have conflicts
        try {
          const { stdout: diffstat } = await this.git(`diff --stat ${localTrimmed}..${remoteTrimmed}`)
          filesChanged = diffstat.split('\n').filter((l) => l.includes('|')).length

          await this.git(`merge origin/${this.config.branch}`)
        } catch (e) {
          // Check for merge conflicts
          const { stdout: unmerged } = await this.git('diff --name-only --diff-filter=U').catch(() => ({ stdout: '' }))
          if (unmerged) {
            conflicts.push(
              ...unmerged
                .split('\n')
                .filter(Boolean)
                .map((f) => `/memory/${f}`)
            )
          }
          // Abort the merge on conflict
          if (conflicts.length > 0) {
            await this.git('merge --abort').catch(() => {})
          }
        }
      }

      // Pop stash if we had changes
      await this.git('stash pop').catch(() => {})

      return { success: true, filesChanged, conflicts }
    } catch (e) {
      const error = e as Error
      return { success: false, error: error.message }
    }
  }

  /**
   * Push local changes to remote.
   */
  async push(): Promise<SyncPushResult> {
    try {
      if (!(await this.isInitialized())) {
        return { success: false, error: 'Repository not initialized' }
      }

      // Check for uncommitted changes
      const { stdout: status } = await this.git('status --porcelain')
      const changedFiles = status.split('\n').filter(Boolean)

      if (changedFiles.length === 0) {
        return { success: true, filesPushed: 0 }
      }

      // Stage all changes
      await this.git('add -A')

      // Commit changes
      const timestamp = new Date().toISOString()
      await this.git(`commit -m "Memory sync: ${timestamp}"`)

      // Push to remote
      await this.git(`push origin ${this.config.branch}`)

      return { success: true, filesPushed: changedFiles.length }
    } catch (e) {
      const error = e as Error
      return { success: false, error: error.message }
    }
  }

  /**
   * Get status of the git sync.
   */
  async getStatus(): Promise<GitStatus> {
    if (!(await this.isInitialized())) {
      return {
        initialized: false,
        branch: null,
        hasChanges: false,
        ahead: 0,
        behind: 0,
        lastCommit: null,
      }
    }

    try {
      const { stdout: branch } = await this.git('rev-parse --abbrev-ref HEAD')
      const { stdout: status } = await this.git('status --porcelain')
      const { stdout: log } = await this.git('log -1 --format=%H')
      const { stdout: aheadBehind } = await this.git(
        `rev-list --left-right --count HEAD...origin/${this.config.branch}`
      ).catch(() => ({ stdout: '0\t0' }))

      const [ahead, behind] = aheadBehind.trim().split('\t').map(Number)

      return {
        initialized: true,
        branch: branch.trim(),
        hasChanges: status.trim().length > 0,
        ahead: ahead || 0,
        behind: behind || 0,
        lastCommit: log.trim() || null,
      }
    } catch (e) {
      return {
        initialized: true,
        branch: null,
        hasChanges: false,
        ahead: 0,
        behind: 0,
        lastCommit: null,
      }
    }
  }

  /**
   * Count files in the memory directory.
   */
  private async countFiles(): Promise<number> {
    let count = 0
    const walk = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.git') continue
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.name.endsWith('.md')) {
          count++
        }
      }
    }
    try {
      walk(this.memoryPath)
    } catch {
      // Directory might not exist
    }
    return count
  }
}
