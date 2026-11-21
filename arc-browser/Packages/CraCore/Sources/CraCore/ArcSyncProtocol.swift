import Foundation

// MARK: - iCloud Outbox for iOS / Watchdog-less Write-back

/// One additive mutation queued by iOS when writing back into the iCloud Cra sync folder.
public struct PhonePinMutation: Codable, Equatable, Identifiable, Sendable {
    public enum Action: String, Codable, Equatable, Sendable {
        case pin
        case unpin
        case favorite
        case unfavorite
        case createFolder
        case createSpace
        case sendTab
    }

    public var id: UUID
    public var action: Action
    public var url: String?
    public var title: String?
    public var spaceID: UUID?
    public var folderID: UUID?
    public var itemID: UUID?
    public var createdAt: Date
    public var deviceID: String
    public var deviceName: String

    public init(id: UUID = UUID(),
                action: Action,
                url: String? = nil,
                title: String? = nil,
                spaceID: UUID? = nil,
                folderID: UUID? = nil,
                itemID: UUID? = nil,
                createdAt: Date,
                deviceID: String,
                deviceName: String) {
        self.id = id
        self.action = action
        self.url = url
        self.title = title
        self.spaceID = spaceID
        self.folderID = folderID
        self.itemID = itemID
        self.createdAt = createdAt
        self.deviceID = deviceID
        self.deviceName = deviceName
    }
}

/// Companion outbox file written by iOS alongside Mac-authored iCloud bundles so mobile changes
/// apply cleanly on Mac without clobbering Mac-only SyncBundle state.
public struct PhonePinOutbox: Codable, Equatable, Sendable {
    public static let fileName = "phone-pins.json"
    public static let maxAge: TimeInterval = 30 * 86400

    public var version: Int
    public var mutations: [PhonePinMutation]

    public init(version: Int = 1, mutations: [PhonePinMutation] = []) {
        self.version = version
        self.mutations = mutations
    }

    public func pruning(olderThan age: TimeInterval = PhonePinOutbox.maxAge, now: Date) -> PhonePinOutbox {
        var copy = self
        copy.mutations = mutations.filter { now.timeIntervalSince($0.createdAt) <= age }
        return copy
    }
}

// MARK: - Live LAN / Tailscale Sync Wire Models

public struct ArcSyncRoute: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var pattern: String
    public var spaceID: UUID
    public var matchStyle: String
    public var littleWindow: Bool
    public var updatedAt: Date

    public init(id: UUID = UUID(),
                pattern: String,
                spaceID: UUID,
                matchStyle: String = "contains",
                littleWindow: Bool = false,
                updatedAt: Date) {
        self.id = id
        self.pattern = pattern
        self.spaceID = spaceID
        self.matchStyle = matchStyle
        self.littleWindow = littleWindow
        self.updatedAt = updatedAt
    }

    public init(from route: LinkRoute, updatedAt: Date) {
        self.id = route.id
        self.pattern = route.text
        switch route.destination {
        case .space(let id):
            self.spaceID = id
            self.littleWindow = false
        case .littleWindow(let id):
            self.spaceID = id ?? UUID(uuidString: "00000000-0000-0000-0000-000000000000")!
            self.littleWindow = true
        case .mostRecentSpace:
            self.spaceID = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!
            self.littleWindow = false
        }
        self.matchStyle = route.match.rawValue
        self.updatedAt = updatedAt
    }

    public func toLinkRoute(validSpaceIDs: Set<UUID>) -> LinkRoute? {
        let style = LinkMatchStyle(rawValue: matchStyle) ?? .contains
        let dest: LinkDestination
        if littleWindow {
            dest = .littleWindow(space: validSpaceIDs.contains(spaceID) ? spaceID : nil)
        } else if validSpaceIDs.contains(spaceID) {
            dest = .space(spaceID)
        } else {
            return nil
        }
        return LinkRoute(id: id, match: style, text: pattern, destination: dest)
    }
}

public struct ArcSyncSiteSearch: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var shortcut: String
    public var label: String
    public var urlTemplate: String

    public init(id: String, shortcut: String, label: String, urlTemplate: String) {
        self.id = id
        self.shortcut = shortcut
        self.label = label
        self.urlTemplate = urlTemplate
    }
}

