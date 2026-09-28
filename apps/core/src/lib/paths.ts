import { join, resolve } from 'path'
import { expandTilde } from '@ficus/shared/node'

// During tests run from the monorepo root, process.cwd() is the monorepo root,
// while during normal operation, process.cwd() is the core app root.
//
// `FICUS_ROOT` takes precedence when set (the units point it at
// `/opt/tau-core/current`): a prebuilt-artifact box activates a new release by
// flipping the `current` symlink, and inferring the root from cwd through a
// symlink being renamed in flight could resolve to a stale/partial tree. An
// explicit anchor removes that ambiguity; unset, the cwd rule is unchanged.
//
// `resolve()` absolutizes a relative override against cwd: Bun auto-loads
// `./.env` before any of this code runs, so a stray relative `FICUS_ROOT=` line
// left in a repo-root `.env` would otherwise redirect every config path
// wherever the process happened to be started from.
const inferredMonorepoRoot = join(process.cwd().split('apps/core')[0])
export const MONOREPO_ROOT = process.env.FICUS_ROOT
  ? resolve(expandTilde(process.env.FICUS_ROOT))
  : inferredMonorepoRoot
export const CONFIG_DIR = join(MONOREPO_ROOT, 'config')

export const AGENT_DIR = join(CONFIG_DIR, 'agent')
export const WEBHOOKS_DIR = join(CONFIG_DIR, 'webhooks')
export const NOTIFICATIONS_DIR = join(CONFIG_DIR, 'notifications')
export const AGENT_TYPES_DIR = join(CONFIG_DIR, 'agent-types')
/** Shared prompt blocks that agent types list under `includes:`. */
export const AGENT_TYPE_SHARED_PROMPTS_DIR = join(AGENT_TYPES_DIR, 'shared')
export const MODEL_TIERS_DIR = join(CONFIG_DIR, 'model-tiers')
export const SQUAD_PRESETS_DIR = join(CONFIG_DIR, 'squad-presets')
export const WORKFLOWS_DIR = join(CONFIG_DIR, 'workflows')
export const CHANNELS_DIR = join(CONFIG_DIR, 'channels')

export const SKILLS_DIR = join(CONFIG_DIR, 'skills')
export const EXTENSIONS_DIR = join(AGENT_DIR, 'extensions')
