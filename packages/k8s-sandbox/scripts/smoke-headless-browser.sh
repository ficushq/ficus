#!/usr/bin/env bash
set -euo pipefail

cd /workspace

if [ ! -f devbox.json ] && [ -f /opt/tau/defaults/devbox.json ]; then
  cp /opt/tau/defaults/devbox.json devbox.json
fi

devbox install >/dev/null
# Devbox-generated hooks may reference variables with `${VAR:-...}`-style
# assumptions that are incompatible with this script's `set -u`.
set +u
eval "$(devbox shellenv --init-hook 2>/dev/null)"
set -u
[ -f /opt/sandbox/runtime-env.sh ] && . /opt/sandbox/runtime-env.sh

python_path="$(command -v python)"
echo "python=$python_path"
case "$python_path" in
  /nix/store/*|/root/.cache/devbox/*|/workspace/.devbox/*) ;;
  *) echo "ERROR: expected devbox/Nix python, got $python_path" >&2; exit 1 ;;
esac

rm -rf /tmp/playwright-smoke-venv
python -m venv /tmp/playwright-smoke-venv
source /tmp/playwright-smoke-venv/bin/activate
python -m pip install --upgrade pip >/dev/null
python -m pip install greenlet playwright >/dev/null
python -m playwright install chromium >/dev/null

python - <<'PY'
import os
import platform

assert os.environ.get('TMPDIR') == '/tmp', os.environ.get('TMPDIR')
assert os.environ.get('LD_LIBRARY_PATH'), 'LD_LIBRARY_PATH must include Nix runtime libs'
assert os.environ.get('FICUS_NIX_LD_LIBRARY_PATH'), 'FICUS_NIX_LD_LIBRARY_PATH must be set'
assert os.environ.get('FICUS_NIX_GLIBC_LIBRARY_PATH'), 'FICUS_NIX_GLIBC_LIBRARY_PATH must be set'
assert os.environ.get('PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS') == '1'
print(platform.machine(), platform.platform())
print('TMPDIR', os.environ['TMPDIR'])
print('FICUS_NIX_LD_LIBRARY_PATH', os.environ['FICUS_NIX_LD_LIBRARY_PATH'])
print('FICUS_NIX_GLIBC_LIBRARY_PATH', os.environ['FICUS_NIX_GLIBC_LIBRARY_PATH'])

import greenlet
from playwright.sync_api import sync_playwright

print('imports ok')
with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        args=['--no-sandbox', '--disable-dev-shm-usage'],
    )
    page = browser.new_page()
    page.goto('https://example.com', wait_until='domcontentloaded')
    title = page.title()
    print(title)
    browser.close()
    assert title == 'Example Domain'
PY
