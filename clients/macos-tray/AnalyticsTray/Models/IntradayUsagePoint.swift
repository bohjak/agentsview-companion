import Foundation

struct IntradayUsagePoint: Identifiable, Equatable {
    var id: Date { bucketStart }
    let bucketStart: Date
    let costUSD: Double
}
