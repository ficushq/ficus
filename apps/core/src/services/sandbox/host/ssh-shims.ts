/**
 * Host-runtime `ssh`/`scp`/`rsync` shims (issue #1331).
 *
 * On the host runtime there is no `~/.ssh` mount: plain SSH-family commands
 * run as the operator and read the operator's own ssh config, so tau-granted
 * remote-host aliases do not resolve — only git does, via
 * `GIT_SSH_COMMAND`. These PATH shims (written into `<HOME_DIR>/host/bin`,
 * which `buildHostCommandEnv` already prepends to every agent PATH) close
 * that gap for the three tools agents actually use, without ever touching
 * the operator's own ssh configuration or weakening host-key checking:
 *
 * - Pass-through unless EVERY remote destination is an alias inside the
 *   squad config's `# >>> tau remote hosts >>>` managed block (see
 *   `remote-hosts/materialize.ts`) and the user passed no `-F` (ssh/scp) of
 *   their own. For rsync, `RSYNC_RSH` is exported instead of parsing
 *   `-e`/`--rsh`: rsync gives an explicit `-e`/`--rsh` precedence over the
 *   env var, so a user-configured command behaves exactly as before — the
 *   env var is set but inert when `-e` is present.
 * - Injection adds exactly `-F <squad config>` plus, when the file exists,
 *   `-o UserKnownHostsFile=<squad known_hosts>` — the same strings
 *   `GIT_SSH_COMMAND` already uses. Strictness stays governed by the
 *   managed stanza (`StrictHostKeyChecking accept-new`); nothing is ever
 *   weakened at the top level.
 * - `GIT_SSH_COMMAND` starts with `ssh` and already carries `-F`, so it hits
 *   the shim's "user `-F` wins → pass through" rule and stays byte-identical
 *   (pinned by a regression test).
 *
 * The scripts are POSIX `/bin/sh` (like the `tau` shim) and deliberately
 * dependency-free: the squad ssh dir is read from `FICUS_SQUAD_SSH_DIR` at
 * run time (exported by `buildHostCommandEnv`), so solo agents — which have
 * no squad ssh config — get a plain pass-through. Line arrays are used
 * instead of a template literal because the shell body is full of literal
 * `${...}` expansions that a TS template literal would interpolate.
 */

import { randomUUID } from 'crypto'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { hostBinDir } from './env'

export type SshFamilyTool = 'ssh' | 'scp' | 'rsync'

export const SSH_FAMILY_TOOLS: readonly SshFamilyTool[] = ['ssh', 'scp', 'rsync']

// Must match MANAGED_BLOCK_BEGIN / MANAGED_BLOCK_END in
// ../../remote-hosts/materialize.ts. Kept as local literals (rather than an
// import) so this module — pulled in by every host exec through manager.ts —
// never drags the DB client into a process or test that has no database.
// Drift is failure-safe (the shim finds no aliases and passes through), and
// the functional test suite pins the fixtures to these exact markers.
const MANAGED_BLOCK_BEGIN = '# >>> tau remote hosts >>>'
const MANAGED_BLOCK_END = '# <<< tau remote hosts <<<'

const TOOL_COMMENTS: Record<SshFamilyTool, string> = {
  ssh: `# tau host-runtime ssh shim. When the destination is an alias managed by
# tau in the squad SSH config, prepend that config (-F + pinned
# UserKnownHostsFile) so the alias resolves. Anything else — including any
# invocation that already passes -F — runs untouched against the operator's
# own ssh.`,
  scp: `# tau host-runtime scp shim. When every remote destination is an alias
# managed by tau in the squad SSH config, prepend that config (-F + pinned
# UserKnownHostsFile) so the aliases resolve. Anything else — including any
# invocation that already passes -F, or a command that also names an
# operator host — runs untouched against the operator's own scp.`,
  rsync: `# tau host-runtime rsync shim. When the remote destination is an alias
# managed by tau in the squad SSH config, export RSYNC_RSH=ssh -F <squad
# config> so the alias resolves. Anything else runs untouched against the
# operator's own rsync; an explicit -e/--rsh beats RSYNC_RSH by rsync's own
# precedence, so user-configured commands behave exactly as before.`,
}

