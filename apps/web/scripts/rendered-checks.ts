/**
 * The rendered browser checks in this folder (`check-*.ts`) and what each one covers.
 *
 * CI runs a check on a pull request only when the change touches something it renders, so every
 * check must be listed here (`rendered-checks.test.ts` fails otherwise). An entry names the
 * check's fixture page; the covered paths are computed, not listed by hand: they are every file
 * the check and its fixture import, followed through the web app, the farm and the workspace
 * packages (Bun's bundler reads the graph, stylesheets included). A component, its wording or its
 * CSS changing therefore selects every check that renders it, and a new import is covered the
 * moment it is added.
 *
 * `seconds` is the check's duration on a CI runner (rounded up to 5 from a full run on 27 November
 * 2026). It only balances the CI shards; a wrong value makes a shard slower, never skips a check.
 *
 * Run them locally with `bun scripts/run-rendered-checks.ts` (see that file).
 */
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export const webRoot = resolve(import.meta.dir, '..')
export const repoRoot = resolve(webRoot, '../..')

export interface RenderedCheck {
  /** File name in apps/web/scripts. */
  script: string
  /** Fixture module the check's page loads, relative to apps/web. */
  fixture: string
  /** Rough duration on a CI runner, for balancing shards. */
  seconds: number
}

export const RENDERED_CHECKS: readonly RenderedCheck[] = [
  { script: 'check-activity-work.ts', fixture: 'scripts/fixtures/activity-work.tsx', seconds: 10 },
  { script: 'check-composer-narrow.ts', fixture: 'scripts/fixtures/composer-narrow.tsx', seconds: 95 },
  {
    script: 'check-desktop-floating-windows.ts',
    fixture: 'scripts/fixtures/desktop-floating-windows.tsx',
    seconds: 15,
  },
  { script: 'check-desktop-history.ts', fixture: 'scripts/fixtures/desktop-history.tsx', seconds: 10 },
  { script: 'check-desktop-modal.ts', fixture: 'scripts/fixtures/desktop-modal.tsx', seconds: 5 },
  { script: 'check-feed-dismiss-layout.ts', fixture: 'scripts/fixtures/feed-dismiss.tsx', seconds: 15 },
  { script: 'check-feed-updates.ts', fixture: 'scripts/fixtures/feed-updates.tsx', seconds: 15 },
  {
    script: 'check-history-search-placement.ts',
    fixture: 'scripts/fixtures/history-search-placement.tsx',
    seconds: 15,
  },
  { script: 'check-integration-rows-layout.ts', fixture: 'scripts/fixtures/integration-rows.tsx', seconds: 30 },
  { script: 'check-linear-integration-layout.ts', fixture: 'scripts/fixtures/linear-integration.tsx', seconds: 20 },
  { script: 'check-live-list-motion.ts', fixture: 'scripts/fixtures/live-list-motion.tsx', seconds: 135 },
  { script: 'check-local-bigbrain-layout.ts', fixture: 'scripts/fixtures/local-bigbrain.tsx', seconds: 15 },
  { script: 'check-managed-bigbrain-layout.ts', fixture: 'scripts/fixtures/managed-bigbrain.tsx', seconds: 20 },
  { script: 'check-markdown-prose-contrast.ts', fixture: 'scripts/fixtures/markdown-prose.tsx', seconds: 10 },
  { script: 'check-mobile-touch-targets.ts', fixture: 'scripts/fixtures/mobile-touch-targets.tsx', seconds: 10 },
  {
    script: 'check-needs-you-notifications.ts',
    fixture: 'scripts/fixtures/needs-you-notifications.tsx',
    seconds: 15,
  },
  { script: 'check-phone-reach-guide.ts', fixture: 'scripts/fixtures/phone-reach.tsx', seconds: 15 },
  { script: 'check-public-voice-setup.ts', fixture: 'scripts/fixtures/public-voice-setup.tsx', seconds: 10 },
  { script: 'check-question-recommended.ts', fixture: 'scripts/fixtures/question-recommended.tsx', seconds: 30 },
  { script: 'check-reply-suggestions-layout.ts', fixture: 'scripts/fixtures/reply-suggestions.tsx', seconds: 15 },
  { script: 'check-sandbox-processes.ts', fixture: 'scripts/fixtures/sandbox-processes.tsx', seconds: 15 },
  { script: 'check-spend-layout.ts', fixture: 'scripts/fixtures/spend.tsx', seconds: 10 },
  { script: 'check-squad-cards.ts', fixture: 'scripts/fixtures/squad-cards.tsx', seconds: 120 },
  { script: 'check-squad-chat-header-layout.ts', fixture: 'scripts/fixtures/squad-chat-header.tsx', seconds: 15 },
  { script: 'check-squad-home-clarity.ts', fixture: 'scripts/fixtures/squad-home-clarity.tsx', seconds: 35 },
  { script: 'check-storage-banner-layout.ts', fixture: 'scripts/fixtures/storage-banner.tsx', seconds: 20 },
  { script: 'check-system-logs-layout.ts', fixture: 'scripts/fixtures/system-logs.tsx', seconds: 25 },
  { script: 'check-teammates-typing-layout.ts', fixture: 'scripts/fixtures/teammates-typing.tsx', seconds: 10 },
  { script: 'check-voice-progress.ts', fixture: 'scripts/fixtures/voice-progress.tsx', seconds: 5 },
  {
    script: 'check-work-stream-dependencies-layout.ts',
    fixture: 'scripts/fixtures/work-stream-detail.tsx',
    seconds: 25,
  },
  { script: 'check-work-stream-detail-layout.ts', fixture: 'scripts/fixtures/work-stream-detail.tsx', seconds: 15 },
  { script: 'check-work-stream-rows.ts', fixture: 'scripts/fixtures/work-stream-rows.tsx', seconds: 50 },
  { script: 'check-work-stream-summaries.ts', fixture: 'scripts/fixtures/work-stream-summaries.tsx', seconds: 15 },
  { script: 'check-workflow-review-brief.ts', fixture: 'scripts/fixtures/workflow-review-brief.tsx', seconds: 105 },
  { script: 'check-workflow-review-chat.ts', fixture: 'scripts/fixtures/workflow-review-chat.tsx', seconds: 10 },
]