public struct ArcSyncBoost: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var host: String
    public var name: String
    public var enabled: Bool
    public var hue: Double
    public var strength: Double
    public var invert: Bool
    public var contrast: Double
    public var brightness: Double
    public var saturation: Double
    public var font: Int?
    public var textScale: Double
    public var textCase: String
    public var zapped: [String]
    public var css: String
    public var js: String

    public init(id: UUID = UUID(),
                host: String,
                name: String,
                enabled: Bool = true,
                hue: Double = 0,
                strength: Double = 0,
                invert: Bool = false,
                contrast: Double = 50,
                brightness: Double = 50,
                saturation: Double = 50,
                font: Int? = nil,
                textScale: Double = 100,
                textCase: String = "none",
                zapped: [String] = [],
                css: String = "",
                js: String = "") {
        self.id = id
        self.host = host
        self.name = name
        self.enabled = enabled
        self.hue = hue
        self.strength = strength
        self.invert = invert
        self.contrast = contrast
        self.brightness = brightness
        self.saturation = saturation
        self.font = font
        self.textScale = textScale
        self.textCase = textCase
        self.zapped = zapped
        self.css = css
        self.js = js
    }

    public init(from boost: Boost) {
        self.id = boost.id
        self.host = boost.host
        self.name = boost.name
        self.enabled = boost.enabled
        self.hue = boost.hue
        self.strength = boost.strength
        self.invert = boost.invert
        self.contrast = boost.contrast
        self.brightness = boost.brightness
        self.saturation = boost.saturation
        self.font = boost.font
        self.textScale = boost.textScale
        self.textCase = boost.textCase.rawValue
        self.zapped = boost.zapped
        self.css = boost.css
        self.js = boost.js
    }

    public func toBoost() -> Boost {
        var b = Boost(id: id, host: host, name: name)
        b.enabled = enabled
        b.hue = hue
        b.strength = strength
        b.invert = invert
        b.contrast = contrast
        b.brightness = brightness
        b.saturation = saturation
        b.font = font
        b.textScale = textScale
        b.textCase = Boost.TextCase(rawValue: textCase) ?? .none
        b.zapped = zapped
        b.css = css
        b.js = js
        return b
    }
}

public struct ArcHandoffTab: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var url: String
    public var title: String
    public var spaceID: UUID?
    public var fromDeviceID: String
    public var fromDeviceName: String
    public var targetDeviceID: String?
    public var createdAt: Date

    public init(id: UUID = UUID(),
                url: String,
                title: String = "",
                spaceID: UUID? = nil,
                fromDeviceID: String,
                fromDeviceName: String,
                targetDeviceID: String? = nil,
                createdAt: Date) {
        self.id = id
        self.url = url
        self.title = title
        self.spaceID = spaceID
        self.fromDeviceID = fromDeviceID
        self.fromDeviceName = fromDeviceName
        self.targetDeviceID = targetDeviceID
        self.createdAt = createdAt
    }
}

public struct ArcSyncDeviceInfo: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var platform: String
    public var lastSeenAt: Date
    public var activeSpaceID: UUID?
    public var activeTabs: [ArcHandoffTab]

    public init(id: String,
                name: String,
                platform: String,
                lastSeenAt: Date,
                activeSpaceID: UUID? = nil,
                activeTabs: [ArcHandoffTab] = []) {
        self.id = id
        self.name = name
        self.platform = platform
        self.lastSeenAt = lastSeenAt
        self.activeSpaceID = activeSpaceID
        self.activeTabs = activeTabs
    }
}

public struct ArcSyncSnapshot: Codable, Equatable {
    public var version: Int
    public var revision: Int
    public var updatedAt: Date
    public var serverDeviceID: String
    public var serverDeviceName: String
    public var document: SidebarDocument
    public var routes: [ArcSyncRoute]
    public var siteSearches: [ArcSyncSiteSearch]
    public var boosts: [ArcSyncBoost]
    public var devices: [ArcSyncDeviceInfo]
    public var pendingHandoffs: [ArcHandoffTab]

