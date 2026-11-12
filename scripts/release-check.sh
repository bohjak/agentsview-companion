#!/usr/bin/env bash
set -euo pipefail

main() {
  local repo_root script
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "${repo_root}"
  pnpm --filter @token-tally/pi-usage-command typecheck
  pnpm --filter @token-tally/pi-usage-command test
  for script in scripts/*.sh; do
    bash -n "${script}"
  done
  if command -v shellcheck >/dev/null 2>&1; then
    shellcheck scripts/*.sh
  fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    make -C clients/macos-tray build test
  fi
  git diff --check
}

main "$@"
