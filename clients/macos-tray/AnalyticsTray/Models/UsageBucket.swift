struct UsageBucket: Equatable {
    let costUSD: Double
    let tokens: Int64
    let uncachedTokens: Int64
    let sessions: Int64

    static let zero = UsageBucket(costUSD: 0, tokens: 0, uncachedTokens: 0, sessions: 0)

    func displayedTokens(includeCached: Bool) -> Int64 {
        includeCached ? tokens : uncachedTokens
    }

    var isEmpty: Bool {
        costUSD == 0 && tokens == 0 && sessions == 0
    }
}
