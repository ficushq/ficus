#!/bin/bash
set -eu
mkdir -p /logs/verifier
cd /app
if ! git apply --binary /logs/artifacts/model.patch; then
  echo 0 > /logs/verifier/reward.txt
  exit 0
fi
cd /tests
set +e
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -I -m pytest -q -p no:cacheprovider --confcutdir=/tests /tests/official/test_checkpoint_3.py --entrypoint="/app/config_server" --checkpoint=checkpoint_3 --junitxml=/logs/verifier/results.xml > /logs/verifier/tests.log 2>&1
status=$?
set -e
cat /logs/verifier/tests.log
python3 -I /tests/score.py "$status"
