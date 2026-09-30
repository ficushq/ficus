import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Expand a leading `~` in a filesystem path.
 *
 * NOTHING in the chain that produces Ficus's environment expands `~`: Bun's
 * built-in dotenv loader, the `dotenv` package, the CLI's own `.env` parser and
 * systemd's `EnvironmentFile=` all hand the value through verbatim, because a
 * `~` is only meaningful to an interactive shell. So `HOME_DIR=~/.ficus` in a
 * `.env` reaches `getHomeDir()` as the literal eight characters `~/.ficus`, and
 * the process cheerfully creates a directory literally named `~` under its cwd
 * — a data tree in the wrong place that looks, from the outside, like Ficus
 * simply ignored the setting.
 *
 * Semantics deliberately match the setup toolkit's `expand_tilde`
 * (scripts/setup/lib.sh), so a path is resolved the same way whether it came
 * through the setup yaml or straight from a `.env`:
 *
 *   `~`        → the home directory
 *   `~/rest`   → home + rest
 *   `~user/…`  → UNCHANGED (resolving another account's home needs the passwd
 *                database, and guessing `<dirname(home)>/user` is wrong on
 *                macOS, on `/home` layouts with per-team prefixes, and for
 *                system accounts)
 *   everything else → UNCHANGED
 *
 * This expands `~` and nothing else: it does not resolve relative paths and
 * does not expand `$VAR`. Call sites that already `resolve()` keep doing so —
 * expansion happens first, resolution after.
 *
 * The home is a parameter (`home = homedir()`) so callers that need the
 * expansion against a DIFFERENT home — notably tests, which must never write
 * fixtures inside the real `$HOME` — can thread one through instead of
 * mutating the process environment (which bun's homedir() does not pick up
 * in-process anyway). Production callers omit it and get the real home.
 */
export function expandTilde(value: string, home: string = homedir()): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}