    public init(version: Int = 1,
                revision: Int,
                updatedAt: Date,
                serverDeviceID: String,
                serverDeviceName: String,
                document: SidebarDocument,
                routes: [ArcSyncRoute] = [],
                siteSearches: [ArcSyncSiteSearch] = [],
                boosts: [ArcSyncBoost] = [],
                devices: [ArcSyncDeviceInfo] = [],
                pendingHandoffs: [ArcHandoffTab] = []) {
        self.version = version
        self.revision = revision
        self.updatedAt = updatedAt
        self.serverDeviceID = serverDeviceID
        self.serverDeviceName = serverDeviceName
        self.document = document
        self.routes = routes
        self.siteSearches = siteSearches
        self.boosts = boosts
        self.devices = devices
        self.pendingHandoffs = pendingHandoffs
    }
}

public struct ArcSyncMutation: Codable, Equatable, Identifiable, Sendable {
    public enum Action: String, Codable, Equatable, Sendable {
        case pin
        case unpin
        case favorite
        case unfavorite
        case createFolder
        case createSpace
        case sendTab
        case rename
        case move
        case openToday
        case closeToday
        case upsertRoute
        case deleteRoute
        case upsertBoost
        case deleteBoost
    }

    public var id: UUID
    public var action: Action
    public var url: String?
    public var title: String?
    public var spaceID: UUID?
    public var folderID: UUID?
    public var itemID: UUID?
    public var index: Int?
    public var emoji: String?
    public var colors: [String]?
    public var route: ArcSyncRoute?
    public var boost: ArcSyncBoost?
    public var handoff: ArcHandoffTab?
    public var createdAt: Date
    public var deviceID: String
    public var deviceName: String

    public init(id: UUID = UUID(),
                action: Action,
                url: String? = nil,
                title: String? = nil,
                spaceID: UUID? = nil,
                folderID: UUID? = nil,
                itemID: UUID? = nil,
                index: Int? = nil,
                emoji: String? = nil,
                colors: [String]? = nil,
                route: ArcSyncRoute? = nil,
                boost: ArcSyncBoost? = nil,
                handoff: ArcHandoffTab? = nil,
                createdAt: Date,
                deviceID: String,
                deviceName: String) {
        self.id = id
        self.action = action
        self.url = url
        self.title = title
        self.spaceID = spaceID
        self.folderID = folderID
        self.itemID = itemID
        self.index = index
        self.emoji = emoji
        self.colors = colors
        self.route = route
        self.boost = boost
        self.handoff = handoff
        self.createdAt = createdAt
        self.deviceID = deviceID
        self.deviceName = deviceName
    }

    public init(from phonePin: PhonePinMutation) {
        let mappedAction: Action
        switch phonePin.action {
        case .pin: mappedAction = .pin
        case .unpin: mappedAction = .unpin
        case .favorite: mappedAction = .favorite
        case .unfavorite: mappedAction = .unfavorite
        case .createFolder: mappedAction = .createFolder
        case .createSpace: mappedAction = .createSpace
        case .sendTab: mappedAction = .sendTab
        }
        self.init(
            id: phonePin.id,
            action: mappedAction,
            url: phonePin.url,
            title: phonePin.title,
            spaceID: phonePin.spaceID,
            folderID: phonePin.folderID,
            itemID: phonePin.itemID,
            createdAt: phonePin.createdAt,
            deviceID: phonePin.deviceID,
            deviceName: phonePin.deviceName
        )
    }
}

public struct ArcSyncMutationRequest: Codable, Equatable, Sendable {
    public var device: ArcSyncDeviceInfo?
    public var mutations: [ArcSyncMutation]

    public init(device: ArcSyncDeviceInfo? = nil, mutations: [ArcSyncMutation]) {
        self.device = device
        self.mutations = mutations
    }
}

public struct ArcSyncMergeRequest: Codable, Equatable {
    public var device: ArcSyncDeviceInfo
    public var baseRevision: Int?
    public var baseDocument: SidebarDocument?
    public var document: SidebarDocument
    public var routes: [ArcSyncRoute]?
    public var siteSearches: [ArcSyncSiteSearch]?
    public var boosts: [ArcSyncBoost]?

    public init(device: ArcSyncDeviceInfo,
                baseRevision: Int? = nil,
                baseDocument: SidebarDocument? = nil,
                document: SidebarDocument,
                routes: [ArcSyncRoute]? = nil,
                siteSearches: [ArcSyncSiteSearch]? = nil,
                boosts: [ArcSyncBoost]? = nil) {
        self.device = device
        self.baseRevision = baseRevision
        self.baseDocument = baseDocument
        self.document = document
        self.routes = routes
        self.siteSearches = siteSearches
        self.boosts = boosts
    }
}