/** Header + squad-dir read: identical shape for all three tools. */
function preludeLines(tool: SshFamilyTool): string[] {
  return [
    '#!/bin/sh',
    ...TOOL_COMMENTS[tool].split('\n'),
    'SQUAD_DIR=${FICUS_SQUAD_SSH_DIR:-}',
    'CFG=$SQUAD_DIR/config',
  ]
}

/**
 * Resolve the real binary by walking PATH, skipping this shim's own
 * directory (derived from $0) and anything `-ef`-identical to it, so the
 * shim can never exec itself. Identical shape for all three tools.
 */
function resolveRealLines(tool: SshFamilyTool): string[] {
  return [
    '',
    "# Resolve the real binary: walk PATH, skipping this shim's own directory",
    '# (and anything -ef-identical to $0) so we never exec ourselves.',
    'SHIM_DIR=',
    'case $0 in */*) SHIM_DIR=${0%/*} ;; esac',
    'REAL=',
    'ifs=$IFS',
    'IFS=:',
    'for d in $PATH; do',
    '  IFS=$ifs',
    '  [ -n "$SHIM_DIR" ] && [ "$d" = "$SHIM_DIR" ] && continue',
    `  [ -x "$d/${tool}" ] || continue`,
    `  if [ "$d/${tool}" != "$0" ] && { [ ! -e "$0" ] || [ ! "$d/${tool}" -ef "$0" ]; }; then`,
    `    REAL=$d/${tool}`,
    '    break',
    '  fi',
    'done',
    'IFS=$ifs',
    `[ -n "$REAL" ] || { echo "${tool}: not found (tau host shim)" >&2; exit 127; }`,
  ]
}

/**
 * Shared guard + alias collection: pass through when there is no squad ssh
 * config (solo agents, fresh squads) or no managed aliases; otherwise
 * collect alias names — ONLY from the marker-delimited managed block, and
 * ONLY single-token names matching [a-z0-9-]+ (the same gate
 * materialize.ts applies before writing a stanza, re-checked here because
 * agents on host run as the operator and can edit the file directly).
 */
function aliasScanLines(): string[] {
  return [
    '',
    '# No squad ssh dir / no config (solo agents, fresh squads): plain pass-through.',
    '[ -n "$SQUAD_DIR" ] && [ -f "$CFG" ] || exec "$REAL" "$@"',
    '',
    "# Managed aliases: only names inside tau's managed block are tau's to resolve.",
    'ALIASES=',
    'in=0',
    'while IFS= read -r line || [ -n "$line" ]; do',
    '  line=${line#"${line%%[!\t ]*}"}',
    '  case $line in',
    `    '${MANAGED_BLOCK_BEGIN}') in=1 ;;`,
    `    '${MANAGED_BLOCK_END}') in=0 ;;`,
    '    Host\\ *)',
    '      if [ "$in" = 1 ]; then',
    '        name=${line#Host }',
    '        case $name in',
    "          ''|*[!a-z0-9-]*) ;;",
    '          *) ALIASES="$ALIASES $name" ;;',
    '        esac',
    '      fi',
    '      ;;',
    '  esac',
    'done < "$CFG"',
    '[ -n "$ALIASES" ] || exec "$REAL" "$@"',
  ]
}

/** Strip user@ / [brackets] from a destination's host part into `target`. */
const HOST_PART_LINES = ['target=${dest%%:*}', 'target=${target##*@}', 'target=${target#[}', 'target=${target%]}']

