import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ExecutionWrapper {
  binary: string
  providerKey: string
}
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

/** Token-free executables, not shell functions: children retain PATH and acquire fresh credentials too. */
export function renderExecutionWrapper(binary: string, providerKey: string, squadId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(binary) || binary === 'ficus' || !/^[a-z0-9][a-z0-9_-]*$/.test(providerKey))
    throw new Error('Invalid execution wrapper declaration')
  return `#!/bin/sh
# Ficus integration PATH wrapper. Contains no credentials.
set -f
# Resolve executable files, not shell functions; -ef also skips symlink/duplicate PATH aliases.
# PATH can be narrowed by a child script. Resolve the bounded header reader once,
# falling back to standard runtime locations rather than recursing into another wrapper.
__ficus_wrapper_head_binary=$(command -v head) || __ficus_wrapper_head_binary=
if [ -z "$__ficus_wrapper_head_binary" ]; then
  for __ficus_wrapper_utility in /usr/bin/head /bin/head; do
    if [ -x "$__ficus_wrapper_utility" ]; then __ficus_wrapper_head_binary=$__ficus_wrapper_utility; break; fi
  done
fi
if [ -z "$__ficus_wrapper_head_binary" ]; then
  printf '%s\\n' 'Cannot safely resolve integration CLI: head is unavailable.' >&2
  exit 127
fi
__ficus_wrapper_remaining_path=$PATH
__ficus_wrapper_real_binary=
while :; do
  case "$__ficus_wrapper_remaining_path" in
    *:*) __ficus_wrapper_directory=\${__ficus_wrapper_remaining_path%%:*}; __ficus_wrapper_remaining_path=\${__ficus_wrapper_remaining_path#*:}; __ficus_wrapper_more=yes ;;
    *) __ficus_wrapper_directory=$__ficus_wrapper_remaining_path; __ficus_wrapper_more=no ;;
  esac
  [ -n "$__ficus_wrapper_directory" ] || __ficus_wrapper_directory=.
  __ficus_wrapper_candidate="$__ficus_wrapper_directory"/${quote(binary)}
  if [ -f "$__ficus_wrapper_candidate" ] && [ -x "$__ficus_wrapper_candidate" ] && ! [ "$__ficus_wrapper_candidate" -ef "$0" ]; then
    # Skip other copies of our wrapper (e.g. another squad's PATH segment).
    if ! __ficus_wrapper_marker=$(LC_ALL=C "$__ficus_wrapper_head_binary" -c 80 "$__ficus_wrapper_candidate" 2>/dev/null) 2>/dev/null; then
      printf '%s\\n' 'Cannot safely inspect integration CLI on PATH.' >&2
      exit 126
    fi
    case "$__ficus_wrapper_marker" in
      '#!/bin/sh
# Ficus integration PATH wrapper.'*) ;;
      *) __ficus_wrapper_real_binary=$__ficus_wrapper_candidate; break ;;
    esac
  fi
  [ "$__ficus_wrapper_more" = yes ] || break
done
if [ -z "$__ficus_wrapper_real_binary" ]; then
  printf '%s\\n' ${quote(`Cannot find real ${binary} on PATH (Ficus integration wrapper).`)} >&2
  exit 127
fi
if [ -z "\${FICUS_TOKEN:-}" ]; then
  printf '%s\\n' ${quote(`Ficus integration credentials are only available to agents; running ${binary} without Ficus credentials.`)} >&2
  exec "$__ficus_wrapper_real_binary" "$@"
fi
exec ficus integration exec ${quote(providerKey)} --squad ${quote(squadId)} -- "$__ficus_wrapper_real_binary" "$@"
`
}

/** Reconcile only this Ficus-owned directory. Atomic replacement avoids half-written executables. */
export function writeExecutionWrappers(
  directory: string,
  wrappers: readonly ExecutionWrapper[],
  squadId: string,
  commandBindings?: string
): void {
  const scripts = new Map<string, string>()
  for (const { binary, providerKey } of wrappers) {
    if (scripts.has(binary)) throw new Error(`Conflicting integration wrapper: ${binary}`)
    scripts.set(binary, renderExecutionWrapper(binary, providerKey, squadId))
  }
  // Optional legacy Git instructions are token-free and travel with the same managed asset.
  if (commandBindings !== undefined) scripts.set('.git-config', commandBindings)
  mkdirSync(directory, { recursive: true })
  for (const [binary, content] of scripts) {
    const temporary = join(directory, `.tmp-${crypto.randomUUID()}`)
    try {
      writeFileSync(temporary, content, { mode: 0o755 })
      chmodSync(temporary, 0o755)
      renameSync(temporary, join(directory, binary))
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  for (const entry of readdirSync(directory)) {
    if (!scripts.has(entry) && !entry.startsWith('.tmp-')) rmSync(join(directory, entry), { force: true })
  }
}
