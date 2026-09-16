import EDraftCore
import Foundation

public typealias PageStarts = [Int]

public let defaultMeasure: CGFloat = 640
let internalOnly: Int = 1

public protocol Paginating {
    func paginate() -> Int
}

public struct SpreadFold {
    let pageTops: [CGFloat]
    public func spreadPoint(fromVertical p: CGPoint) -> CGPoint {
        return normalise(p)
    }
}

public final class ScriptSurface {
    public func reveal(_ id: UUID) -> Bool {
        return helper()
    }
    private func label() -> String { "surface" }
}

actor Indexer {
    func run() {}
}

enum PageArrangement {
    case single, spread, grid
}

extension ScriptSurface: Paginating {
    public func paginate() -> Int { 0 }
}

extension ScriptSurface {
    func firstBare() {}
}

extension ScriptSurface {
    func secondBare() {}
}

func freeFunction(a: Int) -> Int { a }
