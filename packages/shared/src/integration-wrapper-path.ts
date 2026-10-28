/** Token-free managed CLI wrappers; prepend AFTER devbox/toolchain activation. */
export const INTEGRATION_BIN_RELATIVE_PATH = '.ficus/integration-bin'

export function integrationWrapperPreamble(directory: string, sourceBindings = true): string {
  const quoted = `'${directory.replace(/'/g, `'"'"'`)}'`
  const bindings = `'${`${directory}/.git-config`.replace(/'/g, `'"'"'`)}'`
  return (
    `export PATH=${quoted}:"$PATH"\n` +
    (sourceBindings
      ? `unset -f gh 2>/dev/null || true\nif [ -n "\${FICUS_TOKEN:-}" ] && [ -r ${bindings} ]; then . ${bindings}; fi\n`
      : '')
  )
}
