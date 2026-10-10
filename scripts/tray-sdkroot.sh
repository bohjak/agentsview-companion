#!/usr/bin/env bash
# scripts/tray-sdkroot.sh — Print the macOS SDK to build the tray app against.
#
# Prints an absolute SDK path to export as SDKROOT before running
# `swift build` / `swift test` for clients/macos-tray, or prints nothing when
# the active toolchain's default SDK is fine (the caller must then leave
# SDKROOT unset). Exits non-zero with a diagnostic on stderr when no usable
# SDK exists.
#
# Why this exists: SwiftUI's @State became an accessor macro in the macOS 27
# SDK. Its compiler-plugin module ("SwiftUIMacros") ships with Xcode only, so
# Command Line Tools cannot expand it. The unexpanded macro leaves @State with
# a mutating setter and the build fails with
# "cannot assign to property: 'self' is immutable" on every @State assignment.
# On CLT-only systems we therefore pin the newest installed SDK whose
# SwiftUICore still ships property-wrapper @State. Once the active toolchain
# provides the plugin (Xcode today, CLT eventually), the default SDK is used
# again with no pinning.

set -euo pipefail

main() {
  local dev_dir sdk_dir sdk iface arch

  if ! dev_dir=$(xcode-select --print-path 2>/dev/null) || [[ -z "${dev_dir}" ]]; then
    echo "No active developer directory — install Xcode or Command Line Tools." >&2
    return 1
  fi

  # Toolchains that ship the SwiftUIMacros plugin can expand the macro-based
  # @State from the newest SDK without help.
  if [[ -e "${dev_dir}/usr/lib/swift/host/plugins/libSwiftUIMacros.dylib" ]]; then
    return 0
  fi

  # CLT without the plugin: use the newest SDK whose @State is still a plain
  # property wrapper. find -type d skips symlinked aliases such as
  # MacOSX.sdk / MacOSX27.sdk; sort -V orders by SDK version, newest first.
  sdk_dir="${dev_dir}/SDKs"
  while IFS= read -r sdk; do
    for arch in arm64e-apple-macos x86_64-apple-macos; do
      iface="${sdk}/System/Library/Frameworks/SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/${arch}.swiftinterface"
      if [[ -f "${iface}" ]] && ! grep -q 'macro State() = #externalMacro' "${iface}"; then
        echo "${sdk}"
        return 0
      fi
    done
  done < <(find "${sdk_dir}" -maxdepth 1 -type d -name 'MacOSX*.sdk' | sort -rV)

  echo "No SDK under ${sdk_dir} can build SwiftUI with the active toolchain" >&2
  echo "(SwiftUIMacros plugin missing and no SDK with property-wrapper @State)." >&2
  echo "Install Xcode, or a Command Line Tools release that ships the plugin." >&2
  return 1
}

main "$@"
