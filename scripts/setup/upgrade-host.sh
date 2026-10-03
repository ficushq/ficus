#!/usr/bin/env bash
#
# upgrade-host.sh — ON-TARGET Ficus upgrade primitive.
#
# Moves an ALREADY SET UP Ficus host to a different source ref: fetch + checkout
# → dependencies + core build + web build → database migrations → restart
# the api and worker units and wait for both to actually serve. With
# ingress.caddy, it first re-renders the Caddyfile (see the caddy ingress step).
#
# Why this exists as its own entrypoint rather than "just re-run setup-host.sh":
# a re-run of setup-host.sh re-resolves the FULL config, including every secret
# indirection (database DSN, AI provider key, backup passphrase, the bootstrap
# password, the platform usage token). Those values are deliberately not
# retained anywhere off-box after the initial provision — the control plane
# keeps a hash of the usage token, not the token — so a full re-run cannot be
# reproduced from the outside. An upgrade needs none of them: the host's
# <dest>/.env already holds everything the services read.
#
# What it is NOT allowed to become is a hand-rolled command sequence. The three
# steps that matter (build, migrate, restart) are lib.sh's build_app /
# run_db_migrations / restart_core_services — the exact same functions
# setup-host.sh's phases call. That is the whole point: the api unit runs
# `bun run dist/index.js`, so a fetch without a core build leaves the OLD
# server running while `git log` reports the new commit, and the only reliable
# defense is that there is one shared definition of the build rather than two
# that can drift.
#
# Reads the SAME config file setup-host.sh was given (for source.*, core.* and
# ingress.* only — it never touches the secrets sections), so the ref/repo/dest/port a
# host was set up with stay authoritative.
#
# Idempotent: re-running against the ref the host already has re-syncs,
# rebuilds, re-migrates and restarts. Requires root or passwordless-ish sudo.
#
# TWO MODES. The one above (git) is the escape hatch. When the four
# FICUS_ARTIFACT_* inputs arrive in the environment (delivered through the
# control plane's existing 0600 secrets.env channel — presigned URLs are
# credentials and never travel in argv), this runs the ARTIFACT flow instead:
# download a prebuilt, signed core release, verify it, migrate from the
# candidate, and activate it by moving one symlink. No repo access, no
# GH_TOKEN, no build toolchain, and no `.git` requirement — the first artifact
# upgrade of a git box CONVERTS it (the old checkout becomes
# releases/git-<sha>, the rollback target). See lib.sh's `core release
# artifacts` section for the box-side machinery.
#
# SETTINGS NAMING. This toolkit and the Core releases it installs read FICUS_*
# settings only. A host whose <dest>/.env predates that naming is refused in
# preflight (lib.sh's require_host_env_ready), and so is a target release
# that predates it (core_release_is_ficus), before anything moves.
#
# HOST MIGRATIONS. When a release needs this host's config files changed,
# lib.sh's journaled host-migration framework does it right before the flip,
# after a byte-for-byte backup set, and restores the set if the run fails,
# rolls back or is killed. See lib.sh's `host migrations` section, and
# --restore-host-backup below for the manual way back.
#
# HOST LAYOUT. This updater requires the canonical Ficus host layout before
# changing a release. It refuses a pre-rename host or target release in
# preflight. The last trailer line reports FICUS_HOST_LAYOUT=2.

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

usage() {
  cat <<'EOF'
Usage: upgrade-host.sh --config ficus-setup.yaml [--ref REF]
       upgrade-host.sh [--config ficus-setup.yaml] --restore-host-backup SET

Upgrades the Ficus instance ON THIS HOST to a source ref: source sync → build
(core AND web) → migrations → service restart + health wait.

Options:
  --config FILE   the config this host was set up with (see
                  ficus-setup.example.yaml). Only source.*, core.* and
                  ingress.* are read (ingress.* to re-render the Caddyfile).
  --ref REF       branch, tag or commit sha to move to. Defaults to the
                  config's source.ref.
  --restore-host-backup SET
                  put a host backup set (a directory under
                  /var/backups/ficus-host-migrate, or one the previous
                  release left under /var/backups/ficus-env-rename) back byte
                  for byte and exit. It also reverts any secret changed since
                  that set was taken. A set taken during a git->artifact
                  conversion re-renders the units, which needs --config.
                  A set taken for an old host-layout migration is refused.
  Artifact mode   when FICUS_ARTIFACT_TARBALL_URL,
                  FICUS_ARTIFACT_MANIFEST_URL, FICUS_ARTIFACT_SIG_URL and
                  FICUS_ARTIFACT_PUBKEY_B64 are all set, install that signed
                  prebuilt release instead of building from source. Its
                  manifest identifies the commit; --ref is ignored.
EOF
}

