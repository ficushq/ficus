/**
 * Shared bashrc content generation for sandbox terminal sessions.
 *
 * Both Docker and K8s sandbox managers create a .tau/.bashrc file
 * that sources workspace secrets and activates devbox. This module
 * generates that content so both implementations stay in sync.
 */

import * as fs from 'fs'
import * as path from 'path'
import vmDevboxRouting from '../../../../../packages/sandbox-server/src/services/devbox-routing.sh' with { type: 'text' }

/**
 * Generate .tau/.bashrc content for sandbox terminal sessions.
 * Sources .tau/.env for workspace secrets and activates devbox if configured.
 *
 * @param workspacePath - Host path to the workspace (used to check for devbox.json)
 * @param workspaceMount - Container-side mount path for the workspace (e.g. /workspace)
 * @param opts.devboxDir - VM box only: the ABSOLUTE box-side dir holding the box's
 *   own devbox.json (`FICUS_DEVBOX_DIR`, e.g. `~/.tau/devbox`). When set, the box's
 *   devbox lives OUTSIDE the shell's cwd, so activation runs `devbox shellenv`
 *   from that dir explicitly (a bare `devbox shellenv` would find nothing). Omit
 *   on k8s/docker, where devbox.json sits in the workspace (the shell's cwd).
 * @returns Bashrc file content as a string
 */
export function buildBashrcContent(
  workspacePath: string,
  workspaceMount: string,
  opts: { devboxDir?: string; toolchainDir?: string } = {}
): string {
  const lines = [
    "export PS1='\\[\\033[01;32m\\]\\w\\[\\033[00m\\]\\$ '",
    '',
    '# Source workspace secrets',
    `[ -f ${workspaceMount}/.tau/.env ] && set -a && . ${workspaceMount}/.tau/.env && set +a`,
  ]

  // --init-hook runs shell.init_hook commands from devbox.json (env vars, aliases, etc.)
  if (opts.devboxDir) {
    // VM box: the box's devbox lives at a fixed dir (FICUS_DEVBOX_DIR), NOT the
    // shell cwd, so activate it from there (mirrors entrypoint.sh's
    // `eval "$(cd "$WS" && devbox shellenv ...)"`). We can't fs.existsSync it here
    // — it lives on the box, not this host — so emit unconditionally; the eval is
    // already fault-tolerant (2>/dev/null || true) if devbox/the dir is absent.
    lines.push(
      '',
      '# Activate the box devbox environment (with init hooks)',
      `eval "$(cd ${opts.devboxDir} && devbox shellenv --init-hook 2>/dev/null)" 2>/dev/null || true`,
      '',
      vmDevboxRouting
    )
  } else {
    // k8s/docker: devbox.json sits in the workspace (the shell's cwd), so gate the
    // activation on the host-visible devbox.json and use a bare `devbox shellenv`.
    const devboxJsonPath = path.join(workspacePath, 'devbox.json')
    if (fs.existsSync(devboxJsonPath)) {
      lines.push(
        '',
        '# Activate devbox environment (with init hooks from devbox.json)',
        'eval "$(devbox shellenv --init-hook 2>/dev/null)" 2>/dev/null || true'
      )
    }
  }

  if (opts.toolchainDir) {
    lines.push(
      '',
      '# Activate Ficus-managed toolchain after existing environments',
      `[ -f ${opts.toolchainDir}/.ready ] && eval "$(cd ${opts.toolchainDir} && devbox shellenv --init-hook 2>/dev/null)" 2>/dev/null || true`
    )
  }

  lines.push(
    '',
    '# Normalize sandbox runtime for Nix Python and browser tooling',
    '[ -f /opt/sandbox/runtime-env.sh ] && . /opt/sandbox/runtime-env.sh'
  )

  return lines.join('\n') + '\n'
}
