import SwiftUI
import AppKit
import Combine

// MARK: - AnalyticsEnvironment

/// Shared container for `AppSettings` and `AnalyticsStore`.
///
/// Because `PopoverController` instantiates `PopoverView()` with no arguments,
/// `PopoverView` must own the store internally. Using a single wrapper class
/// lets both objects share the same `AppSettings` instance without the
/// chicken-and-egg problem of initialising one `@StateObject` from another.
///
/// `PopoverController` creates `PopoverView` once during its own `init()`, so
/// this environment lives for the full app lifetime — exactly what we want.
@MainActor
final class AnalyticsEnvironment: ObservableObject {
    let settings: AppSettings
    let store: AnalyticsStore

    private var cancellables = Set<AnyCancellable>()

    init(settings: AppSettings? = nil, client: AgentsViewClient = AgentsViewClient()) {
        let s = settings ?? AppSettings()
        self.settings = s
        store = AnalyticsStore(settings: s, client: client)

        // Forward store changes so SwiftUI re-renders when refreshes transition
        // between idle/loading and loaded/error states.
        store.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)

        // Broadcast title updates so StatusItemController can update the label
        // without a direct reference to the store.
        //
        // dropFirst() suppresses the initial placeholder that AnalyticsStore
        // emits before its first real refresh. StatusItemController sets its
        // own "Σ …" placeholder at init time, which should remain
        // visible until actual data arrives.
        store.$menuBarTitle
            .dropFirst()
            .removeDuplicates()
            .sink { title in
                NotificationCenter.default.post(
                    name: .analyticsMenuBarTitleChanged,
                    object: nil,
                    userInfo: ["title": title]
                )
            }
            .store(in: &cancellables)
    }

    func refreshOnStartup() {
        store.refresh()
    }
}

// MARK: - Notification name

extension Notification.Name {
    /// Posted by `AnalyticsEnvironment` whenever `AnalyticsStore.menuBarTitle`
    /// changes. `userInfo["title"]` contains the new `String` value.
    /// `StatusItemController` observes this to update the `NSStatusItem` label.
    static let analyticsMenuBarTitleChanged = Notification.Name(
        "com.token-tally.menuBarTitleChanged"
    )
}

// MARK: - PopoverView

/// Root SwiftUI view hosted inside `NSPopover` via `NSHostingController`.
///
/// Responsibilities:
/// - Own an `AnalyticsEnvironment` (settings + store) for the popover lifetime.
/// - Trigger a refresh when the popover appears.
/// - Switch over `StoreState` to show the appropriate content section.
/// - Show header controls (settings, quit) and a footer action row.
@MainActor
struct PopoverView: View {

    @ObservedObject private var env: AnalyticsEnvironment
    private let closePopover: @MainActor () -> Void

    init(closePopover: @escaping @MainActor () -> Void = {}) {
        env = AnalyticsEnvironment()
        self.closePopover = closePopover
    }