CONFIG='' REF_OVERRIDE='' RESTORE_HOST_SET=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG=${2:?--config needs a value}
      shift 2
      ;;
    --ref)
      REF_OVERRIDE=${2:?--ref needs a value}
      shift 2
      ;;
    --restore-host-backup)
      RESTORE_HOST_SET=${2:?--restore-host-backup needs a backup set directory}
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# ====================================================== --restore-host-backup
#
# The manual way back from a host migration: put a backup set back (every file
# verified against its MANIFEST sha256), clear the journal when it names this
# set, and exit. Nothing else in this script runs.
if [[ -n ${RESTORE_HOST_SET} ]]; then
  # First: a non-root caller cannot even see into the root 0700 set root.
  [[ ${EUID} -eq 0 ]] ||
    die "--restore-host-backup is root-only (it restores root-owned files and units from ${RESTORE_HOST_SET}, a root 0700 set) — re-run this as root"
  [[ -d ${RESTORE_HOST_SET} ]] || die "--restore-host-backup: '${RESTORE_HOST_SET}' is not a directory"
  RESTORE_HOST_SET=$(readlink -f -- "${RESTORE_HOST_SET}") || die "--restore-host-backup: could not resolve the set path"
  if [[ -n ${CONFIG} ]]; then
    [[ -f ${CONFIG} ]] || die "config file '${CONFIG}' not found"
    ensure_yq
    cfg_load "${CONFIG}"
    SRC_DEST=$(cfg_source_dest) || die "could not read source.dest from ${CONFIG}"
    # shellcheck disable=SC2034 # caller globals: lib.sh's render_core_unit reads them
    RUN_USER=$(cfg_get '.core.run_user' "$(id -un)")
    # shellcheck disable=SC2034
    DB_MODE=$(cfg_get '.database.mode' 'container')
    # shellcheck disable=SC2034
    BUN_BIN=/usr/local/bin/bun
  elif [[ -e ${RESTORE_HOST_SET}/UNITS_EXCLUDED ]]; then
    die "--restore-host-backup: ${RESTORE_HOST_SET} was taken during a git->artifact conversion, so restoring it re-renders the core units — pass --config <the host's setup config> as well"
  fi
  host_migrate_lock
  restore_rc=0
  host_migrate_backup_restore "${RESTORE_HOST_SET}" || restore_rc=$?
  case ${restore_rc} in
    0) log_info "restored the host files from ${RESTORE_HOST_SET}; any secret changed since that set was taken is reverted too" ;;
    3) die "--restore-host-backup: ${RESTORE_HOST_SET} needs the unit templates next to this script (systemd/*.service.tmpl) — nothing was changed" ;;
    *) die "--restore-host-backup: restoring ${RESTORE_HOST_SET} failed (see above)" ;;
  esac
  exit 0
fi

[[ -n ${CONFIG} ]] || {
  usage >&2
  die "--config is required"
}
[[ -f ${CONFIG} ]] || die "config file '${CONFIG}' not found — this host does not look like it was set up by this toolkit"

ensure_yq
cfg_load "${CONFIG}"

