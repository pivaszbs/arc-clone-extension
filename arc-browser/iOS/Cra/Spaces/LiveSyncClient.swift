import CraCore
import Foundation
import Network
import UIKit

/// Real-time LAN / Tailscale / Bonjour (`_arcsync._tcp`) sync client for iOS Cra.
/// Maintains a local cached `SidebarDocument`, App Group `synced-spaces.json` for `CraShare`,
/// an offline mutation queue (`pending-sync-ops.json`), and optional iCloud `phone-pins.json` write-back.
@MainActor
final class LiveSyncClient: ObservableObject {
    struct DiscoveredPeer: Identifiable, Equatable {
        let id: String
        let name: String
        let endpoint: NWEndpoint
        var resolvedHost: String?
    }

    static let shared = LiveSyncClient()
    static let didUpdateNotification = Notification.Name("CraLiveSyncDidUpdate")

    @Published private(set) var cachedDocument: SidebarDocument?
    @Published private(set) var devices: [ArcSyncDeviceInfo] = []
    @Published private(set) var discoveredPeers: [DiscoveredPeer] = []
    @Published private(set) var isConnected = false
    @Published private(set) var isSyncing = false
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var pendingOpsCount = 0
    @Published private(set) var serverName: String?

    var onIncomingHandoff: ((ArcHandoffTab) -> Void)?

    private weak var settingsStore: MobileSettingsStore?
    private var lastRevision: Int?
    private var deliveredHandoffs = Set<UUID>()
    private var browser: NWBrowser?
    private var pollTask: Task<Void, Never>?

