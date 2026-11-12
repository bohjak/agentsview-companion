import Foundation

struct UsageSnapshot: Equatable {
    let loadedAt: Date
    let serverURL: URL
    let today: UsageBucket
    let week: UsageBucket
    let dailyCost: [DailyCostPoint]
    let intradayUsage: [IntradayUsagePoint]
    let topModels: [ModelBreakdown]
    let topRepos: [RepoBreakdown]
    let notices: [String]
    let topListsPeriod: TopListsPeriod
}