public struct ArcSyncMergeResponse: Codable, Equatable {
    public var snapshot: ArcSyncSnapshot
    public var merged: Bool

    public init(snapshot: ArcSyncSnapshot, merged: Bool) {
        self.snapshot = snapshot
        self.merged = merged
    }
}

// MARK: - Convergence & Tree Operations

public enum ArcSyncMerger {
    /// Applies additive/structural sync mutations to a `SidebarDocument` while maintaining parent/child invariants.
    public static func apply(_ mutations: [ArcSyncMutation],
                             to document: SidebarDocument,
                             now: Date) -> (document: SidebarDocument, changed: Bool) {
        guard !mutations.isEmpty else { return (document, false) }
        var doc = document
        var byID: [UUID: SidebarItem] = Dictionary(uniqueKeysWithValues: doc.items.map { ($0.id, $0) })
        var order: [UUID] = doc.items.map(\.id)
        var changed = false

        func targetSpace(id preferred: UUID?) -> Space? {
            if let preferred, let s = doc.spaces.first(where: { $0.id == preferred }) { return s }
            if let firstOrder = doc.spaceOrder.first, let s = doc.spaces.first(where: { $0.id == firstOrder }) { return s }
            return doc.spaces.first
        }

        func belongsToSpace(_ itemID: UUID, space: Space) -> Bool {
            let roots: Set<UUID> = [space.favoritesContainerID, space.pinnedContainerID, space.todayContainerID]
            var seen: Set<UUID> = []
            var cursor: UUID? = itemID
            while let id = cursor, seen.insert(id).inserted {
                if roots.contains(id) { return true }
                cursor = byID[id]?.parentID
            }
            return false
        }

        func wouldCreateCycle(moving id: UUID, under candidateParent: UUID) -> Bool {
            var seen: Set<UUID> = []
            var cursor: UUID? = candidateParent
            while let current = cursor, seen.insert(current).inserted {
                if current == id { return true }
                cursor = byID[current]?.parentID
            }
            return false
        }

        func insertChild(_ childID: UUID, into parentID: UUID, at index: Int?) {
            guard var parent = byID[parentID] else { return }
            parent.children.removeAll { $0 == childID }
            if let index {
                parent.children.insert(childID, at: max(0, min(index, parent.children.count)))
            } else {
                parent.children.append(childID)
            }
            byID[parentID] = parent
        }

        func removeSubtree(_ rootID: UUID) {
            guard let item = byID[rootID], item.container == nil else { return }
            if let parentID = item.parentID, var parent = byID[parentID] {
                parent.children.removeAll { $0 == rootID }
                byID[parentID] = parent
            }
            var stack = [rootID]
            var removed: Set<UUID> = []
            while let id = stack.popLast() {
                guard removed.insert(id).inserted else { continue }
                if let node = byID[id] { stack.append(contentsOf: node.children) }
                byID.removeValue(forKey: id)
            }
            order.removeAll { removed.contains($0) }
            changed = true
        }

        func upsertTab(url: String, title: String?, parentID: UUID, preferredID: UUID?, index: Int?) {
            let cleanURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleanURL.isEmpty, var parent = byID[parentID] else { return }
            if let existingID = parent.children.first(where: { byID[$0]?.tab?.url == cleanURL || byID[$0]?.tab?.savedURL == cleanURL }),
               var existing = byID[existingID], case .tab(var td) = existing.data {
                if let title, !title.isEmpty, existing.title != title {
                    existing.title = title
                    td.savedTitle = title
                    existing.data = .tab(td)
                    byID[existingID] = existing
                    changed = true
                }
                return
            }
            let tabID = preferredID ?? UUID()
            if byID[tabID] != nil {
                // Move/update existing ID if caller referenced a known item.
                guard !wouldCreateCycle(moving: tabID, under: parentID),
                      var existing = byID[tabID], existing.container == nil else { return }
                if let oldParentID = existing.parentID, oldParentID != parentID, var oldParent = byID[oldParentID] {
                    oldParent.children.removeAll { $0 == tabID }
                    byID[oldParentID] = oldParent
                }
                existing.parentID = parentID
                if let title, !title.isEmpty { existing.title = title }
                if case .tab(var td) = existing.data {
                    td.url = cleanURL
                    td.savedURL = cleanURL
                    if let title, !title.isEmpty { td.savedTitle = title }
                    existing.data = .tab(td)
                }
                byID[tabID] = existing
                insertChild(tabID, into: parentID, at: index)
                changed = true
                return
            }
            let effectiveTitle = title?.isEmpty == false ? title : nil
            let td = TabData(url: cleanURL, title: effectiveTitle ?? "")
            let newItem = SidebarItem(
                id: tabID,
                parentID: parentID,
                title: effectiveTitle,
                children: [],
                isUnread: false,
                createdAt: now,
                data: .tab(td)
            )
            byID[tabID] = newItem
            order.append(tabID)
            parent.children.removeAll { $0 == tabID }
            if let index {
                parent.children.insert(tabID, at: max(0, min(index, parent.children.count)))
            } else {
                parent.children.append(tabID)
            }
            byID[parentID] = parent
            changed = true
        }

        for m in mutations {
            switch m.action {
            case .pin:
                guard let url = m.url, let space = targetSpace(id: m.spaceID) else { continue }
                let parentID: UUID
                if let folderID = m.folderID, byID[folderID] != nil, belongsToSpace(folderID, space: space) {
                    parentID = folderID
                } else {
                    parentID = space.pinnedContainerID
                }
                upsertTab(url: url, title: m.title, parentID: parentID, preferredID: m.itemID, index: m.index)

            case .unpin:
                if let itemID = m.itemID, byID[itemID] != nil {
                    removeSubtree(itemID)
                } else if let url = m.url, let space = targetSpace(id: m.spaceID) {
                    let parentID = m.folderID.flatMap { byID[$0] != nil ? $0 : nil } ?? space.pinnedContainerID
                    if let matchID = byID[parentID]?.children.first(where: { byID[$0]?.tab?.url == url || byID[$0]?.tab?.savedURL == url }) {
                        removeSubtree(matchID)
                    }
                }

            case .favorite:
                guard let url = m.url, let space = targetSpace(id: m.spaceID) else { continue }
                upsertTab(url: url, title: m.title, parentID: space.favoritesContainerID, preferredID: m.itemID, index: m.index)

            case .unfavorite:
                if let itemID = m.itemID, byID[itemID] != nil {
                    removeSubtree(itemID)
                } else if let url = m.url, let space = targetSpace(id: m.spaceID),
                          let matchID = byID[space.favoritesContainerID]?.children.first(where: { byID[$0]?.tab?.url == url || byID[$0]?.tab?.savedURL == url }) {
                    removeSubtree(matchID)
                }

            case .openToday:
                guard let url = m.url, let space = targetSpace(id: m.spaceID) else { continue }
                upsertTab(url: url, title: m.title, parentID: space.todayContainerID, preferredID: m.itemID, index: m.index)

            case .closeToday:
                if let itemID = m.itemID, byID[itemID] != nil {
                    removeSubtree(itemID)
                } else if let url = m.url, let space = targetSpace(id: m.spaceID),
                          let matchID = byID[space.todayContainerID]?.children.first(where: { byID[$0]?.tab?.url == url || byID[$0]?.tab?.savedURL == url }) {
                    removeSubtree(matchID)
                }

            case .createFolder:
                guard let space = targetSpace(id: m.spaceID) else { continue }
                let parentID: UUID
                if let parentFolder = m.folderID, m.itemID != parentFolder, byID[parentFolder] != nil, belongsToSpace(parentFolder, space: space) {
                    parentID = parentFolder
                } else {
                    parentID = space.pinnedContainerID
                }
                let fid = m.itemID ?? m.folderID ?? UUID()
                let folderName = (m.title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false) ? m.title! : "New Folder"
                if let existing = byID[fid] {
                    if existing.title != folderName {
                        var copy = existing
                        copy.title = folderName
                        byID[fid] = copy
                        changed = true
                    }
                    continue
                }
                var folder = SidebarItem.folder(folderName, parent: parentID)
                folder = SidebarItem(
                    id: fid,
                    parentID: parentID,
                    title: folder.title,
                    children: [],
                    isUnread: false,
                    createdAt: now,
                    data: .folder
                )
                byID[fid] = folder
                order.append(fid)
                insertChild(fid, into: parentID, at: m.index)
                changed = true

            case .createSpace:
                let sid = m.spaceID ?? UUID()
                let title = Space.limitedTitle((m.title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false) ? m.title! : "Untitled")
                if let idx = doc.spaces.firstIndex(where: { $0.id == sid }) {
                    if doc.spaces[idx].title != title {
                        doc.spaces[idx].title = title
                        changed = true
                    }
                    continue
                }
                let favID = UUID()
                let pinID = UUID()
                let todayID = UUID()
                let favItem = SidebarItem.container(.favorites(spaceID: sid), id: favID)
                let pinItem = SidebarItem.container(.pinned(spaceID: sid), id: pinID)
                let todayItem = SidebarItem.container(.today(spaceID: sid), id: todayID)
                for c in [favItem, pinItem, todayItem] {
                    byID[c.id] = c
                    order.append(c.id)
                }
                let colors = (m.colors?.isEmpty == false) ? m.colors! : ["#5B5FC7", "#3A3660"]
                let theme = SpaceTheme(colors: colors, intensity: 0.85, noise: 0.15, appearance: "auto")
                let space = Space(
                    id: sid,
                    title: title,
                    emoji: m.emoji ?? "",
                    theme: theme,
                    favoritesContainerID: favID,
                    pinnedContainerID: pinID,
                    todayContainerID: todayID,
                    createdAt: now
                )
                doc.spaces.append(space)
                if !doc.spaceOrder.contains(sid) { doc.spaceOrder.append(sid) }
                changed = true

            case .rename:
                if let itemID = m.itemID, var item = byID[itemID] {
                    let cleanTitle = m.title?.trimmingCharacters(in: .whitespacesAndNewlines)
                    if item.title != cleanTitle {
                        item.title = cleanTitle
                        if case .tab(var td) = item.data, let cleanTitle {
                            td.savedTitle = cleanTitle
                            item.data = .tab(td)
                        }
                        byID[itemID] = item
                        changed = true
                    }
                } else if let spaceID = m.spaceID, let idx = doc.spaces.firstIndex(where: { $0.id == spaceID }),
                          let raw = m.title {
                    let cleanTitle = Space.limitedTitle(raw)
                    if doc.spaces[idx].title != cleanTitle {
                        doc.spaces[idx].title = cleanTitle
                        changed = true
                    }
                }

            case .move:
                guard let itemID = m.itemID, var item = byID[itemID], item.container == nil else { continue }
                let targetParentID: UUID?
                if let folderID = m.folderID, byID[folderID] != nil {
                    targetParentID = folderID
                } else if let space = targetSpace(id: m.spaceID) {
                    targetParentID = space.pinnedContainerID
                } else {
                    targetParentID = nil
                }
                guard let parentID = targetParentID,
                      !wouldCreateCycle(moving: itemID, under: parentID) else { continue }
                if let oldParentID = item.parentID, oldParentID != parentID, var oldParent = byID[oldParentID] {
                    oldParent.children.removeAll { $0 == itemID }
                    byID[oldParentID] = oldParent
                }
                item.parentID = parentID
                byID[itemID] = item
                insertChild(itemID, into: parentID, at: m.index)
                changed = true

            case .sendTab, .upsertRoute, .deleteRoute, .upsertBoost, .deleteBoost:
                // Handled out-of-band by LocalSyncServer / AppDelegate alongside SidebarDocument updates.
                break
            }
        }

        if changed {
            doc.items = order.compactMap { byID[$0] }
            sanitize(&doc)
        }
        return (doc, changed)
    }

