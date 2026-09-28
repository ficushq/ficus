/**
 * Where the `ficus` CLI lives inside a sandbox. One name in every runtime:
 * the docker bind mount, the k8s subPath mount and the vm machine wrapper all
 * put it at {@link SANDBOX_CLI_PATH}, and nothing else on a sandbox's PATH.
 */
export const SANDBOX_CLI_PATH = '/usr/local/bin/ficus'

/** File name of the built CLI bundle (`apps/cli/dist/ficus.js`) and of every copy Core stages or pushes. */
export const CLI_BUNDLE_FILE = 'ficus.js'

/** k8s: the staged copy, relative to HOME_DIR (the core-data volume root) — the pod's subPath. */
export const K8S_STAGED_CLI_SUBPATH = `cli/${CLI_BUNDLE_FILE}`
