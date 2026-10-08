# Project Rules

## Package Manager

Use **Bun** exclusively. Do not use npm or yarn.

```bash
bun install           # install dependencies
bun run test          # run package test entrypoints with isolation/completion checks
bun run build         # build all packages (core and web)
bun run build:core    # build core package
bun run build:web     # build web package
bun run reload        # reload all processes (core and web)
bun run reload:api    # reload API process
bun run reload:worker # reload worker process
bun run reload:web    # reload web process
bun run lint          # lint code
bun run format        # format code
bun typecheck         # typecheck code
```

### Procedure

When you make changes, ensure they are properly formatted and the typechecks
pass.

```bash
bun format       # format code
bun typecheck    # typecheck code
```

## Database

### Schema changes

Edit the schema in `apps/core/src/db/schema.ts`, then generate migrations:

```bash
bun db:generate      # generates migration SQL from schema diff
```

**Never write migration SQL files by hand.** Always use `bun db:generate` — it reads the schema and produces correct, timestamped migrations in `apps/core/drizzle/`.

### Running migrations

Migrations run automatically on API startup. To run manually:

```bash
FICUS_MIGRATE_LIVE=1 bun db:migrate  # deliberately migrate the root .env database
DATABASE_URL=postgres://... bun db:migrate  # migrate an explicit test/scratch database
bun db:push                         # push schema directly (dev only, no migration files)
```

Never rely on an inherited root `.env` for scratch/test migrations. The runner requires either an explicit non-root `DATABASE_URL` or the exact deliberate live-migration confirmation above.

## Testing

Tests use an isolated Postgres instance running in Docker (separate from the dev DB). The test preload (`apps/core/src/test-setup.ts`) automatically:

- Allocates a free port (no hardcoded ports)
- Starts a uniquely-named Docker container per worktree
- Pushes the current schema before tests run

When Docker cannot start the test DB, a direct local `bun test` still runs
database-free files; every database use fails with `Core test database
unavailable (...)`. CI and `bun run --filter core test` (via
`FICUS_TEST_REQUIRE_DB=1`) keep exiting instead.

For the full Core suite (including its isolated subprocess files), run:

```bash
bun run --filter core test
```

Multiple worktrees can run tests in parallel — each gets its own isolated
container. No manual setup needed.

If the tests hang on DB connection or schema push, try resetting the test DB:

```bash
bun run test:db:down && bun run --filter core test
```

### Writing tests without flakes, contention, or hidden timeouts

- The root `bun run test` waits for this worktree's database before launching
  package scripts concurrently. Preserve that readiness dependency so suites
  cannot race container startup.
- Run package suites with `bun run --filter <package> test` from the root (for
  example, `core`, `cli`, or `@ficus/sandbox-server`). These
  entrypoints own isolation and completion checks. Use `bun test <file>` for
  focused diagnosis, not as a replacement for the package/CI contract. A zero
  exit alone is not proof: require the final summary, zero failures, and every
  discovered file. Never remove completion guards or accept a signal/null exit.
- Prefer injected clients, clocks, and schedulers over global replacement.
  `mock.restore()` does **not** reset a `mock()` function's implementation or
  undo Bun's process-wide `mock.module()` replacements. Reset both behavior and
  call history explicitly; restore spies, environment variables, and clocks in
  `finally`/`afterEach`. Core's runner isolates files containing `mock.module`;
  do not hide replacements in an imported helper that escapes that detection.
  Prove suspected order leaks in isolation, in a mixed cohort, and reversed.
- Await a meaningful readiness boundary: listening socket, watcher `ready`,
  database lock acquisition, rendered effect, or fixture handshake. Never use a
  blind sleep to make setup “probably ready.” For timer behavior, advance an
  owned clock/scheduler and assert the actual deadline/reset; do not assert
  subsecond host wall-clock latency around database or subprocess work. Use the
  database clock for leases created/expired by SQL. Choose fixture timestamps
  **after** creating the state they must follow.