    /// Applies unapplied iCloud `phone-pins.json` mutations once and prunes applied IDs older than `maxAge`.
    public static func applyPhonePins(_ outbox: PhonePinOutbox,
                                      appliedIDs: [UUID: Date],
                                      to document: SidebarDocument,
                                      now: Date) -> (document: SidebarDocument, appliedIDs: [UUID: Date], changed: Bool) {
        var nextApplied = appliedIDs.filter { now.timeIntervalSince($0.value) <= PhonePinOutbox.maxAge }
        let unapplied = outbox.mutations
            .filter { nextApplied[$0.id] == nil }
            .sorted { $0.createdAt < $1.createdAt }
        guard !unapplied.isEmpty else {
            return (document, nextApplied, false)
        }
        let wireMutations = unapplied.map(ArcSyncMutation.init(from:))
        let result = apply(wireMutations, to: document, now: now)
        for m in unapplied {
            nextApplied[m.id] = now
        }
        return (result.document, nextApplied, result.changed)
    }

    /// Three-way merge combining local document, remote document, and optional common ancestor base,
    /// then repairing structural invariants so cycles and orphan references cannot survive.
    public static func mergeDocument(base: SidebarDocument?,
                                     local: SidebarDocument,
                                     remote: SidebarDocument) -> SidebarDocument {
        let effectiveBase = base ?? SidebarDocument(spaceOrder: [], spaces: [], items: [])
        var merged = SidebarMerge.merge(base: effectiveBase, local: local, remote: remote)
        sanitize(&merged)
        return merged
    }

