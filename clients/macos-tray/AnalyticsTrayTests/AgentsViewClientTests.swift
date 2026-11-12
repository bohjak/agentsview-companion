import Foundation
import Testing
@testable import AnalyticsTray

@Suite("AgentsView client")
struct AgentsViewClientTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }
    private var now: Date { ISO8601DateFormatter().date(from: "2026-03-10T18:00:00Z")! }

    @Test func mapsReportsWithoutRepricingOrDroppingCacheTokens() async throws {
        let fixture = ReportServer()
        let client = AgentsViewClient(transport: { try await fixture.respond($0) })
        let snapshot = try await client.loadSnapshot(
            serverURL: "http://127.0.0.1:8080", now: now, calendar: calendar
        )
        #expect(snapshot.today.costUSD == 1.234567)
        #expect(snapshot.week.costUSD == 9.876543)
        #expect(snapshot.today.displayedTokens(includeCached: true) == 550_000)
        #expect(snapshot.today.displayedTokens(includeCached: false) == 120_000)
        #expect(snapshot.today.sessions == 42)
        #expect(snapshot.topModels.first?.modelID == "weekly-model")
        #expect(snapshot.topRepos.map(\.id) == ["project-a", "project-b"])
        #expect(snapshot.topRepos.map(\.repo) == ["same-name", "same-name"])
        #expect(snapshot.dailyCost.count == 147)
        #expect(snapshot.dailyCost.last?.costUSD == 1.234567)
        #expect(snapshot.dailyCost.dropLast().allSatisfy { $0.costUSD == 0 })
        #expect(snapshot.intradayUsage.count == 1)
        #expect(snapshot.intradayUsage.first?.costUSD == 0.25)
        #expect(!snapshot.notices.contains { $0.contains("catalog estimates") })
        #expect(snapshot.notices.contains { $0.contains("Unpriced models: missing-model") })
        #expect(snapshot.notices.contains { $0.contains("2 plan-usage sessions") })
        #expect(snapshot.notices.contains { $0.contains("1 session has incomplete") })
        let requests = await fixture.requests
        let week = requests.first { $0.url?.query?.contains("from=2026-03-04") == true }
        #expect(week != nil)
        let query = URLComponents(url: week!.url!, resolvingAgainstBaseURL: false)!.queryItems!
        #expect(query.contains(URLQueryItem(name: "timezone", value: "America/New_York")))
        #expect(query.contains(URLQueryItem(name: "include_automated", value: "true")))
        #expect(query.contains(URLQueryItem(name: "include_one_shot", value: "true")))
        #expect(requests.allSatisfy { $0.httpMethod == "GET" })
    }

    @Test func todaySelectionUsesTodayBreakdowns() async throws {
        let fixture = ReportServer()
        let snapshot = try await AgentsViewClient(transport: { try await fixture.respond($0) }).loadSnapshot(
            serverURL: "http://localhost:8080", now: now, calendar: calendar, topListsPeriod: .today
        )
        #expect(snapshot.topModels.first?.modelID == "today-model")
        #expect(snapshot.week.costUSD == 9.876543)
    }

    @Test func missingDecorationDoesNotHideUsageAndStaleHeadersAreVisible() async throws {
        let fixture = ReportServer(activityFails: true, stale: true)
        let snapshot = try await AgentsViewClient(transport: { try await fixture.respond($0) }).loadSnapshot(
            serverURL: "http://localhost:8080", now: now, calendar: calendar
        )
        #expect(snapshot.today.costUSD == 1.234567)
        #expect(snapshot.intradayUsage.isEmpty)
        #expect(snapshot.notices.contains { $0.contains("may be stale") })
        #expect(snapshot.notices.contains { $0.contains("Intraday activity is unavailable") })
    }

    @Test(arguments: [401, 503]) func httpErrorsAreNotEmptyUsage(status: Int) async throws {
        let client = AgentsViewClient(transport: { request in
            (Data(), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        })
        await #expect(throws: AgentsViewError.self) {
            try await client.loadSnapshot(serverURL: "http://localhost:8080", now: now, calendar: calendar)
        }
    }

    @Test func emptyArchiveHasNoInventedUsageOrWarnings() async throws {
        let client = AgentsViewClient(transport: { request in
            let body = request.url!.path.hasSuffix("activity/report") ? "{\"buckets\":[]}" : """
            {
              "totals":{"inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"totalCost":{"microdollars":0}},
              "daily":[],"sessionCounts":{"total":0},"modelTotals":[],"projectTotals":[],
              "pricing":{"cost_source":"computed","models":{}}
            }
            """
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        let snapshot = try await client.loadSnapshot(serverURL: "http://localhost:8080", now: now, calendar: calendar)
        #expect(snapshot.today.isEmpty)
        #expect(snapshot.week.isEmpty)
        #expect(snapshot.notices.isEmpty)
        #expect(snapshot.dailyCost.allSatisfy { $0.costUSD == 0 })
    }

    @Test func incompatibleResponseIsNotZeroSpend() async {
        let client = AgentsViewClient(transport: { request in
            (Data("{}".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        await #expect(throws: AgentsViewError.self) {
            try await client.loadSnapshot(serverURL: "http://localhost:8080", now: now, calendar: calendar)
        }
    }

    @Test(arguments: ["https://example.com", "file:///tmp/usage", "http://user:password@localhost:8080", "http://localhost:8080?token=secret"])
    func refusesNonLocalOrCredentialBearingURLs(url: String) {
        #expect(throws: AgentsViewError.self) { try AgentsViewClient.localURL(url) }
    }

    @Test func discoverySkipsStaleRecordsAndRediscoversChangedPorts() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let stale = directory.appendingPathComponent("daemon.11.json")
        let live = directory.appendingPathComponent("daemon.12.json")
        try Data("""
        {"service":"agentsview","network":"tcp","pid":11,"address":"127.0.0.1:50001","started_at":"2026-03-11"}
        """.utf8).write(to: stale)
        try Data("""
        {"service":"agentsview","network":"tcp","pid":12,"address":"127.0.0.1:50002","started_at":"2026-03-10"}
        """.utf8).write(to: live)
        let client = AgentsViewClient(dataDirectory: directory, transport: { request in
            let pid = request.url!.port == 50001 ? 99 : 12
            return (
                Data("{\"ok\":true,\"service\":\"agentsview\",\"pid\":\(pid)}".utf8),
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            )
        })
        #expect(try await client.resolveServer(override: "").port == 50002)
        try Data("""
        {"service":"agentsview","network":"tcp","pid":12,"address":"127.0.0.1:50003"}
        """.utf8).write(to: live)
        #expect(try await client.resolveServer(override: "").port == 50003)
    }

    @Test func absentDaemonDoesNotStartAnything() async {
        let absent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let client = AgentsViewClient(dataDirectory: absent, transport: { _ in
            Issue.record("No network request should be made without a discovered daemon")
            throw URLError(.cannotConnectToHost)
        })
        await #expect(throws: AgentsViewError.self) { try await client.resolveServer(override: "") }
        #expect(!FileManager.default.fileExists(atPath: absent.path))
    }

    @Test @MainActor func tokenPreferencePersistsAndResets() {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = AppSettings(defaults: defaults)
        #expect(settings.includeCachedTokens)
        settings.includeCachedTokens = false
        let restored = AppSettings(defaults: defaults)
        #expect(!restored.includeCachedTokens)
        restored.resetToDefaults()
        #expect(AppSettings(defaults: defaults).includeCachedTokens)
    }

    @Test @MainActor func tokenToggleReformatsSnapshotWithoutRefetchingOrChangingCost() async throws {
        let fixture = ReportServer()
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = AppSettings(defaults: defaults)
        settings.serverURL = "http://localhost:8080"
        let store = AnalyticsStore(settings: settings, client: AgentsViewClient(transport: { try await fixture.respond($0) }))
        store.refresh()
        try await waitForRefresh(store)
        let snapshot = try #require(store.lastSnapshot)
        let initialTitle = store.menuBarTitle
        let requestCount = await fixture.requests.count
        #expect(initialTitle.hasPrefix("Σ 0.55M · "))
        settings.includeCachedTokens = false
        try await waitForTitle(store, prefix: "Σ 0.12M · ")
        #expect(store.menuBarTitle.hasPrefix("Σ 0.12M · "))
        #expect(store.menuBarTitle.components(separatedBy: " · ").last == initialTitle.components(separatedBy: " · ").last)
        settings.includeCachedTokens = true
        try await waitForTitle(store, prefix: "Σ 0.55M · ")
        #expect(store.menuBarTitle == initialTitle)
        #expect(store.lastSnapshot == snapshot)
        #expect(await fixture.requests.count == requestCount)
    }

    @MainActor private func waitForTitle(_ store: AnalyticsStore, prefix: String) async throws {
        for _ in 0..<100 {
            if store.menuBarTitle.hasPrefix(prefix) { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("Token display did not update within one second")
    }

    @Test @MainActor func disconnectPreservesLastSnapshotAndMarksMenuBarStale() async throws {
        let fixture = ReportServer()
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = AppSettings(defaults: defaults)
        settings.serverURL = "http://localhost:8080"
        let store = AnalyticsStore(settings: settings, client: AgentsViewClient(transport: { try await fixture.respond($0) }))
        store.refresh()
        try await waitForRefresh(store)
        let snapshot = try #require(store.lastSnapshot)
        await fixture.disconnect()
        store.refresh()
        try await waitForRefresh(store)
        #expect(store.lastSnapshot == snapshot)
        if case .unavailable = store.state {} else { Issue.record("Expected disconnected state") }
        #expect(store.menuBarTitle.hasSuffix("⚠"))
    }

    @MainActor private func waitForRefresh(_ store: AnalyticsStore) async throws {
        for _ in 0..<100 {
            try await Task.sleep(for: .milliseconds(10))
            switch store.state {
            case .idle, .loading: continue
            default: return
            }
        }
        Issue.record("Refresh did not complete within one second")
    }
}

private actor ReportServer {
    var requests: [URLRequest] = []
    let activityFails: Bool
    let stale: Bool
    private var disconnected = false

    init(activityFails: Bool = false, stale: Bool = false) {
        self.activityFails = activityFails
        self.stale = stale
    }

    func disconnect() { disconnected = true }

    func respond(_ request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        if disconnected { throw URLError(.cannotConnectToHost) }
        let url = request.url!
        let isActivity = url.path.hasSuffix("activity/report")
        let from = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "from" }?.value
        let isToday = from == "2026-03-10"
        let data: String
        if isActivity {
            data = """
            {"buckets":[
                {"start":"2026-03-10T04:00:00Z","cost":{"microdollars":250000},"output_tokens":10},
                {"start":"2026-03-11T04:00:00Z","cost":{"microdollars":900000},"output_tokens":20}
            ]}
            """
        } else {
            data = """
            {
              "totals":{"inputTokens":100000,"outputTokens":20000,"cacheCreationTokens":30000,"cacheReadTokens":400000,"totalCost":{"microdollars":\(isToday ? 1234567 : 9876543)}},
              "daily":[{"date":"2026-03-10","inputTokens":100000,"outputTokens":20000,"cacheCreationTokens":30000,"cacheReadTokens":400000,"totalCost":{"microdollars":1234567}}],
              "sessionCounts":{"total":42},
              "modelTotals":[{"model":"\(isToday ? "today-model" : "weekly-model")","cost":{"microdollars":1000000}}],
              "projectTotals":[
                {"project_key":"project-b","project":"same-name","cost":{"microdollars":100000}},
                {"project_key":"project-a","project":"same-name","cost":{"microdollars":200000}}
              ],
              "pricing":{"cost_source":"computed","models":{"missing-model":{"resolutions":[{"cost_source":"computed","matched_pattern":null}]}}},
              "planOnlySessions":2,"partlyCapturedSessions":1
            }
            """
        }
        return (
            Data(data.utf8),
            HTTPURLResponse(
                url: url, statusCode: isActivity && activityFails ? 503 : 200,
                httpVersion: nil,
                headerFields: stale ? ["X-Agentsview-Archive-Stale": "true"] : [:]
            )!
        )
    }
}
