import releases from './cli-releases.json'

export type DeploymentBinary = keyof typeof releases

/** Public release metadata only. Run in an isolated temporary directory and fail before installing on digest mismatch. */
export function deploymentCliSetup(binary: DeploymentBinary): { id: string; script: string } {
  const release = releases[binary]
  const lines = ['(', 'set -eu', 'tmp=$(mktemp -d)', 'trap \'rm -rf -- "$tmp"\' EXIT', 'cd "$tmp"']
  if ('package' in release) {
    lines.push(
      `archive=$(npm pack --silent ${release.package}@${release.version})`,
      `actual=$(node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64'))" "$archive")`,
      `test "$actual" = "${release.integrity}"`,
      'npm install --global --prefix "$DEVBOX_PROJECT_ROOT/npm" --no-audit --no-fund "./$archive"'
    )
  } else {
    lines.push(
      'os=$(uname -s | tr "[:upper:]" "[:lower:]")',
      'case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "Unsupported CLI architecture" >&2; exit 1 ;; esac',
      'case "$os-$arch" in',
      ...Object.entries(release.assets).map(
        ([platform, asset]) => `  ${platform}) url='${asset.url}'; digest='${asset.sha256}' ;;`
      ),
      '  *) echo "Unsupported CLI platform" >&2; exit 1 ;;',
      'esac',
      'curl --fail --silent --show-error --location --retry 2 --max-time 120 "$url" -o cli.tar.gz',
      `actual=$(node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('cli.tar.gz')).digest('hex'))")`,
      'test "$actual" = "$digest"',
      `tar -xzf cli.tar.gz '${binary}'`,
      'mkdir -p "$DEVBOX_PROJECT_ROOT/npm/bin"',
      `install -m 755 '${binary}' "$DEVBOX_PROJECT_ROOT/npm/bin/${binary}"`
    )
  }
  lines.push(')')
  return { id: `${binary}-cli@${release.version}`, script: lines.join('\n') }
}

export function deploymentCliVersion(binary: DeploymentBinary): string {
  return releases[binary].version
}