    private static func sanitize(_ doc: inout SidebarDocument) {
        var byID: [UUID: SidebarItem] = Dictionary(doc.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var order = Array(NSOrderedSet(array: doc.items.map(\.id))) as? [UUID] ?? doc.items.map(\.id)

        // Ensure every space owns valid container items.
        for s in doc.spaces {
            let required: [(UUID, ContainerKind)] = [
                (s.favoritesContainerID, .favorites(spaceID: s.id)),
                (s.pinnedContainerID, .pinned(spaceID: s.id)),
                (s.todayContainerID, .today(spaceID: s.id))
            ]
            for (cid, kind) in required where byID[cid] == nil {
                byID[cid] = SidebarItem.container(kind, id: cid)
                order.append(cid)
            }
        }

        // Deduplicate children lists, remove missing children, and resolve duplicate ownership.
        var ownerOf: [UUID: UUID] = [:]
        for id in order {
            guard var item = byID[id] else { continue }
            var cleanChildren: [UUID] = []
            var seenInNode: Set<UUID> = []
            for childID in item.children where seenInNode.insert(childID).inserted {
                guard let child = byID[childID], child.container == nil else { continue }
                if let existingOwner = ownerOf[childID], existingOwner != id { continue }
                ownerOf[childID] = id
                cleanChildren.append(childID)
            }
            item.children = cleanChildren
            byID[id] = item
        }

        // Ensure parentID points to actual owner and no cycles exist.
        for id in order {
            guard var item = byID[id] else { continue }
            if item.container != nil {
                item.parentID = nil
                byID[id] = item
                continue
            }
            item.parentID = ownerOf[id]
            byID[id] = item
        }

        // Break any cycles if an adversarial payload introduced one.
        for id in order {
            guard var item = byID[id], item.container == nil else { continue }
            var seen: Set<UUID> = [id]
            var cursor = item.parentID
            while let p = cursor {
                if !seen.insert(p).inserted {
                    if let pItemID = item.parentID, var parent = byID[pItemID] {
                        parent.children.removeAll { $0 == id }
                        byID[pItemID] = parent
                    }
                    item.parentID = nil
                    byID[id] = item
                    break
                }
                cursor = byID[p]?.parentID
            }
        }

        doc.items = order.compactMap { id in
            guard let item = byID[id] else { return nil }
            if item.container == nil && item.parentID == nil { return nil }
            return item
        }
    }
}

// MARK: - Network Access Policy & Pairing URI

public enum ArcSyncAccessPolicy {
    /// Allows loopback, RFC1918 LAN, link-local, Tailscale CGNAT (100.64.0.0/10), IPv6 ULA (fc00::/7),
    /// and IPv6 link-local (fe80::/10) peers. Rejects public internet IPv4/IPv6 addresses.
    public static func isAllowedPeerIP(_ rawIP: String) -> Bool {
        var ip = rawIP.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if ip.hasPrefix("[") && ip.hasSuffix("]") {
            ip = String(ip.dropFirst().dropLast())
        }
        if let pct = ip.firstIndex(of: "%") {
            ip = String(ip[..<pct])
        }
        guard !ip.isEmpty else { return false }

        if ip.hasPrefix("::ffff:") {
            let suffix = String(ip.dropFirst("::ffff:".count))
            if let v4 = parseIPv4(suffix) {
                return isAllowedIPv4(v4)
            }
            // Handle hex form like ::ffff:7f00:1
            let parts = suffix.split(separator: ":")
            if parts.count == 2,
               let hi = UInt16(parts[0], radix: 16),
               let lo = UInt16(parts[1], radix: 16) {
                let bytes = (UInt8(hi >> 8), UInt8(hi & 0xff), UInt8(lo >> 8), UInt8(lo & 0xff))
                return isAllowedIPv4(bytes)
            }
            return false
        }

        if let v4 = parseIPv4(ip) {
            return isAllowedIPv4(v4)
        }

        // IPv6 checks
        if ip == "::1" || ip == "0:0:0:0:0:0:0:1" {
            return true
        }
        guard ip.contains(":"), let firstHextet = parseFirstIPv6Hextet(ip) else {
            return false
        }
        // Unique Local Addresses fc00::/7 -> 0xFC00..0xFDFF
        if (0xFC00...0xFDFF).contains(firstHextet) { return true }
        // Link-local fe80::/10 -> 0xFE80..0xFEBF
        if (0xFE80...0xFEBF).contains(firstHextet) { return true }
        return false
    }