function sshTailLines(): string[] {
  return [
    '',
    '# Walk argv: first operand is the destination; note any user -F. Mirrors',
    "# ssh's getopt: bundled flags (-4A), attached values (-p22), separate values",
    "# (-p 22), '--' ends options. VALOPTS = ssh options that take a value.",
    'VALOPTS="BbcDEeFIiJLlmOopQRSWw"',
    'dest=',
    'skip=0',
    'endopts=0',
    'sawF=0',
    'for arg in "$@"; do',
    '  [ "$skip" = 1 ] && { skip=0; continue; }',
    '  [ "$endopts" = 1 ] && { dest=$arg; break; }',
    '  case $arg in',
    '    --) endopts=1 ;;',
    '    -) dest=$arg; break ;;',
    '    -*)',
    '      tok=${arg#-}',
    '      while [ -n "$tok" ]; do',
    '        ch=${tok%"${tok#?}"}',
    '        tok=${tok#?}',
    '        case $ch in',
    '          [$VALOPTS])',
    '            [ "$ch" = F ] && sawF=1',
    '            if [ -n "$tok" ]; then tok=; else skip=1; fi',
    '            break',
    '            ;;',
    '        esac',
    '      done',
    '      ;;',
    '    *) dest=$arg; break ;;',
    '  esac',
    'done',
    '',
    '# User-config wins, and a non-managed destination is none of our business.',
    'if [ -z "$dest" ] || [ "$sawF" = 1 ]; then exec "$REAL" "$@"; fi',
    ...HOST_PART_LINES,
    'case $target in',
    '  \'\'|*[!a-z0-9-]*) exec "$REAL" "$@" ;;',
    'esac',
    'case " $ALIASES " in',
    '  *" $target "*) ;;',
    '  *) exec "$REAL" "$@" ;;',
    'esac',
    '',
    '# Managed alias: same injection GIT_SSH_COMMAND already uses.',
    'KH=$SQUAD_DIR/known_hosts',
    'if [ -f "$KH" ]; then',
    '  exec "$REAL" -F "$CFG" -o "UserKnownHostsFile=$KH" "$@"',
    'fi',
    'exec "$REAL" -F "$CFG" "$@"',
  ]
}

function scpTailLines(): string[] {
  return [
    '',
    '# Walk argv: every non-option operand containing : is a remote spec (scp',
    '# requires the colon). All-or-nothing: inject only when there is at least',
    '# one remote spec AND every one of them is a managed alias — a command that',
    '# also names an operator host is never hijacked. VALOPTS = scp options that',
    "# take a value (-O and -T are flags in scp, unlike ssh's -O ctl_cmd).",
    'VALOPTS="cFiJlPSo"',
    'total=0',
    'matched=0',
    'skip=0',
    'endopts=0',
    'sawF=0',
    'for arg in "$@"; do',
    '  [ "$skip" = 1 ] && { skip=0; continue; }',
    '  case $arg in',
    '    --) endopts=1 ;;',
    '    -*)',
    '      if [ "$endopts" = 0 ]; then',
    '        tok=${arg#-}',
    '        while [ -n "$tok" ]; do',
    '          ch=${tok%"${tok#?}"}',
    '          tok=${tok#?}',
    '          case $ch in',
    '            [$VALOPTS])',
    '              [ "$ch" = F ] && sawF=1',
    '              if [ -n "$tok" ]; then tok=; else skip=1; fi',
    '              break',
    '              ;;',
    '          esac',
    '        done',
    '      fi',
    '      ;;',
    '    *:*)',
    '      total=$((total + 1))',
    '      dest=$arg',
    ...HOST_PART_LINES.map((l) => `      ${l}`),
    '      case $target in',
    "        ''|*[!a-z0-9-]*) ;;",
    '        *)',
    '          case " $ALIASES " in',
    '            *" $target "*) matched=$((matched + 1)) ;;',
    '          esac',
    '          ;;',
    '      esac',
    '      ;;',
    '  esac',
    'done',
    '',
    '# User-config wins, and a non-managed (or mixed) command is none of our business.',
    'if [ "$sawF" = 1 ] || [ "$total" = 0 ] || [ "$matched" != "$total" ]; then exec "$REAL" "$@"; fi',
    '',
    '# Managed alias: same injection GIT_SSH_COMMAND already uses.',
    'KH=$SQUAD_DIR/known_hosts',
    'if [ -f "$KH" ]; then',
    '  exec "$REAL" -F "$CFG" -o "UserKnownHostsFile=$KH" "$@"',
    'fi',
    'exec "$REAL" -F "$CFG" "$@"',
  ]
}

