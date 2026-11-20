/** The machine script that owns box Nix cache maintenance (VM runtime only). */
export const BOX_PROVISION_SCRIPT = '/opt/ficus/bin/box-provision.sh'

/**
 * Bounded post-install cache maintenance, run as the box user. It only removes
 * loose Nix download objects that are already readable from a pack (shared or
 * private): other box commands may be running Nix at the same time, so the full
 * private-object reset is left to service start (box-provision.sh).
 * The guard makes it a no-op where the script is absent (k8s pods, older
 * machines); an older script rejects the unknown flag, and `|| true` keeps that
 * from failing the install.
 */
export const NIX_CACHE_MAINTENANCE_COMMAND = `if [ -f ${BOX_PROVISION_SCRIPT} ]; then timeout 15s bash ${BOX_PROVISION_SCRIPT} --unix-user "$(id -un)" --prepare-nix-cache --keep-private-nix-objects >&2 || true; fi`

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * Run `command` in a subshell whose EXIT trap runs the cache maintenance, so
 * successful, failed and partial installs are all cleaned without changing the
 * command's exit status.
 */
export function withNixCacheMaintenance(command: string): string {
  return `(trap ${shellQuote(NIX_CACHE_MAINTENANCE_COMMAND)} EXIT; ${command})`
}
