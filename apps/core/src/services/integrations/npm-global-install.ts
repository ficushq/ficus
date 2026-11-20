/**
 * Shell lines that install a verified npm archive into the managed toolchain's
 * global prefix (`$DEVBOX_PROJECT_ROOT/npm`), for integration setup steps.
 *
 * Before replacing an installed package, npm renames its directory to a
 * sibling named `.<name>-<8 character hash of the path>` and deletes that once
 * the new copy is in place. An install that is killed in between (a box stop,
 * a setup timeout) leaves the renamed copy behind. The npm bundled with the
 * pinned Node.js (11.6.2) then fails every later install of the same package
 * with `ENOTEMPTY: directory not empty, rename ...`, because the rename target
 * already exists. Nothing else clears it, so the toolchain can never be
 * installed again in that box. Removing the leftover first makes the step
 * repeatable; it is npm's own discarded copy and nothing reads it.
 */
export function npmGlobalInstallLines(packageName: string, archive = '"./$archive"'): string[] {
  // The name is interpolated into a shell glob: accept only npm's own alphabet.
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
    throw new Error(`Unsupported npm package name: ${packageName}`)
  }
  const slash = packageName.lastIndexOf('/')
  const scope = slash < 0 ? '' : `/${packageName.slice(0, slash)}`
  const base = packageName.slice(slash + 1)
  return [
    `rm -rf -- "$DEVBOX_PROJECT_ROOT/npm/lib/node_modules${scope}"/.${base}-????????`,
    `npm install --global --prefix "$DEVBOX_PROJECT_ROOT/npm" --no-audit --no-fund ${archive}`,
  ]
}
