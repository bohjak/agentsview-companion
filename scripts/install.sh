#!/usr/bin/env bash
set -euo pipefail

main() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ "$#" -ne 0 ]]; then
    printf 'Usage: make install (or make install-tray / make install-pi)\n' >&2
    return 2
  fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    bash "${repo_root}/scripts/install-tray.sh" "${repo_root}"
  fi
  if [[ -d "${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}" ]]; then
    bash "${repo_root}/scripts/install-pi.sh" "${repo_root}"
  else
    printf 'Pi not detected; skipping /usage. Install later with make install-pi.\n'
  fi
}

main "$@"