    public static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8)
        let b = Array(rhs.utf8)
        let maxCount = max(a.count, b.count)
        var diff: UInt8 = a.count == b.count ? 0 : 1
        for i in 0..<maxCount {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            diff |= (x ^ y)
        }
        return diff == 0
    }

    private static func parseIPv4(_ s: String) -> (UInt8, UInt8, UInt8, UInt8)? {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4,
              let a = UInt8(parts[0]),
              let b = UInt8(parts[1]),
              let c = UInt8(parts[2]),
              let d = UInt8(parts[3]) else { return nil }
        return (a, b, c, d)
    }

    private static func isAllowedIPv4(_ b: (UInt8, UInt8, UInt8, UInt8)) -> Bool {
        if b.0 == 127 { return true } // Loopback 127.0.0.0/8
        if b.0 == 10 { return true } // RFC1918 10.0.0.0/8
        if b.0 == 172 && (16...31).contains(b.1) { return true } // RFC1918 172.16.0.0/12
        if b.0 == 192 && b.1 == 168 { return true } // RFC1918 192.168.0.0/16
        if b.0 == 169 && b.1 == 254 { return true } // Link-local 169.254.0.0/16
        if b.0 == 100 && (64...127).contains(b.1) { return true } // Tailscale/CGNAT 100.64.0.0/10
        return false
    }

    private static func parseFirstIPv6Hextet(_ ip: String) -> UInt16? {
        if ip.hasPrefix("::") {
            return 0
        }
        guard let first = ip.split(separator: ":", omittingEmptySubsequences: false).first,
              !first.isEmpty,
              let value = UInt16(first, radix: 16) else { return nil }
        return value
    }
}

