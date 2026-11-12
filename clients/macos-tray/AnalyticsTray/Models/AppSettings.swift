import Foundation

// MARK: - TopListsPeriod

/// Controls the time window used for the "Top Models" and "Top Projects" sections
/// in the tray popover.
enum TopListsPeriod: String, CaseIterable, Identifiable {
    /// Show data for calendar today (since local midnight).
    case today
    /// Show data for the rolling 7-day window (today + 6 prior days).
    case week7

    var id: String { rawValue }

    /// Human-readable label used in the Settings UI.
    var displayName: String {
        switch self {
        case .today: return "Today"
        case .week7: return "Past 7 days"
        }
    }

    /// Short label shown next to the section heading in the popover
    /// (e.g. "TOP MODELS · TODAY").
    var sectionLabel: String {
        switch self {
        case .today: return "Today"
        case .week7: return "7 days"
        }
    }
}

// MARK: - MenuBarDisplayMode

/// Controls what the `NSStatusItem` label shows.
enum MenuBarDisplayMode: String, CaseIterable, Identifiable {
    /// "Σ 0.28M · $1.42" — tokens and cost (default).
    case combinedTokensCost
    /// "Σ 0.28M" — tokens only.
    case tokensOnly
    /// "Σ $1.42" — cost only.
    case costOnly
    /// "Σ" — icon only; no numbers.
    case iconOnly

    var id: String { rawValue }

    /// Human-readable label used in the Settings UI.
    var displayName: String {
        switch self {
        case .combinedTokensCost: return "Tokens + cost"
        case .tokensOnly:         return "Tokens only"
        case .costOnly:           return "Cost only"
        case .iconOnly:           return "Icon only"
        }
    }
}

// MARK: - AppSettings

/// Persisted user preferences for ToTally. Backed by `UserDefaults`.
///
/// All keys are namespaced under `"com.token-tally."` to avoid collisions
/// with other apps that share the default `UserDefaults` suite.
///
/// `AnalyticsStore` reads `serverURL`, `refreshInterval`, and
/// `menuBarDisplayMode` directly. Changing `serverURL` or `refreshInterval`
/// triggers a store restart.
@MainActor
final class AppSettings: ObservableObject {
    private let defaults: UserDefaults

    // MARK: UserDefaults keys

    private enum Key {
        static let serverURL          = "com.token-tally.serverURL"
        static let refreshInterval    = "com.token-tally.refreshInterval"
        static let menuBarDisplayMode = "com.token-tally.menuBarDisplayMode"
        static let includeCachedTokens = "com.token-tally.includeCachedTokens"
        static let launchAtLogin      = "com.token-tally.launchAtLogin"
        static let topListsPeriod     = "com.token-tally.topListsPeriod"
    }

    // MARK: Defaults

    static let defaultServerURL = ""

    static let defaultRefreshInterval: TimeInterval = 60
    static let defaultMenuBarDisplayMode: MenuBarDisplayMode = .combinedTokensCost
    static let defaultIncludeCachedTokens = true

    /// Launch at login is enabled by default — ToTally is only useful as a
    /// persistent menu bar presence and has no value if it doesn't auto-start.
    /// Users can disable it from Settings.
    static let defaultLaunchAtLogin = true
    static let defaultTopListsPeriod: TopListsPeriod = .week7

    // MARK: Published properties

    /// Empty selects the running AgentsView daemon in its local data directory.
    @Published var serverURL: String {
        didSet { defaults.set(serverURL, forKey: Key.serverURL) }
    }

    /// How often (in seconds) the background timer refreshes data.
    @Published var refreshInterval: TimeInterval {
        didSet { defaults.set(refreshInterval, forKey: Key.refreshInterval) }
    }

    /// What the menu bar label shows.
    @Published var menuBarDisplayMode: MenuBarDisplayMode {
        didSet {
            defaults.set(menuBarDisplayMode.rawValue, forKey: Key.menuBarDisplayMode)
        }
    }

    @Published var includeCachedTokens: Bool {
        didSet { defaults.set(includeCachedTokens, forKey: Key.includeCachedTokens) }
    }

    /// Whether the app registers itself as a login item.
    /// Registration is best-effort; failures are handled by the caller.
    @Published var launchAtLogin: Bool {
        didSet { defaults.set(launchAtLogin, forKey: Key.launchAtLogin) }
    }

    /// Time window used for the "Top Models" and "Top Projects" sections in the popover.
    @Published var topListsPeriod: TopListsPeriod {
        didSet {
            defaults.set(topListsPeriod.rawValue, forKey: Key.topListsPeriod)
        }
    }

    // MARK: Init

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Load persisted values, falling back to defaults for missing keys.
        serverURL = defaults.string(forKey: Key.serverURL)
            ?? AppSettings.defaultServerURL

        let storedInterval = defaults.double(forKey: Key.refreshInterval)
        // double(forKey:) returns 0 when the key is absent.
        refreshInterval = storedInterval > 0
            ? storedInterval
            : AppSettings.defaultRefreshInterval

        if let raw = defaults.string(forKey: Key.menuBarDisplayMode),
           let mode = MenuBarDisplayMode(rawValue: raw) {
            menuBarDisplayMode = mode
        } else {
            menuBarDisplayMode = AppSettings.defaultMenuBarDisplayMode
        }

        includeCachedTokens = defaults.object(forKey: Key.includeCachedTokens) != nil
            ? defaults.bool(forKey: Key.includeCachedTokens)
            : AppSettings.defaultIncludeCachedTokens

        launchAtLogin = defaults.object(forKey: Key.launchAtLogin) != nil
            ? defaults.bool(forKey: Key.launchAtLogin)
            : AppSettings.defaultLaunchAtLogin

        if let raw = defaults.string(forKey: Key.topListsPeriod),
           let period = TopListsPeriod(rawValue: raw) {
            topListsPeriod = period
        } else {
            topListsPeriod = AppSettings.defaultTopListsPeriod
        }

        // Remove the retired harness filter preference so old installations do
        // not keep stale settings that no longer have UI.
        defaults.removeObject(forKey: "com.token-tally.enabledHarnesses")
    }

    // MARK: Reset

    /// Resets all settings to their defaults and removes persisted values.
    func resetToDefaults() {
        [Key.serverURL, Key.refreshInterval,
         Key.menuBarDisplayMode, Key.includeCachedTokens, Key.launchAtLogin, Key.topListsPeriod].forEach {
            defaults.removeObject(forKey: $0)
        }
        defaults.removeObject(forKey: "com.token-tally.enabledHarnesses")
        serverURL = AppSettings.defaultServerURL
        refreshInterval = AppSettings.defaultRefreshInterval
        menuBarDisplayMode = AppSettings.defaultMenuBarDisplayMode
        includeCachedTokens = AppSettings.defaultIncludeCachedTokens
        launchAtLogin = AppSettings.defaultLaunchAtLogin
        topListsPeriod = AppSettings.defaultTopListsPeriod
    }
}
