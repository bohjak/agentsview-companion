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
# SDK. Its compiler-plugin module ("SwiftUIMacros") is absent from some Apple
# toolchains, which therefore cannot expand it. The unexpanded macro leaves @State with
# a mutating setter and the build fails with
# "cannot assign to property: 'self' is immutable" on every @State assignment.
# Without the plugin we pin an installed SDK whose SwiftUICore still ships
# property-wrapper @State. When the active toolchain provides the plugin,
# the default SDK is used again with no pinning.

set -euo pipefail

main() {
  local dev_dir sdk_dir sdk iface arch swiftc active_sdk_dir

  if ! dev_dir=$(xcode-select --print-path 2>/dev/null) || [[ -z "${dev_dir}" ]]; then
    echo "No active developer directory — install Xcode or Command Line Tools." >&2
    return 1
  fi

  # Toolchains that ship the SwiftUIMacros plugin can expand the macro-based
  # @State from the newest SDK without help.
  swiftc=$(xcrun --find swiftc)
  if [[ -e "${swiftc%/bin/swiftc}/lib/swift/host/plugins/libSwiftUIMacros.dylib" ]]; then
    return 0
  fi

  # Xcode and CLT keep SDKs separately; CLT may retain the last compatible SDK
  # after Xcode upgrades its SDKs to macro-based SwiftUI.
  active_sdk_dir=$(dirname "$(xcrun --sdk macosx --show-sdk-path)")
  for sdk_dir in "${active_sdk_dir}" /Library/Developer/CommandLineTools/SDKs; do
    while IFS= read -r sdk; do
      [[ -d "${sdk}" && ! -L "${sdk}" ]] || continue
      for arch in arm64e-apple-macos x86_64-apple-macos; do
        iface="${sdk}/System/Library/Frameworks/SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/${arch}.swiftinterface"
        if [[ -f "${iface}" ]] && ! grep -q 'macro State() = #externalMacro' "${iface}"; then
          echo "${sdk}"
          return 0
        fi
      done
    done < <(printf '%s\n' "${sdk_dir}"/MacOSX*.sdk | sort -rV)
  done

  echo "No installed Xcode or CLT SDK can build SwiftUI with the active toolchain" >&2
  echo "(SwiftUIMacros plugin missing and no SDK with property-wrapper @State)." >&2
  echo "Install Xcode, or a Command Line Tools release that ships the plugin." >&2
  return 1
}

main "$@"
