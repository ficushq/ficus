#!/bin/sh
# Checks that this machine's git leaves a commit or tag unsigned when its SSH
# signing program succeeds with an empty signature.
#
# Ficus relies on that: with commit signing on, squad shells run git with
# gpg.ssh.program=ficus, and when the committer's own GitHub account has
# signing off, `ficus -Y sign` writes an empty `<file>.sig` and exits 0
# (apps/cli/src/git-signing.ts). Git adds a signature header only for a
# non-empty signature, so the object is written unsigned. That is not
# documented git behavior, so this script pins it down: it fails if a git
# release starts rejecting the empty signature, writes an empty signature
# header, or leaves objects `git fsck --strict` complains about.
#
# Everything runs in a throwaway repository with a stub signing program; no
# real key is read or used. The Docker sandbox image runs this at build time
# (apps/core/docker-sandbox/Dockerfile), and a Core test runs it against the
# host git.
set -eu

fail() {
  echo "check-git-unsigned-signing: $*" >&2
  echo "check-git-unsigned-signing: git $(git --version | sed 's/^git version //') does not leave objects unsigned for an empty SSH signature; see docs/wiki/github-integrations.md" >&2
  exit 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A stand-in for `ficus -Y sign -n git -f <key file> [-U] <buffer file>`: it
# records the call and writes the signature it is given (empty by default).
cat >"$work/sign" <<'EOF'
#!/bin/sh
[ "$1 $2" = "-Y sign" ] || exit 1
for last; do :; done
printf '%s' "${STUB_SIGNATURE:-}" >"$last.sig"
echo called >>"$STUB_LOG"
EOF
chmod +x "$work/sign"
export STUB_LOG="$work/calls" STUB_SIGNATURE=

# The same settings the squad git wrapper passes (apps/core/src/services/squad/env.ts).
# The key is a made-up literal; git only copies it into a file for the program.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Check GIT_AUTHOR_EMAIL=check@example.invalid
export GIT_COMMITTER_NAME=Check GIT_COMMITTER_EMAIL=check@example.invalid
signing() {
  git -C "$work/repo" \
    -c gpg.format=ssh \
    -c commit.gpgsign=true \
    -c tag.gpgsign=true \
    -c 'user.signingkey=key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA check' \
    -c gpg.ssh.program="$work/sign" \
    "$@"
}

# Runs git and fails unless it succeeded and called the signing program.
signed_call() {
  : >"$STUB_LOG"
  signing "$@" >"$work/out" 2>&1 || { cat "$work/out" >&2; fail "git $* failed"; }
  [ -s "$STUB_LOG" ] || fail "git $* did not call the signing program"
}

git init -q "$work/repo" || fail 'git init failed'

# Control: a non-empty signature is embedded, so the checks below can tell.
STUB_SIGNATURE='-----BEGIN SSH SIGNATURE-----
U1NIU0lH
-----END SSH SIGNATURE-----
'
signed_call commit -q --allow-empty -m control
git -C "$work/repo" cat-file commit HEAD | grep -q '^gpgsig' || fail 'control commit has no gpgsig header'
STUB_SIGNATURE=

signed_call commit -q --allow-empty -m 'unsigned by config'
git -C "$work/repo" cat-file commit HEAD | grep -q '^gpgsig' && fail 'commit.gpgsign commit has a gpgsig header'

signed_call commit -q --allow-empty -S -m 'unsigned with -S'
git -C "$work/repo" cat-file commit HEAD | grep -q '^gpgsig' && fail 'commit -S has a gpgsig header'

signed_call tag -a -m 'unsigned annotated tag' unsigned-annotated
signed_call tag -s -m 'unsigned -s tag' unsigned-s
# A tag carries its signature after the message, so an unsigned tag ends with it.
for tag in 'unsigned-annotated:unsigned annotated tag' 'unsigned-s:unsigned -s tag'; do
  git -C "$work/repo" cat-file tag "${tag%%:*}" >"$work/tag"
  grep -q 'SIGNATURE' "$work/tag" && fail "tag ${tag%%:*} has a signature"
  [ "$(tail -n 1 "$work/tag")" = "${tag#*:}" ] || fail "tag ${tag%%:*} does not end with its message"
done

git -C "$work/repo" fsck --strict --no-dangling >"$work/fsck" 2>&1 || { cat "$work/fsck" >&2; fail 'git fsck --strict failed'; }
[ -s "$work/fsck" ] && { cat "$work/fsck" >&2; fail 'git fsck --strict reported problems'; }

echo "check-git-unsigned-signing: ok ($(git --version))"
