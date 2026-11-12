import Foundation

struct AgentsViewClient {
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let transport: Transport
    private let dataDirectory: URL

    init(
        dataDirectory: URL? = nil,
        transport: @escaping Transport = { try await AgentsViewHTTP.session.data(for: $0) }
    ) {
        let environment = ProcessInfo.processInfo.environment
        self.dataDirectory = dataDirectory ?? URL(fileURLWithPath:
            environment["AGENTSVIEW_DATA_DIR"]
                ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".agentsview").path
        )
        self.transport = transport
    }

    func loadSnapshot(
        serverURL: String,
        now: Date = Date(),
        calendar: Calendar = .current,
        topListsPeriod: TopListsPeriod = .week7
    ) async throws -> UsageSnapshot {
        let baseURL = try await resolveServer(override: serverURL)
        let today = calendar.startOfDay(for: now)
        let weekStart = calendar.date(byAdding: .day, value: -6, to: today)!
        let chartStart = calendar.date(byAdding: .day, value: -146, to: today)!
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        let date = formatter.string(from: today)
        let common = [
            URLQueryItem(name: "to", value: date),
            URLQueryItem(name: "timezone", value: calendar.timeZone.identifier),
            URLQueryItem(name: "include_automated", value: "true"),
            URLQueryItem(name: "include_one_shot", value: "true")
        ]
        let path = "api/v1/usage/summary"
        async let todayRequest: Reply<UsageReport> = get(baseURL, path: path, query:
            common + [URLQueryItem(name: "from", value: date)])
        async let weekRequest: Reply<UsageReport> = get(baseURL, path: path, query:
            common + [URLQueryItem(name: "from", value: formatter.string(from: weekStart))])
        async let historyRequest: Reply<UsageReport> = get(baseURL, path: path, query:
            common + [
                URLQueryItem(name: "from", value: formatter.string(from: chartStart)),
                URLQueryItem(name: "breakdowns", value: "false"),
                URLQueryItem(name: "session_counts", value: "false")
            ])
        async let activityRequest = activity(baseURL, date: date, timezone: calendar.timeZone.identifier)
        let (todayReply, weekReply, historyReply, activityReply) = try await (
            todayRequest, weekRequest, historyRequest, activityRequest
        )
        let todayReport = todayReply.value
        let weekReport = weekReply.value
        let topReport = topListsPeriod == .today ? todayReport : weekReport
        var notices = weekReport.notices.map { "Past 7 days: " + $0 }
        for notice in todayReport.notices where !weekReport.notices.contains(notice) {
            notices.append("Today: " + notice)
        }
        if todayReply.stale || weekReply.stale || historyReply.stale || activityReply?.stale == true {
            notices.append("AgentsView is catching up; displayed usage may be stale.")
        }
        if activityReply == nil {
            notices.append("Intraday activity is unavailable from AgentsView.")
        }
        let dailyByDate = Dictionary(grouping: historyReply.value.daily, by: \.date)
        let dailyCost = (0..<147).reversed().map { offset -> DailyCostPoint in
            let day = calendar.date(byAdding: .day, value: -offset, to: today)!
            let rows = dailyByDate[formatter.string(from: day)] ?? []
            return DailyCostPoint(
                day: day,
                costUSD: rows.reduce(0) { $0 + $1.totalCost.usd }
            )
        }
        let timestamp = ISO8601DateFormatter()
        let intraday = (activityReply?.value.buckets ?? []).compactMap { bucket -> IntradayUsagePoint? in
            guard let start = timestamp.date(from: bucket.start), start <= now else { return nil }
            return IntradayUsagePoint(bucketStart: start, costUSD: bucket.cost.usd)
        }
        return UsageSnapshot(
            loadedAt: now,
            serverURL: baseURL,
            today: todayReport.bucket,
            week: weekReport.bucket,
            dailyCost: dailyCost,
            intradayUsage: intraday,
            topModels: topReport.modelTotals.sorted {
                $0.cost.microdollars == $1.cost.microdollars
                    ? $0.model < $1.model : $0.cost.microdollars > $1.cost.microdollars
            }.prefix(5).map { ModelBreakdown(modelID: $0.model, costUSD: $0.cost.usd) },
            topRepos: topReport.projectTotals.sorted {
                $0.cost.microdollars == $1.cost.microdollars
                    ? $0.project_key < $1.project_key : $0.cost.microdollars > $1.cost.microdollars
            }.prefix(5).map { RepoBreakdown(id: $0.project_key, repo: $0.project, costUSD: $0.cost.usd) },
            notices: notices,
            topListsPeriod: topListsPeriod
        )
    }

    private func activity(_ base: URL, date: String, timezone: String) async throws -> Reply<ActivityReport>? {
        do {
            return try await get(base, path: "api/v1/activity/report", query: [
                URLQueryItem(name: "preset", value: "day"),
                URLQueryItem(name: "date", value: date),
                URLQueryItem(name: "timezone", value: timezone),
                URLQueryItem(name: "bucket", value: "15m"),
                URLQueryItem(name: "automation", value: "all")
            ])
        } catch {
            try Task.checkCancellation()
            return nil
        }
    }

    func resolveServer(override: String) async throws -> URL {
        let explicit = override.trimmingCharacters(in: .whitespacesAndNewlines)
        if !explicit.isEmpty {
            return try Self.localURL(explicit)
        }
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dataDirectory, includingPropertiesForKeys: nil
        )) ?? []
        let records = files.filter { $0.lastPathComponent.hasPrefix("daemon.") && $0.pathExtension == "json" }
            .compactMap { file -> RuntimeRecord? in
                guard let data = try? Data(contentsOf: file) else { return nil }
                return try? JSONDecoder().decode(RuntimeRecord.self, from: data)
            }
            .filter { $0.service == "agentsview" && $0.network == "tcp" && $0.metadata?["read_only"] != "true" }
            .sorted { ($0.started_at ?? "") > ($1.started_at ?? "") }
        for record in records {
            try Task.checkCancellation()
            guard let url = try? Self.localURL("http://" + record.address) else { continue }
            do {
                let ping: Reply<Ping> = try await get(url, path: "api/ping", timeout: 2)
                if ping.value.service == "agentsview" && ping.value.pid == record.pid && ping.value.ok {
                    return url
                }
            } catch {
                try Task.checkCancellation()
            }
        }
        throw AgentsViewError.notRunning
    }

    static func localURL(_ text: String) throws -> URL {
        guard let parts = URLComponents(string: text),
              ["http", "https"].contains(parts.scheme),
              let host = parts.host, ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              let url = parts.url else {
            throw AgentsViewError.invalidURL
        }
        return url
    }

    private func get<T: Decodable>(
        _ base: URL, path: String, query: [URLQueryItem] = [], timeout: TimeInterval = 60
    ) async throws -> Reply<T> {
        var parts = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { parts.queryItems = query }
        var request = URLRequest(url: parts.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else { throw AgentsViewError.invalidResponse }
        guard http.statusCode == 200 else { throw AgentsViewError.http(http.statusCode) }
        do {
            return Reply(
                value: try JSONDecoder().decode(T.self, from: data),
                stale: http.value(forHTTPHeaderField: "X-Agentsview-Archive-Stale") == "true"
            )
        } catch {
            throw AgentsViewError.invalidResponse
        }
    }
}