# ============================================================== mode selection
#
# The artifact inputs arrive in the ENVIRONMENT (the control plane's
# upgrade secrets.env channel, 0600), never on the command line:
# three of them are presigned GET URLs, i.e. credentials, and argv is
# world-readable through ps. All four required — a partial set is a delivery
# bug, and running a half-configured artifact upgrade would either fail deep
# inside the verify or, worse, silently fall back to building from source when
# the control plane believed it shipped a verified release.
FICUS_ARTIFACT_TARBALL_URL=${FICUS_ARTIFACT_TARBALL_URL:-}
FICUS_ARTIFACT_MANIFEST_URL=${FICUS_ARTIFACT_MANIFEST_URL:-}
FICUS_ARTIFACT_SIG_URL=${FICUS_ARTIFACT_SIG_URL:-}
FICUS_ARTIFACT_PUBKEY_B64=${FICUS_ARTIFACT_PUBKEY_B64:-}
ARTIFACT_MODE=0
if [[ -n ${FICUS_ARTIFACT_TARBALL_URL} && -n ${FICUS_ARTIFACT_MANIFEST_URL} && -n ${FICUS_ARTIFACT_SIG_URL} && -n ${FICUS_ARTIFACT_PUBKEY_B64} ]]; then
  ARTIFACT_MODE=1
elif [[ -n ${FICUS_ARTIFACT_TARBALL_URL}${FICUS_ARTIFACT_MANIFEST_URL}${FICUS_ARTIFACT_SIG_URL}${FICUS_ARTIFACT_PUBKEY_B64} ]]; then
  # SOME but not all: a delivery bug. Falling through to git mode here would
  # rebuild from source while the control plane believes it shipped a verified
  # artifact — a silent divergence between what the fleet runs and what the CP
  # records. Fail loudly instead.
  die "artifact inputs are incomplete — refusing to fall back to a source build (need FICUS_ARTIFACT_TARBALL_URL, FICUS_ARTIFACT_MANIFEST_URL, FICUS_ARTIFACT_SIG_URL and FICUS_ARTIFACT_PUBKEY_B64; missing:$(
    [[ -z ${FICUS_ARTIFACT_TARBALL_URL} ]] && printf ' FICUS_ARTIFACT_TARBALL_URL'
    [[ -z ${FICUS_ARTIFACT_MANIFEST_URL} ]] && printf ' FICUS_ARTIFACT_MANIFEST_URL'
    [[ -z ${FICUS_ARTIFACT_SIG_URL} ]] && printf ' FICUS_ARTIFACT_SIG_URL'
    [[ -z ${FICUS_ARTIFACT_PUBKEY_B64} ]] && printf ' FICUS_ARTIFACT_PUBKEY_B64'
    true
  ))"
fi

# Only the source/core keys. Every secret-bearing section (database, backup,
# ai, secrets) is deliberately NOT read: an upgrade renders no .env and needs
# no credential, which is what makes it runnable long after provisioning
# without re-supplying anything.
SRC_MODE=$(cfg_get '.source.mode' 'git-ssh')
# The layout's install root when the config names none (read again once the
# host layout is adopted, below).
SRC_DEST=$(cfg_source_dest)
if [[ ${ARTIFACT_MODE} -eq 0 ]]; then
  # shellcheck disable=SC2034 # SRC_REPO/SRC_DEPLOY_KEY are read by lib.sh's
  # git_source_sync as caller globals, exactly as in setup-host.sh.
  SRC_REPO=$(cfg_require '.source.repo' 'git repository')
  SRC_REF=${REF_OVERRIDE:-$(cfg_get '.source.ref' 'main')}
  # shellcheck disable=SC2034
  SRC_DEPLOY_KEY=$(expand_tilde "$(cfg_get '.source.deploy_key_path')")
  case "${SRC_MODE}" in
    git-ssh | git-https) ;;
    artifact) die "source.mode=artifact hosts are not upgradable from source (there is no checkout to move) — an artifact upgrade needs the FICUS_ARTIFACT_* inputs in the environment" ;;
    *) die "config: source.mode must be git-ssh or git-https (got '${SRC_MODE}')" ;;
  esac
fi

CORE_PORT=$(cfg_get '.core.port' '3000')
[[ ${CORE_PORT} =~ ^[0-9]+$ ]] || die "config: core.port must be a number"
CORE_SERVE_WEB=$(cfg_bool '.core.serve_web' 'true')
RUN_USER=$(cfg_get '.core.run_user' "$(id -un)")
# Not a secret and not a credential — the unit templates need it for the
# `After=… docker.service` ordering, and re-rendering a unit without it would
# quietly drop that ordering on a container-database box.
# shellcheck disable=SC2034 # caller global: lib.sh's render_core_unit reads it
DB_MODE=$(cfg_get '.database.mode' 'container')
# The managed system Bun, exactly as setup-host.sh renders it into the units
# (ensure_system_bun_node is what puts it there). Resolving it from PATH
# instead would rewrite ExecStart to whatever bun this ssh session happened to
# find.
# shellcheck disable=SC2034 # caller global: lib.sh's render_core_unit reads it
BUN_BIN=/usr/local/bin/bun

