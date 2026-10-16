# shellcheck shell=bash
# Minimal test harness for the AWS deploy scripts. Source it from a test_*.sh
# file, define test_* functions, then call run_tests. Each test runs in its own
# subshell with `set -e` and a fresh sandbox whose bin/ is first on PATH, so
# test doubles shadow the real aws/ssh/curl/etc.
set -uo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$(cd "$HARNESS_DIR/.." && pwd)"
export AWS_DIR

fail() { printf '    assertion failed: %s\n' "$*" >&2; return 1; }

assert_contains()     { [[ "$1" == *"$2"* ]] || fail "expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "expected NOT to contain [$2]"; }
assert_eq()           { [[ "$1" == "$2" ]]   || fail "expected [$2], got [$1]"; }
assert_fails()        { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi; }

new_sandbox() {
  SANDBOX="$(mktemp -d)"
  export SANDBOX
  mkdir -p "$SANDBOX/bin" "$SANDBOX/responses"
  : > "$SANDBOX/calls.log"
  export PATH="$SANDBOX/bin:$PATH"
  # Never read the operator's real aws.env during tests.
  export AAQUA_AWS_ENV=/dev/null
}

install_fake() {
  local name
  for name in "$@"; do
    if [ -f "$HARNESS_DIR/fakes/$name" ]; then
      cp "$HARNESS_DIR/fakes/$name" "$SANDBOX/bin/$name"
    else
      cp "$HARNESS_DIR/fakes/fake-cmd" "$SANDBOX/bin/$name"
    fi
    chmod +x "$SANDBOX/bin/$name"
  done
}

respond()  { cat > "$SANDBOX/responses/$1"; }
stdin_of() { cat "$SANDBOX/stdin.$1.log" 2>/dev/null || true; }

run_tests() {
  local t passes=0 fails=0
  for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
    if ( set -e; new_sandbox; "$t" ); then
      printf 'ok    %s\n' "$t"; passes=$((passes + 1))
    else
      printf 'FAIL  %s\n' "$t"; fails=$((fails + 1))
    fi
  done
  printf '%d passed, %d failed\n' "$passes" "$fails"
  [ "$fails" -eq 0 ]
}