- Every fixture owns its resources. Use unique `mkdtemp` directories and
  OS-assigned ports; canonicalize temporary roots with `realpath` when comparing
  physical paths (macOS `/var` and `/private/var` alias). Resolve dependencies
  from the importing package, never an assumed root `node_modules` layout.
  Keep generated bundles/build-info/output in per-case directories.
  Artifact fixtures must vendor their declared runtime dependencies and disable
  automatic installs in spawned Bun commands (`--no-install`); a warm global
  package cache or network connection must not be an implicit fixture.
- Track the exact child/session, sockets, watchers, timers, and DB rows created
  by a test. Drain piped stdout/stderr concurrently, retain diagnostics, close
  accepted sockets before awaiting server shutdown, terminate and await owned
  children, and await cleanup even on assertion failure. Never use broad
  process-name kills, fixed shared output paths, or another worktree's database.
  Reset only this worktree's disposable test DB after an interrupted DB suite;
  orphan sweeping is explicit maintenance (`FICUS_TEST_SWEEP_ORPHANS=1`), not a
  normal test side effect.
- Stress/load generators are owned fixtures too. Bound their worker count and
  runtime, retain every PID, and terminate/reap them in `finally` or a shell
  trap on success, failure, and interruption. Never leave untracked background
  `yes` processes or busy loops running. Record machine load alongside timings;
  abandoned stressors can invalidate otherwise useful performance evidence.
- Keep real-process tests in `.github/workflows/ci.yml`'s subprocess inventory;
  `.github/subprocess-lane-gate.test.ts` and `.github/core-test-plan.test.ts`
  enforce membership and disjoint execution. Sandbox files run sequentially
  in fresh processes. Do not introduce
  unbounded parallelism or concurrent cases that mutate one database/global.
  Core's sequential isolated runner reuses schema setup only while both source
  inputs and the live PostgreSQL DDL fingerprint match; do not bypass its drift
  check or manually set `FICUS_TEST_SCHEMA_CACHE_FILE` in fixtures.
- The default timeout is a budget, not a contention workaround. Longer genuine
  integration budgets need a reason at the test site. No blanket retries,
  timeout increases, broad platform skips, or weakened assertions to turn red
  green. Keep Linux-specific assertions enforced on Linux; explain only narrow
  unsupported-platform skips. Add a named regression that fails when the
  corrected defect is restored, then repeat it within the unchanged budget.
- Validate on the affected platform and report the actual commands, completed
  test counts, and timings. An interrupted, skipped, or unexecuted lane is not
  passing evidence. Format changes and run typechecks before handoff.

## Monorepo Structure

- `apps/core` — API server and worker (Hono/Bun)
- `apps/web` — Frontend (Vite/React)
- `apps/cli` — CLI tool (Commander.js)
- `packages/shared` — Shared types and utilities

Run commands from the repo root. Use `bun run --filter <package>` for package-specific commands.

## TypeScript

Do not use global `tsc`. To check CLI compilation:

```bash
bun run build:cli
```

## React Query

Always use centralized query options from `queryOptions.ts` instead of inline `queryKey`/`queryFn`:

```tsx
// ✅ Good — use queries from queryOptions.ts
import { queries } from '../../queryOptions'

const { data } = useQuery(queries.agents.detail(agentId))

// ❌ Bad — inline queryKey/queryFn
const { data } = useQuery({
  queryKey: ['agents', agentId],
  queryFn: () => fetchAgent(agentId),
})
```

**Adding new queries:**

1. Add the query key to `queryKeys.ts`
2. Add the query option factory to `queryOptions.ts`
3. Add invalidation logic to `QueryInvalidator.tsx` if needed

This ensures consistent cache keys and makes invalidation predictable.

## Style

For changes to `apps/web`, read and follow the [webapp design guide](docs/wiki/web-ui.md).
It defines the visual language, layout hierarchy, responsive behavior, accessibility,
and interaction patterns for the webapp.

- Use `clsx` for conditional class names.

### Theme colors

Every color in `apps/web` comes from theme tokens, so it follows the selected
theme (Ficus by default, Iris, Harbor, Ember, High contrast, or a custom theme) in
light and dark.

