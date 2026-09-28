import { createSquadSchema } from '@ficus/shared'

export function createHostWorkspacePathError(value: string): string | null {
  if (!value) return null
  if (value.startsWith('~')) return 'Enter the full absolute path; `~` is not expanded here.'
  if (value.endsWith('/<squad-id>') || value.endsWith('/<new squad id>')) {
    return 'Replace the squad ID placeholder with a real directory path.'
  }
  const parsed = createSquadSchema.safeParse({ name: 'name', purpose: 'purpose', hostWorkspacePath: value })
  if (parsed.success) return null
  return parsed.error.issues.find((issue) => issue.path[0] === 'hostWorkspacePath')?.message ?? 'Invalid path'
}