private struct Reply<T> {
    let value: T
    let stale: Bool
}

private struct RuntimeRecord: Decodable {
    let service: String
    let network: String
    let address: String
    let pid: Int
    let started_at: String?
    let metadata: [String: String]?
}

private struct Ping: Decodable {
    let ok: Bool
    let service: String
    let pid: Int
}

private struct Money: Decodable {
    let microdollars: Int64
    var usd: Double { Double(microdollars) / 1_000_000 }
}

private struct UsageTotals: Decodable {
    let inputTokens: Int64
    let outputTokens: Int64
    let cacheCreationTokens: Int64
    let cacheReadTokens: Int64
    let totalCost: Money
    var tokens: Int64 { inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens }
}

private struct UsageDay: Decodable {
    let date: String
    let totalCost: Money
}

private struct UsageReport: Decodable {
    struct SessionCounts: Decodable { let total: Int64 }
    struct Model: Decodable { let model: String; let cost: Money }
    struct Project: Decodable { let project_key: String; let project: String; let cost: Money }
    struct Pricing: Decodable {
        struct Model: Decodable {
            struct Resolution: Decodable {
                let cost_source: String
                let matched_pattern: String?
            }
            let resolutions: [Resolution]
        }
        let models: [String: Model]
    }
    struct Unsupported: Decodable { let kind: String }

    let totals: UsageTotals
    let daily: [UsageDay]
    let sessionCounts: SessionCounts
    let modelTotals: [Model]
    let projectTotals: [Project]
    let pricing: Pricing?
    let unsupportedUsage: Unsupported?
    let planOnlySessions: Int?
    let partlyCapturedSessions: Int?

    var bucket: UsageBucket {
        UsageBucket(
            costUSD: totals.totalCost.usd,
            tokens: totals.tokens,
            uncachedTokens: totals.inputTokens + totals.outputTokens,
            sessions: sessionCounts.total
        )
    }

    var notices: [String] {
        var result: [String] = []
        let unpriced = pricing?.models.filter { _, model in
            model.resolutions.contains { $0.cost_source == "computed" && $0.matched_pattern == nil }
        }.keys.sorted() ?? []
        if !unpriced.isEmpty { result.append("Unpriced models: " + unpriced.joined(separator: ", ")) }
        if let count = planOnlySessions, count > 0 {
            result.append("\(count) plan-usage \(count == 1 ? "session" : "sessions") excluded from token and cost totals.")
        }
        if let count = partlyCapturedSessions, count > 0 {
            result.append("\(count) \(count == 1 ? "session has" : "sessions have") incomplete token capture.")
        }
        if unsupportedUsage != nil { result.append("Some selected sessions do not expose token usage to AgentsView.") }
        return result
    }
}

private struct ActivityReport: Decodable {
    struct Bucket: Decodable {
        let start: String
        let cost: Money
    }
    let buckets: [Bucket]
}

enum AgentsViewError: LocalizedError {
    case notRunning
    case invalidURL
    case invalidResponse
    case http(Int)

    var errorDescription: String? {
        switch self {
        case .notRunning:
            return "AgentsView is not running. Start it with 'agentsview daemon start', or set its local server URL in Settings."
        case .invalidURL:
            return "Enter an HTTP or HTTPS loopback URL, such as http://127.0.0.1:8080, without credentials or query parameters."
        case .invalidResponse:
            return "AgentsView returned an unsupported response. Check that the server and ToTally are compatible."
        case .http(401), .http(403):
            return "AgentsView requires authentication or denied access. This client currently connects to unauthenticated loopback servers."
        case .http(let code):
            return "AgentsView returned HTTP \(code)."
        }
    }
}

private final class AgentsViewHTTP: NSObject, URLSessionTaskDelegate {
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 90
        return URLSession(configuration: configuration, delegate: AgentsViewHTTP(), delegateQueue: nil)
    }()

    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
