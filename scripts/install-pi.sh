#!/usr/bin/env bash
set -euo pipefail

main() {
  local repo_root="${1:?REPO_ROOT is required}"
  local agent_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
  local target="${repo_root}/clients/pi-usage-command"
  local link="${agent_dir}/extensions/token-tally-usage"
  if [[ ! -d "${agent_dir}" || ! -f "${target}/index.ts" ]]; then
    printf 'Pi agent directory or usage extension source not found.\n' >&2
    return 1
  fi
  mkdir -p "${agent_dir}/extensions"
  if [[ -L "${link}" ]]; then
    if [[ "$(readlink "${link}")" == "${target}" ]]; then
      printf 'Pi /usage is already linked. Reload Pi to pick up changes.\n'
      return
    fi
    rm "${link}"
  elif [[ -e "${link}" ]]; then
    printf 'Refusing to replace non-symlink: %s\n' "${link}" >&2
    return 1
  fi
  ln -s "${target}" "${link}"
  printf 'Installed Pi /usage. Reload Pi to load the extension.\n'
}

main "$@"
