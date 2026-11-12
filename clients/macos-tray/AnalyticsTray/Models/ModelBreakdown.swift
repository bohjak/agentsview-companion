struct ModelBreakdown: Identifiable, Equatable {
    var id: String { modelID }
    let modelID: String
    let costUSD: Double
}
