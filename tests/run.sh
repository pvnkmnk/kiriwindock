#!/bin/sh
# Runs the Dockr tests: sh dockr/tests/run.sh [file ...]
# stack.test.mjs builds and runs a small throwaway compose project, so it needs Docker and takes
# about a minute. It skips itself when Docker is not running. DOCKR_SKIP_DOCKER=1 skips it too.
cd "$(dirname "$0")" || exit 1
[ $# -gt 0 ] || set -- ./*.test.mjs
exec node --import ./register.mjs --test --test-timeout=600000 "$@"