# ====================================================== host migrations
#
# First, before any preflight: a journaled host migration that an earlier run
# left behind (killed, OOM, reboot) is made to match the release that is
# serving right now — finished if it is the journaled release, restored
# otherwise. Then the traps that settle THIS run's migration if it fails, is
# rolled back or is signalled (bash runs an EXIT trap with $?=0 on a signal,
# hence the explicit TERM/HUP/INT ones). One toolkit run at a time may
# migrate, restore or reconcile this host (the lock, like those steps, is
# root-only).
require_host_layout_ready
[[ ${ARTIFACT_MODE} -eq 0 ]] || require_artifact_conversion_ready "${SRC_DEST}"
host_migrate_lock
reconcile_rc=0
host_migrate_reconcile || reconcile_rc=$?
[[ ${reconcile_rc} -eq 0 ]] ||
  die "a journaled host migration could not be reconciled (${reconcile_rc}) — push the complete toolkit (systemd/*.service.tmpl) and re-run"
host_migrate_install_traps
# The host layout as the reconcile left it — BEFORE anything reads a path:
# this process resolved its layout when lib.sh was sourced, and a reconcile
# may have settled an older journal. Read the canonical paths again.
host_layout_adopt --no-repair
SRC_DEST=$(cfg_source_dest)
# A host whose settings predate the Ficus naming stops HERE, before either
# mode's preflight, conversion, download, staging or candidate migration.
require_host_layout_ready
require_host_env_ready

# ============================================================== caddy ingress
#
# Re-render the ingress Caddyfile (lib.sh's upgrade_caddy_prepare/apply), the
# only way a render_caddyfile change reaches a hosted tenant. Validated and
# swapped HERE, before either mode moves anything: a bad
# ingress.trusted_proxies entry, a Caddyfile caddy rejects or a failed reload
# fails the upgrade with Core untouched, and the host keeps serving its
# previous Caddyfile (caddy_write_and_reload restores it). An unchanged file
# is left alone and caddy is not reloaded. A host without ingress.caddy skips.
prepare_upgrade_host() {
  ensure_swapfile
  ensure_system_bun_node "${RUN_USER}" "$(command -v bun)"
  log_step 'caddy ingress: re-render the Caddyfile'
  upgrade_caddy_prepare "${SRC_DEST}/.env"
  upgrade_caddy_apply
}

# ============================================================== artifact mode

