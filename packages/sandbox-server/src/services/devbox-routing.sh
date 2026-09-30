# Route documented bare `devbox add` calls to the VM box devbox when the caller
# is not already inside a project devbox. This file is sourced by both /bash and
# interactive VM Bashrc sessions.
if [ -n "${FICUS_BOX_HOME:-}" ] && [ -n "${FICUS_DEVBOX_DIR:-}" ]; then
  devbox() {
    if [ "${1:-}" != "add" ]; then
      command devbox "$@"
      return $?
    fi

    local search="$PWD"
    while :; do
      if [ -f "$search/devbox.json" ]; then
        command devbox "$@"
        return $?
      fi
      [ "$search" = / ] && break
      search="${search%/*}"
      [ -n "$search" ] || search=/
    done

    (cd "$FICUS_DEVBOX_DIR" && command devbox "$@")
    local status=$?
    if [ "$status" -eq 0 ]; then
      : >"$FICUS_DEVBOX_DIR/.shellenv-dirty.$$"
      eval "$(cd "$FICUS_DEVBOX_DIR" && command devbox shellenv --init-hook 2>/dev/null)" 2>/dev/null || true
      hash -r
    fi
    return "$status"
  }
fi