    let deviceID: String = {
        let key = "cra_ios_sync_device_id"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let created = "ios-" + UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: key)
        return created
    }()

    var deviceName: String { UIDevice.current.name }

    private var dataDir: URL { LaunchOptions.dataDirectory }
    private var sidebarCacheURL: URL { dataDir.appendingPathComponent("synced-sidebar.json") }
    private var outboxURL: URL { dataDir.appendingPathComponent("pending-sync-ops.json") }

    private var activeURLs: [String] {
        if let arg = LaunchOptions.value("CraSyncURL")?.trimmingCharacters(in: .whitespacesAndNewlines), !arg.isEmpty {
            return [arg]
        }
        return settingsStore?.value.liveSyncURLs ?? []
    }

    private var activeToken: String? {
        if let arg = LaunchOptions.value("CraSyncToken")?.trimmingCharacters(in: .whitespacesAndNewlines), !arg.isEmpty {
            return arg
        }
        return settingsStore?.value.liveSyncToken
    }

    private var isEnabled: Bool {
        if LaunchOptions.value("CraSyncURL") != nil && LaunchOptions.value("CraSyncToken") != nil {
            return true
        }
        return settingsStore?.value.hasLiveSync == true
    }

    func configure(settings: MobileSettingsStore) {
        settingsStore = settings
        serverName = settings.value.liveSyncPeerName
        loadLocalCaches()
        if isEnabled {
            startPolling()
            Task { await refreshNow() }
        }
    }

    func startDiscovery() {
        guard browser == nil else { return }
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_arcsync._tcp", domain: nil), using: params)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.discoveredPeers = results.compactMap { res in
                    if case .service(let name, _, _, _) = res.endpoint {
                        return DiscoveredPeer(id: name, name: name, endpoint: res.endpoint)
                    }
                    return nil
                }
            }
        }
        browser = b
        b.start(queue: .main)
    }

    func stopDiscovery() {
        browser?.cancel()
        browser = nil
    }

    @discardableResult
    func pair(withURI rawURI: String) async -> Bool {
        guard let parsed = ArcSyncPairing.decodeURI(rawURI) else {
            lastError = "Invalid pairing link (expected arcsync://pair?...)"
            return false
        }
        return await pair(urls: parsed.urls, token: parsed.token, name: parsed.name)
    }

    @discardableResult
    func pair(urls: [String], token: String, name: String = "Mac") async -> Bool {
        let cleanedURLs = urls.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
            .filter { !$0.isEmpty }
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedURLs.isEmpty, !cleanToken.isEmpty else {
            lastError = "Enter both a server URL and pairing token."
            return false
        }
        settingsStore?.update {
            $0.liveSyncURLs = cleanedURLs
            $0.liveSyncToken = cleanToken
            $0.liveSyncPeerName = name
            $0.liveSyncEnabled = true
        }
        serverName = name
        lastError = nil
        startPolling()
        await refreshNow()
        return isConnected
    }

    func disconnect() {
        pollTask?.cancel()
        pollTask = nil
        settingsStore?.update {
            $0.liveSyncEnabled = false
        }
        isConnected = false
        devices = []
        lastError = nil
    }

    func refreshNow() async {
        guard isEnabled, let token = activeToken, !activeURLs.isEmpty else { return }
        if isSyncing { return }
        isSyncing = true
        defer { isSyncing = false }

        await flushOutbox(urls: activeURLs, token: token)

        let encodedID = deviceID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? deviceID
        let encodedName = deviceName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "iPhone"
        let path = "/v1/snapshot?deviceId=\(encodedID)&deviceName=\(encodedName)&platform=ios"
        do {
            let (data, _) = try await request(path: path, method: "GET", body: nil, urls: activeURLs, token: token)
            let snap = try Self.decoder.decode(ArcSyncSnapshot.self, from: data)
            applySnapshot(snap)
            isConnected = true
            lastSyncedAt = Date()
            lastError = nil
        } catch {
            isConnected = false
            lastError = error.localizedDescription
        }
    }

    func pin(url: String, title: String, spaceID: UUID?, folderID: UUID? = nil) async {
        let mutation = ArcSyncMutation(
            action: .pin,
            url: url,
            title: title,
            spaceID: spaceID,
            folderID: folderID,
            createdAt: Date(),
            deviceID: deviceID,
            deviceName: deviceName
        )
        await submitMutation(mutation)
    }

    func unpin(itemID: UUID, spaceID: UUID) async {
        let mutation = ArcSyncMutation(
            action: .unpin,
            spaceID: spaceID,
            itemID: itemID,
            createdAt: Date(),
            deviceID: deviceID,
            deviceName: deviceName
        )
        await submitMutation(mutation)
    }

    func createFolder(name: String, spaceID: UUID) async {
        let mutation = ArcSyncMutation(
            action: .createFolder,
            title: name,
            spaceID: spaceID,
            itemID: UUID(),
            createdAt: Date(),
            deviceID: deviceID,
            deviceName: deviceName
        )
        await submitMutation(mutation)
    }

    @discardableResult
    func sendTab(url: String, title: String, spaceID: UUID? = nil, targetDeviceID: String? = nil) async -> Bool {
        let handoff = ArcHandoffTab(
            url: url,
            title: title,
            spaceID: spaceID,
            fromDeviceID: deviceID,
            fromDeviceName: deviceName,
            targetDeviceID: targetDeviceID,
            createdAt: Date()
        )
        if isEnabled, let token = activeToken, !activeURLs.isEmpty,
           let body = try? Self.encoder.encode(handoff) {
            do {
                _ = try await request(path: "/v1/handoff", method: "POST", body: body, urls: activeURLs, token: token)
                lastError = nil
                return true
            } catch {
                lastError = error.localizedDescription
            }
        }
        let mutation = ArcSyncMutation(
            action: .sendTab,
            url: url,
            title: title,
            spaceID: spaceID,
            handoff: handoff,
            createdAt: Date(),
            deviceID: deviceID,
            deviceName: deviceName
        )
        await submitMutation(mutation)
        return true
    }

    // MARK: - Private Helpers

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard let self, self.isEnabled else { return }
                await self.refreshNow()
            }
        }
    }

    private func submitMutation(_ mutation: ArcSyncMutation) async {
        if var doc = cachedDocument {
            let applied = ArcSyncMerger.apply([mutation], to: doc, now: Date())
            if applied.changed {
                doc = applied.document
                saveCachedDocument(doc)
            }
        }

        appendOutbox(mutation)
        mirrorPhonePinToICloudIfAvailable(mutation)

        if isEnabled, let token = activeToken, !activeURLs.isEmpty {
            await flushOutbox(urls: activeURLs, token: token)
        }
    }

    private func flushOutbox(urls: [String], token: String) async {
        var queue = loadOutbox()
        guard !queue.isEmpty else {
            pendingOpsCount = 0
            return
        }
        let selfInfo = ArcSyncDeviceInfo(id: deviceID, name: deviceName, platform: "ios", lastSeenAt: Date())
        let req = ArcSyncMutationRequest(device: selfInfo, mutations: queue)
        guard let body = try? Self.encoder.encode(req) else { return }
        do {
            let (data, _) = try await request(path: "/v1/mutate", method: "POST", body: body, urls: urls, token: token)
            if let snap = try? Self.decoder.decode(ArcSyncSnapshot.self, from: data) {
                applySnapshot(snap)
            }
            queue.removeAll()
            saveOutbox(queue)
            isConnected = true
            lastSyncedAt = Date()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func applySnapshot(_ snap: ArcSyncSnapshot) {
        lastRevision = snap.revision
        serverName = snap.serverDeviceName
        devices = snap.devices.filter { $0.id != deviceID }
        saveCachedDocument(snap.document)
        NotificationCenter.default.post(name: Self.didUpdateNotification, object: self)

        for handoff in snap.pendingHandoffs {
            guard !deliveredHandoffs.contains(handoff.id) else { continue }
            deliveredHandoffs.insert(handoff.id)
            onIncomingHandoff?(handoff)
        }
    }

    private func loadLocalCaches() {
        if let data = try? Data(contentsOf: sidebarCacheURL),
           let doc = try? Self.decoder.decode(SidebarDocument.self, from: data) {
            cachedDocument = doc
            writeAppGroupSpaces(doc)
        }
        pendingOpsCount = loadOutbox().count
    }

    private func saveCachedDocument(_ doc: SidebarDocument) {
        cachedDocument = doc
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        if let data = try? Self.encoder.encode(doc) {
            try? data.write(to: sidebarCacheURL, options: .atomic)
        }
        writeAppGroupSpaces(doc)
    }

    private func writeAppGroupSpaces(_ doc: SidebarDocument) {
        guard let appGroup = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: MobileShareInbox.appGroup) else { return }
        let summaries = MobileSpaces.spaceSummaries(in: doc)
        let url = appGroup.appendingPathComponent(MobileSpaces.syncedSpacesFileName)
        if let data = try? Self.encoder.encode(summaries) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func loadOutbox() -> [ArcSyncMutation] {
        guard let data = try? Data(contentsOf: outboxURL),
              let list = try? Self.decoder.decode([ArcSyncMutation].self, from: data) else {
            return []
        }
        return list
    }

    private func saveOutbox(_ list: [ArcSyncMutation]) {
        pendingOpsCount = list.count
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        if let data = try? Self.encoder.encode(list) {
            try? data.write(to: outboxURL, options: .atomic)
        }
    }

    private func appendOutbox(_ mutation: ArcSyncMutation) {
        var list = loadOutbox()
        list.append(mutation)
        saveOutbox(list)
    }

    private func mirrorPhonePinToICloudIfAvailable(_ m: ArcSyncMutation) {
        let action: PhonePinMutation.Action?
        switch m.action {
        case .pin: action = .pin
        case .unpin: action = .unpin
        case .favorite: action = .favorite
        case .unfavorite: action = .unfavorite
        case .createFolder: action = .createFolder
        case .createSpace: action = .createSpace
        case .sendTab: action = .sendTab
        default: action = nil
        }
        guard let action,
              let container = FileManager.default.url(forUbiquityContainerIdentifier: nil)?
                .appendingPathComponent("Documents", isDirectory: true)
                .appendingPathComponent(SettingsSync.folderName, isDirectory: true),
              FileManager.default.fileExists(atPath: container.path) else { return }

        let file = container.appendingPathComponent(PhonePinOutbox.fileName)
        var outbox = (try? Data(contentsOf: file)).flatMap { try? Self.decoder.decode(PhonePinOutbox.self, from: $0) } ?? PhonePinOutbox()
        outbox = outbox.pruning(now: Date())
        outbox.mutations.append(PhonePinMutation(
            id: m.id,
            action: action,
            url: m.url,
            title: m.title,
            spaceID: m.spaceID,
            folderID: m.folderID,
            itemID: m.itemID,
            createdAt: m.createdAt,
            deviceID: deviceID,
            deviceName: deviceName
        ))
        if let encoded = try? Self.encoder.encode(outbox) {
            try? encoded.write(to: file, options: .atomic)
        }
    }

    private func request(path: String, method: String, body: Data?, urls: [String], token: String) async throws -> (Data, HTTPURLResponse) {
        var lastErr: Error = URLError(.cannotConnectToHost)
        // The address that answered last goes first: away from home the LAN one only times out,
        // and Tailscale's (ArcSyncEndpoints) is the one that works.
        let lastGoodKey = "liveSyncLastGoodURL"
        // -CraSyncURL is taken as given: in the Simulator, loopback is the Mac.
        let ordered = LaunchOptions.value("CraSyncURL") != nil
            ? urls : ArcSyncEndpoints.phoneOrder(urls, lastGood: UserDefaults.standard.string(forKey: lastGoodKey))
        for base in ordered {
            let trimmed = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard let url = URL(string: trimmed + path) else { continue }
            var req = URLRequest(url: url)
            req.httpMethod = method
            req.timeoutInterval = 4
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if let body {
                req.httpBody = body
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            do {
                let (data, response) = try await URLSession.shared.data(for: req)
                guard let http = response as? HTTPURLResponse else { continue }
                if http.statusCode == 401 {
                    throw NSError(domain: "CraLiveSync", code: 401, userInfo: [NSLocalizedDescriptionKey: "Invalid pairing token."])
                }
                guard (200...299).contains(http.statusCode) else {
                    lastErr = NSError(domain: "CraLiveSync", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server error \(http.statusCode)"])
                    continue
                }
                UserDefaults.standard.set(base, forKey: lastGoodKey)
                return (data, http)
            } catch {
                lastErr = error
            }
        }
        throw lastErr
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let str = try container.decode(String.self)
            if let date = isoFraction.date(from: str) ?? isoPlain.date(from: str) {
                return date
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO date: \(str)")
        }
        return d
    }()

    private static let isoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
