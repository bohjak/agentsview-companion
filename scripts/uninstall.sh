#!/usr/bin/env bash
set -euo pipefail

main() {
  if [[ "$#" -ne 0 ]]; then
    printf 'Usage: make uninstall (user data is always kept)\n' >&2
    return 2
  fi
  local repo_root link
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  link="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}/extensions/agentsview-companion-usage"
  if [[ -L "${link}" && "$(readlink "${link}")" == "${repo_root}/clients/pi-usage-command" ]]; then
    rm "${link}"
  fi
  if [[ "$(uname -s)" == "Darwin" && -d "/Applications/AgentsView Companion.app" ]]; then
    osascript -e 'tell application id "com.bohjak.agentsview-companion" to quit'
    rm -rf "/Applications/AgentsView Companion.app"
  fi
  printf 'Removed current clients. AgentsView, preferences, and historical data were left untouched.\n'
  printf 'Older collector hooks/services, if installed, must be retired separately.\n'
}

main "$@"