- Use semantic token utilities and the `ficus-*` component classes (`bg-surface`,
  `text-primary`, `text-on-accent`, `border-th-border`,
  `text-status-danger-600`, ...). Never use Tailwind palette utilities
  (`text-red-600`, `bg-white`, `text-black`), literal colors (`#fff`, `rgb()`)
  or unreviewed inline color styles in components, CSS or canvas code.
- `apps/web/src/no-raw-colors.test.ts` fails the web test gate on any of these.
  Fix the color; do not add an exception. Its few exceptions cover content and
  definitions only and are capped at their current matches.
- A new color is a new token: add it to `THEME_TOKEN_FAMILIES` in
  `packages/shared/src/theme-schema.ts` and define it for every built-in theme
  and appearance (`apps/web/src/index.css`, `apps/web/src/theme/builtins.css`).
  The token coverage and parity tests in `apps/web/src/theme/` enforce this.
- Read colors in JS (charts, graphs, canvas, terminal) through
  `useThemeColors` / `tokenReader`, never hard-coded values.
- After changing built-in theme CSS or anything the pre-paint script imports,
  run `bun apps/web/scripts/generate-theme-flash.ts` and commit
  `apps/web/index.html`; a test fails when it is stale.
- Details: [web themes](docs/wiki/theme/README.md); adding a new built-in theme has its own checklist: [Adding a built-in theme](docs/wiki/theme/builtins.md#adding-a-built-in-theme).

### Shared components

Before building a control in `apps/web`, use the shared one. Hand-rolled
copies drift in look, keyboard behaviour and accessibility. If a shared
component almost fits, extend it rather than forking it.

| Need                                                                                       | Use (`apps/web/src/components/`)                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A single choice among a few options in a row (view switcher, mode, scope, range)           | `SegmentedControl` (`size="compact"` in toolbars and headers)                                                                                                                   |
| A popup anchored to a button or field (menu, picker, panel, hover card, autocomplete list) | `Popover` and its variants in `popover/` (`Menu`, `Picker`, `Panel`, `HoverCard`, `ComboboxList`; see `popover/Popover.md`), never hand-rolled positioning, portal or dismissal |
| A dropdown to pick one value                                                               | `SelectionPopup` (`ThemedPopup.tsx`, a trigger + `Picker`) for new pickers, not a custom listbox (some older forms still use a native `<select>`)                               |
| A menu of actions, or in-app section navigation from a button                              | `ActionPopup` (`ThemedPopup.tsx`, a trigger + `Menu`), or `Menu` + `MenuItem` for custom rows                                                                                   |
| A "…" overflow of row actions                                                              | `OverflowMenu` (a `Menu` over plain buttons)                                                                                                                                    |
| A dialog or sheet                                                                          | `Modal` (follows the visual viewport on mobile; never position your own fixed overlay)                                                                                          |
| A destructive action that needs a second tap                                               | `ConfirmButton`                                                                                                                                                                 |
| A status or label pill                                                                     | `Badge` (and `WorkStreamStatusBadges` for work stream state)                                                                                                                    |
| Loading placeholders                                                                       | `LoadingContent` and the skeletons in `loading/Skeleton.tsx`                                                                                                                    |
| A button                                                                                   | `ficus-button` plus exactly one variant (see Buttons below); `ConfirmButton` for a two-tap destructive action                                                                   |
| Fields, nav items and tables                                                               | the `ficus-field`, `ficus-nav-item` and `ficus-table` classes                                                                                                                   |
| Icons                                                                                      | `components/icons` (see Icons below)                                                                                                                                            |
| Colors in JS                                                                               | `useThemeColors` / `tokenReader` (see Theme colors above)                                                                                                                       |

Any new floating UI must dismiss through `usePopupDismiss` (`hooks/usePopupDismiss.ts`) and be tap-tested
with the WebKit tap helper (`test/webkitTap.ts`); the `Popover` variants already do both. The guard tests
`components/popover.guard.test.ts` and `components/popupDismissal.guard.test.ts` enforce it.

#### Buttons

`ficus-button` is only a base (radius, weight, transitions): it has no fill and no border, so a padded
`ficus-button` on its own renders as indented text that only shows a background on hover. Always pair it
with exactly one variant from `design-system.css`; `components/buttonVariants.guard.test.ts` fails any
className that carries the base without one (or with two, or a variant without the base). Pick the
variant by role:

| Variant                  | Use for                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ficus-button-primary`   | The one main action of a page, dialog or form (Save, Approve, Connect, Send).                                                                                                                                                 |
| `ficus-button-secondary` | Standalone actions in content: card CTAs ("Review and decide", "View"), row actions shown as buttons, "Mark all read", a dialog's Cancel. Visible at rest.                                                                    |
| `ficus-button-ghost`     | Only icon-only buttons, and compact controls inside a toolbar, header, menu or segmented cluster whose chrome already reads as controls. A text-only ghost standing alone in content is the bug: make it secondary or a link. |
| `ficus-button-link`      | Inline text actions in running text or a section header ("Dismiss", "Retry", "Edit"). No horizontal padding (the guard checks), so nothing looks indented.                                                                    |
| `ficus-button-danger`    | Destructive actions (Delete, Remove, Revoke, Disconnect, Stop): secondary-shaped with danger text. A destructive icon-only button stays ghost with a `hover:text-status-danger-*` tint.                                       |

Variants own the color, fill and hover; utilities add size and layout. A `hover:` utility still wins
over a variant's hover, so a tinted or active state can keep its look. Choose the variant dynamically
with a ternary among variants (`active ? 'ficus-button-primary' : 'ficus-button-secondary'`), never by
adding or dropping one, and write shared class constants with the base and the variant together.

### Stable Refs

Use `useStableRef` from `hooks/useStableRef` whenever you need to read a
changing prop/state inside a callback or effect without adding it to dependency
arrays. This prevents stale closure bugs and flickering issues.

```tsx
import { useStableRef } from '../hooks/useStableRef'

const onCloseRef = useStableRef(onClose)

useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onCloseRef.current()
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}, []) // no need to depend on onClose
```

**Do not** manually write the `useRef` + `useLayoutEffect` pattern — always use `useStableRef` instead.

### Icons

All SVG icons live in `apps/web/src/components/icons/`, one component per file.

- **One icon per file.** Create `IconName.tsx` exporting a single named function (e.g. `export function FooIcon`).
- **Re-export from the barrel.** Add `export { FooIcon } from './FooIcon'` to `index.tsx` (alphabetical order).
- **Use the shared `IconProps` interface.** Every icon takes `{ className?: string }` with a sensible default (usually `'w-5 h-5'`).
- **Never inline SVGs in components.** Import icons from `./icons` (or `../components/icons`) instead.
- **Use `currentColor`.** Icons should inherit color via `fill="currentColor"` or `stroke="currentColor"` so the parent can control color with Tailwind text classes.

## Browser Tools Login

Browser authentication uses an HttpOnly session cookie. Writing `ficus_password`
to localStorage does not establish the current browser session and is not a
login bypass.

- For an existing instance, use an already authenticated browser profile or
  sign in through the normal passkey flow on that instance's configured origin.
- For a fresh local test instance, follow [first-admin setup](docs/wiki/setup.md#first-admin):
  use the setup-generated bootstrap link or the password form, then complete
  registration and create the administrator passkey. The bootstrap password
  stops being accepted once an administrator has a passkey.
- When using `bun run dev:web`, enter its printed dev access token at the
  development-server gate first. That gate is separate from Ficus account
  authentication. For a paired backend, follow the [dev proxy workflow](docs/wiki/development.md#developing-against-a-remote-backend).
- Keep first-run links, passkeys, device tokens and `.env` contents out of
  screenshots and logs. Wait for an observable signed-in UI or response before
  interacting; do not use a fixed sleep as proof of login.

See [authentication configuration](docs/wiki/configuration.md#authentication)
and [Core authentication](docs/wiki/core-auth.md) for session, device and
bootstrap boundaries. Automated auth fixtures should use isolated test users
and the supported authentication routes rather than modifying a live account
or weakening authentication.

## Home Directory & Paths

Use `getHomeDir` from `apps/core/src/lib/utils/home.ts` to get the home
directory path (typically `~/.ficus`). Do not use `os.homedir()` or
`process.env.HOME` directly.