function rsyncTailLines(): string[] {
  return [
    '',
    "# Quote a value for rsync's RSYNC_RSH word-splitter (it honors embedded",
    "# single quotes): wrap in single quotes with each ' escaped as '\\''.",
    '# The quote/backslash live in variables so no line needs nested quoting.',
    'q() {',
    `  sq="'"`,
    `  bs='\\'`,
    '  qout=$sq',
    '  qrest=$1',
    '  while [ -n "$qrest" ]; do',
    '    case $qrest in',
    '      "$sq"*) qout="$qout$sq$bs$sq$sq"; qrest=${qrest#"$sq"} ;;',
    '      *) qpart=${qrest%%"$sq"*}; qout="$qout$qpart"; qrest=${qrest#"$qpart"} ;;',
    '    esac',
    '  done',
    `  printf '%s' "$qout$sq"`,
    '}',
    '',
    '# Check one bare operand as a candidate remote spec: [user@]host:path over',
    "# rsh/ssh. rsync:// URLs and host::module daemon specs are never tau's to",
    '# resolve; anything without a colon is a local path.',
    'check_spec() {',
    '  case $1 in',
    '    rsync://*|*::*) return ;;',
    '    *:*) ;;',
    '    *) return ;;',
    '  esac',
    '  dest=$1',
    ...HOST_PART_LINES.map((l) => `  ${l}`),
    '  case $target in',
    "    ''|*[!a-z0-9-]*) return ;;",
    '  esac',
    '  case " $ALIASES " in',
    '    *" $target "*) matched=1 ;;',
    '  esac',
    '}',
    '',
    '# rsync supports at most one remote operand, given as a bare non-option',
    '# argument; long options and short bundles can never carry one (their',
    '# values come attached or via =). -e/--rsh is deliberately NOT parsed:',
    '# rsync gives an explicit -e/--rsh precedence over RSYNC_RSH, so a',
    '# user-configured command keeps its own rsh and the env var stays inert.',
    'matched=0',
    'endopts=0',
    'for arg in "$@"; do',
    '  [ "$endopts" = 1 ] && { check_spec "$arg"; continue; }',
    '  case $arg in',
    '    --) endopts=1 ;;',
    '    --*) ;;',
    '    -*) ;;',
    '    *) check_spec "$arg" ;;',
    '  esac',
    'done',
    '[ "$matched" = 1 ] || exec "$REAL" "$@"',
    'KH=$SQUAD_DIR/known_hosts',
    'RSH="ssh -F $(q "$CFG")"',
    '[ -f "$KH" ] && RSH="$RSH -o UserKnownHostsFile=$(q "$KH")"',
    'RSYNC_RSH=$RSH exec "$REAL" "$@"',
  ]
}

/** Pure: render the POSIX /bin/sh shim body for one tool. */
export function renderSshShimScript(tool: SshFamilyTool): string {
  const tail = tool === 'ssh' ? sshTailLines() : tool === 'scp' ? scpTailLines() : rsyncTailLines()
  return [...preludeLines(tool), ...resolveRealLines(tool), ...aliasScanLines(), ...tail].join('\n') + '\n'
}

/**
 * Write the `ssh`, `scp`, and `rsync` shims into `<HOME_DIR>/host/bin` with
 * the same atomic write `ensureCliShim` uses (scratch file in the same
 * directory, chmod before it becomes visible, atomic rename) — all three
 * are on every agent's PATH, so a concurrent exec must never observe a
 * half-written file. Returns the written paths.
 */
export function ensureSshFamilyShims(): string[] {
  const dir = hostBinDir()
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const tool of SSH_FAMILY_TOOLS) {
    const shim = join(dir, tool)
    const tmpShim = join(dir, `.${tool}.tmp-${randomUUID()}`)
    writeFileSync(tmpShim, renderSshShimScript(tool))
    chmodSync(tmpShim, 0o755)
    renameSync(tmpShim, shim)
    written.push(shim)
  }
  return written
}