    init(
        environment: AnalyticsEnvironment,
        closePopover: @escaping @MainActor () -> Void = {}
    ) {
        env = environment
        self.closePopover = closePopover
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerBar
            Divider()
            contentArea
                .frame(maxWidth: .infinity)
        }
        .frame(width: 280)
        .onAppear {
            env.store.refreshOnPopoverOpen()
        }
    }

    // MARK: - Header bar

    private var headerBar: some View {
        HStack {
            Text("ToTally")
                .font(.headline)
            Spacer()
            // Compact spinner alongside the title when a background refresh is
            // running and we already have data to display (avoids showing the
            // spinner + full loading view simultaneously).
            if case .loading = env.store.state, env.store.lastSnapshot != nil {
                ProgressView()
                    .controlSize(.small)
            }

            Button(action: openSettings) {
                Image(systemName: "gear")
                    .imageScale(.medium)
            }
            .help("Settings")

            Button(action: quitApp) {
                Image(systemName: "power")
                    .imageScale(.medium)
            }
            .help("Quit ToTally")
        }
        .buttonStyle(.plain)
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    // MARK: - Main content area

    @ViewBuilder
    private var contentArea: some View {
        switch env.store.state {

        case .idle:
            loadingPlaceholder

        case .loading:
            if let snapshot = env.store.lastSnapshot {
                // Prefer stale data over a blank loading screen.
                summarySection(snapshot)
            } else {
                loadingPlaceholder
            }

        case .loaded(let snapshot):
            summarySection(snapshot)

        case .empty:
            EmptyStateView()

        case .unavailable(let message):
            if let snapshot = env.store.lastSnapshot {
                VStack(alignment: .leading, spacing: 0) {
                    Label("Disconnected — last updated \(snapshot.loadedAt.formatted(date: .abbreviated, time: .shortened))", systemImage: "exclamationmark.triangle")
                        .fixedSize(horizontal: false, vertical: true)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .padding(12)
                    Button("Retry") { env.store.refresh() }
                        .padding(.horizontal, 12)
                    summarySection(snapshot)
                }
                .help(message)
            } else {
                ErrorStateView(message: message, onRefresh: { env.store.refresh() })
            }
        }
    }

    // MARK: - Summary section (loaded state)

    private func summarySection(_ snapshot: UsageSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {

            // 1. Today summary.
            SummaryCard(
                title: "Today",
                bucket: snapshot.today,
                includeCachedTokens: env.settings.includeCachedTokens,
                backgroundChartValues: snapshot.intradayUsage.map(\.costUSD)
            )

            // 2. This week summary.
            SummaryCard(
                title: "Past 7 days",
                bucket: snapshot.week,
                includeCachedTokens: env.settings.includeCachedTokens,
                backgroundChartValues: Array(snapshot.dailyCost.suffix(7)).map(\.costUSD),
                backgroundChartTrimsZeroEdges: false,
                backgroundChartSmoothingWindow: 1
            )

            // 3. 7-day cost chart.
            if !snapshot.dailyCost.isEmpty {
                DailyCostChartView(points: snapshot.dailyCost)
            }

            // 4. Top models.
            if !snapshot.topModels.isEmpty {
                TopModelsView(
                    models: snapshot.topModels,
                    periodLabel: snapshot.topListsPeriod.sectionLabel
                )
            }

            // 5. Top repositories.
            if !snapshot.topRepos.isEmpty {
                TopReposView(
                    repos: snapshot.topRepos,
                    periodLabel: snapshot.topListsPeriod.sectionLabel
                )
            }

            ForEach(snapshot.notices, id: \.self) { notice in
                Label(notice, systemImage: "info.circle")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // 7. Footer actions.
            footerActions

        }
        .padding(12)
    }

    // MARK: - Footer actions

    private var footerActions: some View {
        HStack(spacing: 8) {
            Button(action: openExplorer) {
                Label("Open AgentsView", systemImage: "globe")
            }
            .help("Open AgentsView usage dashboard")

            Spacer()
        }
        .buttonStyle(.plain)
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    // MARK: - Loading placeholder

    private var loadingPlaceholder: some View {
        VStack(spacing: 8) {
            ProgressView()
                .controlSize(.regular)
            Text("Loading…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    // MARK: - Actions

    private func openSettings() {
        SettingsWindowController.show(settings: env.settings) {
            env.store.refresh()
        }
        closePopover()
    }

    private func openExplorer() {
        Task { @MainActor in
            do {
                let url = try await AgentsViewClient().resolveServer(override: env.settings.serverURL)
                NSWorkspace.shared.open(url.appendingPathComponent("usage"))
            } catch {
                let alert = NSAlert()
                alert.messageText = "AgentsView unavailable"
                alert.informativeText = error.localizedDescription
                alert.runModal()
            }
        }
    }

    private func quitApp() {
        NSApplication.shared.terminate(nil)
    }
}
