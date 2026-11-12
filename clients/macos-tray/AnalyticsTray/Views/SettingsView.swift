import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @ObservedObject var settings: AppSettings
    let onRefresh: @MainActor () -> Void
    @State private var launchAtLoginError: String?

    var body: some View {
        Form {
            Section {
                TextField("Server URL", text: $settings.serverURL, prompt: Text("Automatic discovery"))
                    .textFieldStyle(.roundedBorder)
                if !settings.serverURL.isEmpty,
                   (try? AgentsViewClient.localURL(settings.serverURL)) == nil {
                    Label("Enter a local HTTP or HTTPS server URL.", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            } header: {
                Text("AgentsView")
            } footer: {
                Text("Leave blank to discover the running local daemon. Start AgentsView separately; AgentsView Companion does not manage it.")
            }
            Section("Refresh") {
                Picker("Interval", selection: $settings.refreshInterval) {
                    Text("30 seconds").tag(TimeInterval(30))
                    Text("1 minute").tag(TimeInterval(60))
                    Text("5 minutes").tag(TimeInterval(300))
                    Text("15 minutes").tag(TimeInterval(900))
                    Text("30 minutes").tag(TimeInterval(1800))
                }
                Button("Refresh Now", action: onRefresh)
            }
            Section("Menu bar") {
                Picker("Display", selection: $settings.menuBarDisplayMode) {
                    ForEach(MenuBarDisplayMode.allCases) { mode in
                        Text(mode.displayName).tag(mode)
                    }
                }
                .pickerStyle(.radioGroup)
            }
            Section {
                Toggle("Include cached tokens", isOn: $settings.includeCachedTokens)
            } header: {
                Text("Tokens")
            } footer: {
                Text("Applies to the menu bar and summary cards. Off excludes cache reads and writes; costs are unchanged.")
            }
            Section("Popover") {
                Picker("Top Models & Projects", selection: $settings.topListsPeriod) {
                    ForEach(TopListsPeriod.allCases) { period in
                        Text(period.displayName).tag(period)
                    }
                }
                .pickerStyle(.radioGroup)
            }
            Section("Accounting") {
                Text("Usage, pricing, and project attribution come from AgentsView.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            startupSection
            Section {
                Button("Reset to Defaults", role: .destructive) {
                    settings.resetToDefaults()
                    launchAtLoginError = nil
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 420, height: 620)
    }

    private var startupSection: some View {
        Section {
            // Use a manual Binding so we can intercept the set: path, attempt
            // SMAppService registration, and only write back to settings on
            // success. On failure the toggle reverts to the old value without
            // any flag or re-entrancy guard needed.
            Toggle(
                "Launch at login",
                isOn: Binding(
                    get: { settings.launchAtLogin },
                    set: { newValue in attemptSetLaunchAtLogin(newValue) }
                )
            )

            // Error banner - shown only after a failed registration attempt.
            if let error = launchAtLoginError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // Prevent the text from collapsing to one clipped line.
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text("Startup")
        } footer: {
            Text(
                "Launch at login requires the app to be installed as a " +
                "signed .app bundle in /Applications."
            )
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
    }


    private func attemptSetLaunchAtLogin(_ enable: Bool) {
        do {
            if enable {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            // Only commit to settings after a successful system call. On failure
            // we never write, so the Toggle's get: returns the unchanged old value
            // and the control reverts automatically.
            settings.launchAtLogin = enable
            launchAtLoginError = nil
        } catch {
            let action = enable ? "enable" : "disable"
            launchAtLoginError = Self.launchAtLoginErrorMessage(
                action: action,
                underlying: error
            )
            // settings.launchAtLogin is intentionally NOT updated on failure.
        }
    }

    private static func launchAtLoginErrorMessage(action: String, underlying error: Error) -> String {
        "Could not \(action) launch at login. " +
        "Make sure the app is installed as a signed bundle in /Applications. " +
        "(\(error.localizedDescription))"
    }
}