artifact_upgrade() {
  local acq='' rc=0 sha digest12 tree release_dir before before_sha tmpl

  # The units must point at <dest>/current from this run onward. Forced rather
  # than inferred: on the very first conversion `releases/` may not exist yet
  # at the moment the render is prepared.
  # shellcheck disable=SC2034 # caller global: lib.sh's core_run_root reads it
  CORE_LAYOUT=artifact

  log_step 'artifact upgrade 1/5: preflight (no source checkout required)'
  # Deliberately NOT required here: `.git`, git itself, and any git env setup.
  # An artifact box may have no checkout at all. bun IS required — the
  # artifact ships no runtime — and artifact_acquire hard-fails if the host's
  # bun is not the version the artifact was built against.
  bun_path_prepend
  require_cmd bun "setup-host.sh installs bun at \${HOME}/.bun/bin — was this host set up by the toolkit?"
  require_cmd curl
  require_cmd jq
  require_cmd openssl
  require_root_capability
  id -u "${RUN_USER}" >/dev/null 2>&1 || die "core.run_user '${RUN_USER}' does not exist"
  # The templates are NOT part of this script: an artifact upgrade re-renders
  # the api/worker units. Require the complete toolkit before changing the
  # release so a partial upload cannot leave stale units.
  for tmpl in systemd/ficus-api.service.tmpl systemd/ficus-worker.service.tmpl systemd/ficus-backup.service.tmpl \
    systemd/ficus-backup.timer.tmpl ficus-backup.sh.tmpl; do
    [[ -f ${SCRIPT_DIR}/${tmpl} ]] ||
      die "missing ${SCRIPT_DIR}/${tmpl} — upload the complete scripts/setup toolkit before an artifact upgrade"
  done
  # The services this run will restart read <dest>/.env (EnvironmentFile in
  # both units), and an upgrade renders no .env — so if that file never named
  # a sandbox runtime, the flip at step 5 brings
  # both units back DEAD. Refuse here, while nothing on the box has moved.
  require_env_file_sandbox_runtime "${SRC_DEST}/.env"

  # The artifact public key is NOT a secret, but openssl needs it as a file.
  # 0600, and the toolkit EXIT trap (host_migrate_install_traps) removes it, so
  # no exit path — including a die deep inside the verify — leaves it behind.
  ARTIFACT_PUBKEY_FILE=$(mktemp)
  chmod 600 "${ARTIFACT_PUBKEY_FILE}"
  printf '%s' "${FICUS_ARTIFACT_PUBKEY_B64}" | base64 -d >"${ARTIFACT_PUBKEY_FILE}" 2>/dev/null ||
    die "FICUS_ARTIFACT_PUBKEY_B64 is not valid base64"
  [[ -s ${ARTIFACT_PUBKEY_FILE} ]] || die "FICUS_ARTIFACT_PUBKEY_B64 decoded to an empty public key"

  # Read what this box is serving BEFORE anything on disk moves — after the
  # conversion below there is no checkout left to ask.
  before=$(artifact_current_release_id "${SRC_DEST}")
  log_info "current release: ${before}"

  # First artifact upgrade of a git box: the checkout becomes a release, and
  # the units move onto <dest>/current in the SAME step. Both halves happen
  # before anything is downloaded, so the box is consistent at every instant:
  # `current` exists the moment the units name it, an acquire failure leaves a
  # box that survives a reboot, and the first artifact activation has a real
  # `current` to auto-roll back to.
  #
  # The trigger is `.git` at <dest> — which is also the resume signal, because
  # artifact_convert_git_checkout moves `.git` last (an interrupted conversion
  # still looks like a checkout, and re-running finishes it).
  if [[ -d ${SRC_DEST}/.git ]]; then
    log_step 'artifact upgrade 2/5: converting the git checkout to the artifact layout (one-way)'
    artifact_convert_git_checkout "${SRC_DEST}"
    # The units now name <dest>/current, which is the CONVERTED checkout. A
    # host migration of this run then leaves the units out of its backup set;
    # a restore re-renders them for this layout.
    install_core_units "${SCRIPT_DIR}/systemd"
    # shellcheck disable=SC2034 # read by lib.sh's host_migrate / host_migrate_backup_create
    ARTIFACT_CONVERTED_THIS_RUN=1
    ensure_api_memory_guardrail
    as_root systemctl daemon-reload
    log_info "units now run from ${SRC_DEST}/current (conversion complete; a manual rollback is: point current at releases/git-<sha> and restart)"
  else
    log_step 'artifact upgrade 2/5: already on the artifact layout — no conversion needed'
  fi

  log_step 'artifact upgrade 3/5: download + verify the release artifact'
  # artifact_acquire EXITS (it does not return) on failure, printing its
  # reason token on stdout — so it has to be captured, and its status has to
  # be taken from the substitution. `local x=$(...)` would throw the status
  # away and read a failed, unverified acquire as success.
  acq='' rc=0
  acq=$(artifact_acquire "${SRC_DEST}" "${FICUS_ARTIFACT_TARBALL_URL}" "${FICUS_ARTIFACT_MANIFEST_URL}" "${FICUS_ARTIFACT_SIG_URL}" "${ARTIFACT_PUBKEY_FILE}") || rc=$?
  if [[ ${rc} -ne 0 ]]; then
    # The FICUS_ARTIFACT_ERROR=<token> line went into ${acq}, not onto the log
    # stream — re-emit it or the control plane never learns why this failed.
    printf '%s\n' "${acq}"
    die "artifact acquisition failed"
  fi
  sha=$(printf '%s\n' "${acq}" | sed -n 1p | awk '{print $1}')
  digest12=$(printf '%s\n' "${acq}" | sed -n 1p | awk '{print $2}')
  tree=$(printf '%s\n' "${acq}" | sed -n 2p)
  [[ ${sha} =~ ^[0-9a-f]{40}$ && ${digest12} =~ ^[0-9a-f]{12}$ && -d ${tree} ]] ||
    die "artifact_acquire returned an unusable result (sha='${sha}', digest12='${digest12}')"

  artifact_stage "${SRC_DEST}" "${tree}" "${sha}" "${digest12}"
  release_dir=$(artifact_release_dir "${SRC_DEST}" "${sha}" "${digest12}")

  # A release that predates the Ficus naming cannot read this host's
  # settings: refuse now, while the only thing that moved is the staged
  # release (and a conversion, which is harmless).
  core_release_is_ficus "${release_dir}" ||
    die "refusing ${release_dir}: it is a pre-Ficus Core release (its artifact.json has no \"envPrefix\": \"FICUS\") — choose a Ficus release"
  # A non-root (sudo) run cannot do a host migration this release needs:
  # refuse now, before the candidate migration.
  require_host_layout_ready "${release_dir}"
  host_migrate_require_privilege "${release_dir}"
  prepare_upgrade_host

  log_step "artifact upgrade 4/5: host migrations and systemd units are prepared right before the flip"
  # Both happen inside artifact_activate's pre-flip hook (host_layout_preflip,
  # which runs the framework's host_migrate_for):
  # AFTER the candidate's migration succeeded and IMMEDIATELY before
  # `current` moves, so the old core runs against migrated files for no
  # longer than that one step. The hook renders the units — the ONLY unit
  # render for a box that was already on the artifact layout, i.e. where a
  # changed template reaches it — and artifact_activate daemon-reloads before
  # it restarts, so a changed unit and the flip take effect together.

  log_step 'artifact upgrade 5/5: migrate → host migrations → flip → restart (auto-rollback on a failed health check)'
  # No `||` and no `if`: a failed activation must abort this script through
  # set -e. artifact_activate emits FICUS_RELEASE_ROLLED_BACK itself — it is the
  # only code that knows whether the flip survived. Its rollback hook puts the
  # host backup set back before the rollback restart; the EXIT trap does the
  # same for any other failure after a host migration. Both hooks are the host
  # layout's wrappers: the pre-flip one stops both units first on a flip across
  # host layouts, then runs host_migrate_for (every registered migration,
  # host_layout included, exactly once); the rollback one stops both units
  # before settling (stop-the-world: the two sides of the migration's release
  # use different admission keys).
  # shellcheck disable=SC2034 # read by lib.sh's artifact_activate
  ARTIFACT_PREFLIP_HOOK=host_migrate_for
  # shellcheck disable=SC2034 # read by lib.sh's artifact_activate
  ARTIFACT_ROLLBACK_HOOK=host_layout_rollback_hook
  artifact_activate "${SRC_DEST}" "${release_dir}" "${CORE_PORT}"
  # The migrated files are what the serving release reads now. SRC_DEST is the
  # install root the activation ended on (a host layout move relocated it).
  host_migrate_commit
  artifact_retention "${SRC_DEST}"

  log_info "activated release ${sha:0:12}-${digest12} (was ${before})"

  # Machine-readable trailer, last lines on stdout (all logging goes to
  # stderr). The FICUS_UPGRADE_* lines are kept in artifact mode too so anything
  # still grepping them keeps working: AFTER_SHA is the artifact's commit, and
  # AFTER_REF is 'artifact' because there is no branch to report.
  before_sha=${before#git-}
  before_sha=${before_sha%-*}
  artifact_emit_release_trailer "${before}" "${sha}-${digest12}"
  printf 'FICUS_UPGRADE_BEFORE_SHA=%s\n' "${before_sha}"
  printf 'FICUS_UPGRADE_AFTER_SHA=%s\n' "${sha}"
  printf 'FICUS_UPGRADE_AFTER_REF=%s\n' 'artifact'
  # The host layout this run left the host on; the control plane cross-checks it.
  printf 'FICUS_HOST_LAYOUT=%s\n' "${HL_LAYOUT}"
}

if [[ ${ARTIFACT_MODE} -eq 1 ]]; then
  artifact_upgrade
  exit 0
fi

# ================================================================== git mode

[[ -d ${SRC_DEST}/.git ]] ||
  die "source.dest '${SRC_DEST}' is not a git checkout — nothing to upgrade (was this host set up from a git source?)"

require_cmd git
# An upgrade never INSTALLS bun — it only needs to SEE the one setup-host.sh
# already put on the box, which a non-interactive ssh shell cannot do unaided.
bun_path_prepend
require_cmd bun "setup-host.sh installs bun at \${HOME}/.bun/bin — was this host set up by the toolkit?"
require_cmd curl
require_root_capability
id -u "${RUN_USER}" >/dev/null 2>&1 || die "core.run_user '${RUN_USER}' does not exist"
# Same reasoning as artifact mode's preflight: phase 4 restarts the api and
# worker units against <dest>/.env, which this script never renders. An .env
# with no (or a retired) sandbox runtime means both
# units come back dead AFTER the checkout has already moved — so check before
# phase 1.
require_env_file_sandbox_runtime "${SRC_DEST}/.env"

BEFORE_SHA=$(git -C "${SRC_DEST}" rev-parse HEAD)

# The target revision, asked after the fetch and BEFORE the checkout moves: a
# revision that predates the Ficus naming (its committed package.json is not
# named ficus) cannot read this host's settings, so it is refused with the
# checkout, the build and the database untouched.
git_target_check() { # REV
  require_host_layout_ready '' "$(git_rev_host_layout "${SRC_DEST}" "$1")"
  git_rev_is_ficus "${SRC_DEST}" "$1" ||
    die "refusing revision $1: it is a pre-Ficus Core release (its package.json is not named ficus) — choose a Ficus release"
  host_migrate_require_privilege "${SRC_DEST}"
  prepare_upgrade_host
}

log_step "phase 1/4: source → ${SRC_REF}"
# shellcheck disable=SC2034 # read by lib.sh's git_source_sync
GIT_PRE_CHECKOUT_HOOK=git_target_check
git_source_sync

log_step "phase 2/4: dependencies + build (core + cli${CORE_SERVE_WEB:+ + web}) — ~1-2 min, silent while it builds"
build_app "${SRC_DEST}" "${CORE_SERVE_WEB}"

log_step "phase 3/4: database migrations"
run_db_migrations "${SRC_DEST}"

ensure_api_memory_guardrail
if [[ ${FICUS_API_MEMORY_GUARDRAIL_CHANGED} -eq 1 ]]; then
  as_root systemctl daemon-reload
fi

# Host migrations, immediately before the restart. Git mode has no
# auto-rollback, and the checkout has already moved: a failed restart
# therefore keeps a migration and commits it (the EXIT trap settles by the
# active release, which is this checkout — or by the migration's own commit
# point, for the host layout). A host layout move relocates SRC_DEST and the
# unit names in this shell.
host_migrate "${SRC_DEST}"

log_step "phase 4/4: restart ${HL_UNIT_API} + ${HL_UNIT_WORKER}"
restart_core_services "${CORE_PORT}"
host_migrate_commit

AFTER_SHA=$(git -C "${SRC_DEST}" rev-parse HEAD)
AFTER_REF=$(git -C "${SRC_DEST}" rev-parse --abbrev-ref HEAD)
# _ficus_build_skipped is set by build_app (lib.sh) above — true only when the
# stamp proved the build current for this exact commit + bun.lock, in which
# case the expensive compile step was skipped (migrations + restart still
# ran, which is what keeps the platform's post-upgrade mtime probe honest;
# see build_app's comment in lib.sh).
log_info "$(upgrade_result_message "${BEFORE_SHA}" "${AFTER_SHA}" "${_ficus_build_skipped:-false}")"

# Machine-readable trailer, last lines on stdout (all logging goes to stderr).
# The control plane parses these; humans get the log_info lines above.
printf 'FICUS_UPGRADE_BEFORE_SHA=%s\n' "${BEFORE_SHA}"
printf 'FICUS_UPGRADE_AFTER_SHA=%s\n' "${AFTER_SHA}"
printf 'FICUS_UPGRADE_AFTER_REF=%s\n' "${AFTER_REF}"
printf 'FICUS_HOST_LAYOUT=%s\n' "${HL_LAYOUT}"