public enum ArcSyncPairing {
    public struct Payload: Equatable, Sendable {
        public var name: String
        public var token: String
        public var urls: [String]

        public init(name: String, token: String, urls: [String]) {
            self.name = name
            self.token = token
            self.urls = urls
        }
    }

    public static func encodeURI(name: String, token: String, urls: [String]) -> String {
        var components = URLComponents()
        components.scheme = "arcsync"
        components.host = "pair"
        components.queryItems = [
            URLQueryItem(name: "name", value: name),
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "urls", value: urls.joined(separator: ","))
        ]
        return components.string ?? ""
    }

    public static func decodeURI(_ raw: String) -> Payload? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "arcsync",
              components.host?.lowercased() == "pair",
              let items = components.queryItems else { return nil }
        let name = items.first(where: { $0.name == "name" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = items.first(where: { $0.name == "token" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        let urlsRaw = items.first(where: { $0.name == "urls" })?.value ?? ""
        guard let token, !token.isEmpty else { return nil }
        let urls = urlsRaw
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter {
                guard let u = URL(string: $0), let scheme = u.scheme?.lowercased() else { return false }
                return (scheme == "http" || scheme == "https") && u.host != nil
            }
        guard !urls.isEmpty else { return nil }
        return Payload(name: (name?.isEmpty == false) ? name! : "Mac", token: token, urls: urls)
    }
}