/**
 * Changes that can alter every check without appearing in any import graph: the runner and this
 * mapping, the shared fixture server, the browser and toolchain pins, and the build configuration
 * Vite and Tailwind read from apps/web. Repository-relative globs.
 */
export const RUN_ALL_PATTERNS = [
  '.github/workflows/ci.yml',
  '.github/rendered-checks-gate.ts',
  'apps/web/scripts/fixture-server.ts',
  'apps/web/scripts/rendered-checks.ts',
  'apps/web/scripts/run-rendered-checks.ts',
  'apps/web/package.json',
  'apps/web/tsconfig*.json',
  'apps/web/postcss.config.*',
  'apps/web/tailwind.config.*',
  'apps/web/vite.config.*',
  'apps/web/index.html',
  'apps/web/public/**',
  'apps/core/package.json',
  'apps/farm/package.json',
  'packages/*/package.json',
  'package.json',
  'bun.lock',
  '.bun-version',
  'patches/**',
] as const

export function checkByScript(script: string): RenderedCheck {
  const check = RENDERED_CHECKS.find((entry) => entry.script === script)
  if (!check) throw new Error(`${script} is not a rendered check listed in apps/web/scripts/rendered-checks.ts`)
  return check
}

/** Bare imports stay external (node_modules is not ours to watch, its pins are in RUN_ALL_PATTERNS);
 * the workspace packages resolve to their sources, so their changes count. */
const externalPackages: Bun.BunPlugin = {
  name: 'rendered-check-externals',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith('@ficus/') ? undefined : { path: args.path, external: true }
    )
  },
}

async function importGraph(entry: string, target: 'bun' | 'browser'): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [resolve(webRoot, entry)],
    target,
    metafile: true,
    throw: false,
    plugins: [externalPackages],
  })
  // Tailwind's at-rules (@tailwind, @source) are warnings to Bun's CSS parser; only errors mean the
  // graph may be incomplete.
  const errors = result.logs.filter((log) => log.level === 'error')
  if (!result.success || errors.length > 0 || !result.metafile) {
    throw new Error(`could not read the import graph of ${entry}: ${errors.map(String).join('; ') || 'no metafile'}`)
  }
  // Metafile inputs are relative to the working directory.
  return Object.keys(result.metafile.inputs).map((input) =>
    relative(repoRoot, isAbsolute(input) ? input : resolve(process.cwd(), input)).replaceAll('\\', '/')
  )
}

/** Every repository file the check and its fixture import, sorted. */
export async function coveredPaths(check: RenderedCheck): Promise<string[]> {
  const files = new Set<string>()
  for (const path of [
    ...(await importGraph(`scripts/${check.script}`, 'bun')),
    ...(await importGraph(check.fixture, 'browser')),
  ]) {
    if (path.startsWith('..') || path.includes('node_modules/')) continue
    if (existsSync(resolve(repoRoot, path))) files.add(path)
  }
  return [...files].sort()
}

export async function coverageByCheck(checks: readonly RenderedCheck[] = RENDERED_CHECKS) {
  const coverage = new Map<string, Set<string>>()
  for (const check of checks) coverage.set(check.script, new Set(await coveredPaths(check)))
  return coverage
}

export type Selection = { all: true; reason: string; checks: string[] } | { all: false; checks: string[] }

/** The checks a change needs: all of them for a RUN_ALL_PATTERNS path, otherwise every check whose
 * covered paths include a changed path. */
export function selectChecks(changedPaths: string[], coverage: Map<string, Set<string>>): Selection {
  const runAll = changedPaths.find((path) => RUN_ALL_PATTERNS.some((pattern) => new Bun.Glob(pattern).match(path)))
  if (runAll) return { all: true, reason: runAll, checks: RENDERED_CHECKS.map((check) => check.script) }
  const checks = RENDERED_CHECKS.filter((check) => {
    const covered = coverage.get(check.script)
    if (!covered) throw new Error(`no coverage computed for ${check.script}`)
    return changedPaths.some((path) => covered.has(path))
  }).map((check) => check.script)
  return { all: false, checks }
}

/** Splits checks into at most `maxShards` lists of roughly `targetSeconds` each, longest first
 * onto the least loaded shard. Every check lands in exactly one shard. */
export function planShards(scripts: string[], maxShards = 5, targetSeconds = 300): string[][] {
  if (scripts.length === 0) return []
  const checks = scripts.map(checkByScript).sort((a, b) => b.seconds - a.seconds || a.script.localeCompare(b.script))
  const total = checks.reduce((sum, check) => sum + check.seconds, 0)
  const count = Math.max(1, Math.min(maxShards, checks.length, Math.ceil(total / targetSeconds)))
  const shards = Array.from({ length: count }, () => ({ seconds: 0, scripts: [] as string[] }))
  for (const check of checks) {
    const lightest = shards.reduce((min, shard) => (shard.seconds < min.seconds ? shard : min))
    lightest.seconds += check.seconds
    lightest.scripts.push(check.script)
  }
  return shards.map((shard) => shard.scripts.sort())
}
