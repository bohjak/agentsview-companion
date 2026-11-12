import Foundation
import Combine

enum StoreState: Equatable {
    case idle
    case loading
    case loaded(UsageSnapshot)
    case empty
    case unavailable(String)
}

@MainActor
final class AnalyticsStore: ObservableObject {
    @Published private(set) var state: StoreState = .idle
    @Published private(set) var lastSnapshot: UsageSnapshot?
    @Published private(set) var menuBarTitle: String = "Σ …"

    private let settings: AppSettings
    private let client: AgentsViewClient
    private let timer = AnalyticsRefreshTimer()
    private var currentRefreshTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()

    init(settings: AppSettings, client: AgentsViewClient = AgentsViewClient()) {
        self.settings = settings
        self.client = client

        settings.$serverURL.dropFirst().removeDuplicates()
            .sink { [weak self] _ in
                self?.lastSnapshot = nil
                self?.refresh()
            }
            .store(in: &cancellables)
        settings.$refreshInterval.dropFirst().removeDuplicates()
            .sink { [weak self] _ in self?.startTimer() }
            .store(in: &cancellables)
        settings.$menuBarDisplayMode.dropFirst().removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in self?.updateMenuBarTitle() }
            }
            .store(in: &cancellables)
        settings.$includeCachedTokens.dropFirst().removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in self?.updateMenuBarTitle() }
            }
            .store(in: &cancellables)
        settings.$topListsPeriod.dropFirst().removeDuplicates()
            .sink { [weak self] _ in self?.refresh() }
            .store(in: &cancellables)
        startTimer()
    }

    func refresh() {
        currentRefreshTask?.cancel()
        // Published settings emit before their stored value changes.
        currentRefreshTask = Task { await performRefresh() }
    }

    func refreshOnPopoverOpen() {
        refresh()
    }

    private func performRefresh() async {
        guard !Task.isCancelled else { return }
        state = .loading
        updateMenuBarTitle()
        do {
            let snapshot = try await client.loadSnapshot(
                serverURL: settings.serverURL,
                topListsPeriod: settings.topListsPeriod
            )
            try Task.checkCancellation()
            lastSnapshot = snapshot
            let hasHistory = snapshot.dailyCost.contains { $0.costUSD != 0 }
            state = snapshot.today.isEmpty && snapshot.week.isEmpty && !hasHistory && snapshot.notices.isEmpty
                ? .empty : .loaded(snapshot)
        } catch {
            guard !Task.isCancelled else { return }
            state = .unavailable(error.localizedDescription)
        }
        updateMenuBarTitle()
    }

    private func updateMenuBarTitle() {
        if let snapshot = lastSnapshot {
            let title = Formatters.menuBarTitle(
                tokens: snapshot.today.displayedTokens(includeCached: settings.includeCachedTokens),
                cost: snapshot.today.costUSD,
                mode: settings.menuBarDisplayMode
            )
            if case .unavailable = state {
                menuBarTitle = title + " ⚠"
            } else {
                menuBarTitle = title
            }
        } else {
            switch state {
            case .idle, .loading: menuBarTitle = "Σ …"
            default: menuBarTitle = "Σ —"
            }
        }
    }

    deinit {
        currentRefreshTask?.cancel()
        let timer = timer
        Task { await timer.cancel() }
    }

    private func startTimer() {
        Task { [timer, interval = settings.refreshInterval, weak self] in
            await timer.start(interval: interval) { [weak self] in
                await self?.refreshFromTimer()
            }
        }
    }

    private func refreshFromTimer() {
        if case .loading = state { return }
        refresh()
    }
}
