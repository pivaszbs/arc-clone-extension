import Foundation

/// Links saved from other apps' share sheets (the "Cra" share extension), waiting for the app:
/// `share-inbox.json` in the App Group both share. Arc Search's extension shows "Saved" with a
/// picker of where the link goes and remembers the last place; here the places are the phone's
/// tabs and "Favorite in App". The app takes the links the next time it comes to the front.
public struct MobileShareInbox: Codable, Equatable {
    public static let appGroup = "group.dk.kildahl.cra"
    public static let fileName = "share-inbox.json"
    /// More waiting than this and the oldest go: the extension can run many times before the app does.
    public static let limit = 50

    public enum Destination: Codable, Equatable, Hashable, Identifiable, Sendable {
        /// A new tab in the tab row (not opened over what is on screen).
        case tabs
        /// "Favorite in App": under the empty search field.
        case favorites
        /// "Browse for Me": open an instant AI summary of the shared URL or question.
        case browseForMe
        /// Pin directly to a synced Space (and optional folder).
        case space(UUID, folderID: UUID? = nil)

        public static var allCases: [Destination] { [.tabs, .favorites, .browseForMe] }

        public var rawValue: String {
            switch self {
            case .tabs: return "tabs"
            case .favorites: return "favorites"
            case .browseForMe: return "browseForMe"
            case .space(let sid, let fid):
                if let fid { return "space:\(sid.uuidString):\(fid.uuidString)" }
                return "space:\(sid.uuidString)"
            }
        }

        public init?(rawValue: String) {
            switch rawValue {
            case "tabs": self = .tabs
            case "favorites": self = .favorites
            case "browseForMe": self = .browseForMe
            default:
                guard rawValue.hasPrefix("space:") else { return nil }
                let parts = rawValue.dropFirst("space:".count).split(separator: ":", omittingEmptySubsequences: false)
                guard let first = parts.first, let sid = UUID(uuidString: String(first)), parts.count <= 2 else { return nil }
                if parts.count == 2 {
                    guard let fid = UUID(uuidString: String(parts[1])) else { return nil }
                    self = .space(sid, folderID: fid)
                } else {
                    self = .space(sid, folderID: nil)
                }
            }
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            let raw = try c.decode(String.self)
            guard let parsed = Self(rawValue: raw) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unknown share destination: \(raw)")
            }
            self = parsed
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            try c.encode(rawValue)
        }

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .tabs: return "Tabs"
            case .favorites: return "Favorites"
            case .browseForMe: return "Browse for Me"
            case .space: return "Space"
            }
        }

        public var symbol: String {
            switch self {
            case .tabs: return "square.on.square"
            case .favorites: return "pin.fill"
            case .browseForMe: return "sparkles"
            case .space: return "rectangle.stack"
            }
        }
    }

    public struct Item: Codable, Equatable {
        public var url: String
        public var title: String
        public var destination: Destination
        public var savedAt: Date

        public init(url: String, title: String, destination: Destination, savedAt: Date) {
            self.url = url
            self.title = title
            self.destination = destination
            self.savedAt = savedAt
        }
    }

    public var items: [Item] = []
    /// Where the picker starts next time.
    public var lastDestination: Destination = .tabs

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try? c.decodeIfPresent([Item].self, forKey: .items)) ?? []
        lastDestination = (try? c.decodeIfPresent(Destination.self, forKey: .lastDestination)) ?? .tabs
    }

    private enum CodingKeys: String, CodingKey { case items, lastDestination }

    /// Keeps a web page for the app. Anything but an http(s) address is refused; the same page
    /// for the same place waiting already is kept once. Returns whether it was kept.
    @discardableResult
    public mutating func save(url: String, title: String, to destination: Destination, at date: Date) -> Bool {
        guard let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(),
              scheme == "https" || scheme == "http", parsed.host?.isEmpty == false else { return false }
        lastDestination = destination
        items.removeAll { $0.url == url && $0.destination == destination }
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        items.append(Item(url: url, title: name.isEmpty ? (parsed.host ?? url) : name, destination: destination, savedAt: date))
        if items.count > Self.limit { items.removeFirst(items.count - Self.limit) }
        return true
    }

    /// The waiting links, oldest first, leaving the inbox empty (the last place stays).
    public mutating func take() -> [Item] {
        defer { items = [] }
        return items
    }

    /// Reads, changes and writes the inbox in `folder` as one coordinated step, so the extension
    /// and the app never write over each other.
    @discardableResult
    public static func update<T>(in folder: URL, _ change: (inout MobileShareInbox) -> T) -> T? {
        let file = folder.appendingPathComponent(fileName)
        var result: T?
        var error: NSError?
        NSFileCoordinator().coordinate(writingItemAt: file, options: [], error: &error) { url in
            var inbox = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder.inbox.decode(MobileShareInbox.self, from: $0) } ?? MobileShareInbox()
            let before = inbox
            result = change(&inbox)
            guard inbox != before, let data = try? JSONEncoder.inbox.encode(inbox) else { return }
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
        return result
    }
}

private extension JSONDecoder {
    static var inbox: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

private extension JSONEncoder {
    static var inbox: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
