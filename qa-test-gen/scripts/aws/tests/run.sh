#!/usr/bin/env bash
# Runs every test_*.sh in this directory. stdin is /dev/null so test doubles
# that capture stdin never block on a terminal.
set -uo pipefail
cd "$(dirname "$0")"
status=0
for f in test_*.sh; do
  printf '\n== %s\n' "$f"
  bash "$f" < /dev/null || status=1
done
exit "$status"
