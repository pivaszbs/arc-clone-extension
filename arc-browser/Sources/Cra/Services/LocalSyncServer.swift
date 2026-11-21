#if canImport(CraCore)
import CraCore
#endif
import Darwin
import Foundation
import Network
import Observation

/// Local LAN / Tailscale HTTP + SSE + Bonjour (`_arcsync._tcp`) sync server that bridges
/// Mac Cra (`SidebarStore`, `BoostStore`, `LinkRoute`) with iOS Cra and the Chrome extension.
@MainActor
@Observable
final class LocalSyncServer {
    static weak var active: LocalSyncServer?
    nonisolated static let defaultPort: UInt16 = 46280
    nonisolated private static let maxRequestBytes = 8 * 1024 * 1024

    struct PersistedConfig: Codable, Equatable {
        var enabled: Bool = true
        var port: UInt16 = LocalSyncServer.defaultPort
    }

    struct SyncedToolsState: Codable, Equatable {
        var siteSearches: [ArcSyncSiteSearch] = []
        var routeTimestamps: [UUID: Date] = [:]
    }

    struct EndpointInfo: Codable, Equatable {
        var port: UInt16
        var urls: [String]
        var token: String
        var deviceID: String
        var deviceName: String
        var pairingURI: String
    }

    private(set) var isRunning = false
    private(set) var port: UInt16 = LocalSyncServer.defaultPort
    private(set) var revision: Int = 1
    private(set) var token: String = ""
    private(set) var reachableURLs: [String] = []
    @ObservationIgnored private var magicDNSName: String?
    private(set) var peers: [String: ArcSyncDeviceInfo] = [:]
    private(set) var lastError: String?

    var enabled: Bool { config.enabled }
    var otherDevices: [ArcSyncDeviceInfo] {
        let cutoff = clock.now.addingTimeInterval(-7 * 86400)
        return peers.values
            .filter { $0.id != deviceID && $0.lastSeenAt >= cutoff }
            .sorted { $0.lastSeenAt > $1.lastSeenAt }
    }

    var pairingURI: String {
        ArcSyncPairing.encodeURI(name: deviceName, token: token, urls: reachableURLs)
    }

    var onHandoffToMac: (@MainActor (ArcHandoffTab) -> Void)?

    let deviceID: String
    let deviceName: String

    @ObservationIgnored private let store: SidebarStore
    @ObservationIgnored private let clock: Scheduler
    @ObservationIgnored private let configStore = JSONStore<PersistedConfig>("live-sync.json")
    @ObservationIgnored private let toolsStore = JSONStore<SyncedToolsState>("synced-tools.json")
    @ObservationIgnored private var config: PersistedConfig
    @ObservationIgnored private var toolsState: SyncedToolsState
    @ObservationIgnored private var listener: NWListener?
    @ObservationIgnored private var sseClients: [ObjectIdentifier: NWConnection] = [:]
    @ObservationIgnored private var keepaliveWork: ScheduledWork?
    @ObservationIgnored private var debounceWork: ScheduledWork?
    @ObservationIgnored private var pendingHandoffs: [ArcHandoffTab] = []
    @ObservationIgnored private var isApplyingRemote = false
    @ObservationIgnored private var boostToken: String = ""
    @ObservationIgnored private var startedObserving = false

    init(store: SidebarStore, clock: Scheduler, deviceID: String, deviceName: String) {
        self.store = store
        self.clock = clock
        self.deviceID = deviceID
        self.deviceName = deviceName
        self.config = configStore.load { PersistedConfig() }
        self.toolsState = toolsStore.load { SyncedToolsState() }
        self.token = Self.loadOrCreateToken()
    }

    func start(portOverride: UInt16? = nil) {
        Self.active = self
        startObserversIfNeeded()
        guard config.enabled else {
            stopListenerOnly()
            return
        }
        guard listener == nil else { return }

        let envPort = ProcessInfo.processInfo.environment["ARC_SYNC_PORT"].flatMap(UInt16.init)
        let preferredPort = portOverride ?? envPort ?? config.port
        startListener(on: preferredPort, allowEphemeralFallback: portOverride == nil)
    }

    func stop() {
        debounceWork?.cancel()
        debounceWork = nil
        keepaliveWork?.cancel()
        keepaliveWork = nil
        stopListenerOnly()
        if Self.active === self { Self.active = nil }
    }

    func setEnabled(_ enabled: Bool) {
        guard config.enabled != enabled else { return }
        config.enabled = enabled
        configStore.saveNow(config)
        if enabled {
            start()
        } else {
            stopListenerOnly()
            try? FileManager.default.removeItem(at: AppPaths.file("sync-endpoint.json"))
        }
    }

    func regenerateToken() {
        let fresh = Self.generateTokenHex()
        Self.writeSecretToken(fresh)
        token = fresh
        persistEndpointFile()
        for (_, conn) in sseClients { conn.cancel() }
        sseClients.removeAll()
    }

    func queueHandoff(url: String, title: String, spaceID: UUID?, targetDeviceID: String?) {
        let tab = ArcHandoffTab(
            url: CleanURL.withoutTrackers(url),
            title: title,
            spaceID: spaceID,
            fromDeviceID: deviceID,
            fromDeviceName: deviceName,
            targetDeviceID: targetDeviceID,
            createdAt: clock.now
        )
        pendingHandoffs.append(tab)
        pruneHandoffs()
        broadcastSSE(event: "handoff", payload: tab)
    }

    // MARK: - Observation & Change Debounce

    private func startObserversIfNeeded() {
        guard !startedObserving else { return }
        startedObserving = true

        observeChanges(of: { [store] in store.revision }) { [weak self] _ in
            self?.scheduleLocalChangeBroadcast()
        }
        observeChanges(of: { BoostStore.shared.boosts.count }) { [weak self] _ in
            self?.scheduleLocalChangeBroadcast()
        }
        BoostStore.changed = { [weak self] _ in
            Task { @MainActor in
                self?.boostToken = UUID().uuidString
                self?.scheduleLocalChangeBroadcast()
            }
        }
    }

    private func scheduleLocalChangeBroadcast() {
        guard !isApplyingRemote else { return }
        debounceWork?.cancel()
        debounceWork = clock.after(0.25) { [weak self] in
            guard let self else { return }
            self.revision &+= 1
            self.broadcastSyncRevision()
        }
    }

    private func broadcastSyncRevision() {
        struct EventPayload: Codable { let revision: Int }
        broadcastSSE(event: "sync", payload: EventPayload(revision: revision))
    }

    // MARK: - NWListener

    private func startListener(on desiredPort: UInt16, allowEphemeralFallback: Bool) {
        lastError = nil
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let nwPort: NWEndpoint.Port = desiredPort > 0 ? (NWEndpoint.Port(rawValue: desiredPort) ?? .any) : .any

        do {
            let l = try NWListener(using: params, on: nwPort)
            let txt = NWTXTRecord(["name": deviceName, "v": "1", "id": String(deviceID.prefix(12))])
            l.service = NWListener.Service(name: deviceName, type: "_arcsync._tcp", txtRecord: txt)
            l.stateUpdateHandler = { [weak self] state in
                Task { @MainActor [weak self] in
                    self?.handleListenerState(state, desiredPort: desiredPort, allowFallback: allowEphemeralFallback)
                }
            }
            l.newConnectionHandler = { [weak self] conn in
                Task { @MainActor [weak self] in
                    self?.acceptConnection(conn)
                }
            }
            listener = l
            l.start(queue: .global(qos: .userInitiated))
            keepaliveWork?.cancel()
            keepaliveWork = clock.every(25) { [weak self] in
                self?.sendKeepalives()
            }
        } catch {
            if allowEphemeralFallback && desiredPort != 0 {
                startListener(on: 0, allowEphemeralFallback: false)
            } else {
                lastError = error.localizedDescription
                CraLog.note("liveSync failed to start: \(error.localizedDescription)")
            }
        }
    }

    private func handleListenerState(_ state: NWListener.State, desiredPort: UInt16, allowFallback: Bool) {
        switch state {
        case .ready:
            if let actualPort = listener?.port?.rawValue, actualPort > 0 {
                port = actualPort
                isRunning = true
                reachableURLs = Self.discoverURLs(port: actualPort, magicDNS: magicDNSName)
                persistEndpointFile()
                refreshReachableURLs()
                CraLog.note("liveSync listening on port \(actualPort) (\(reachableURLs.joined(separator: ", ")))")
            }
        case .failed(let error):
            listener?.cancel()
            listener = nil
            isRunning = false
            if allowFallback && desiredPort != 0 {
                startListener(on: 0, allowEphemeralFallback: false)
            } else {
                lastError = error.localizedDescription
                CraLog.note("liveSync listener error: \(error.localizedDescription)")
            }
        case .cancelled:
            isRunning = false
        default:
            break
        }
    }

    private func stopListenerOnly() {
        keepaliveWork?.cancel()
        keepaliveWork = nil
        listener?.cancel()
        listener = nil
        for (_, conn) in sseClients { conn.cancel() }
        sseClients.removeAll()
        isRunning = false
    }

    // MARK: - HTTP Connection Handling

    private func acceptConnection(_ conn: NWConnection) {
        let peer = Self.peerIP(from: conn.endpoint)
        guard ArcSyncAccessPolicy.isAllowedPeerIP(peer) else {
            conn.cancel()
            return
        }
        conn.stateUpdateHandler = { [weak self, weak conn] state in
            if case .failed = state, let conn {
                Task { @MainActor [weak self] in self?.sseClients.removeValue(forKey: ObjectIdentifier(conn)) }
            } else if case .cancelled = state, let conn {
                Task { @MainActor [weak self] in self?.sseClients.removeValue(forKey: ObjectIdentifier(conn)) }
            }
        }
        conn.start(queue: .global(qos: .userInitiated))
        readHTTPRequest(on: conn, buffer: Data())
    }

    private nonisolated func readHTTPRequest(on conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { conn.cancel(); return }
            if error != nil { conn.cancel(); return }
            var acc = buffer
            if let data { acc.append(data) }
            if acc.count > Self.maxRequestBytes + 32768 {
                Task { @MainActor in self.sendJSON(413, body: Data("{\"error\":\"Payload too large\"}".utf8), on: conn) }
                return
            }
            guard let headerRange = acc.range(of: Data("\r\n\r\n".utf8)) else {
                if isComplete { conn.cancel(); return }
                self.readHTTPRequest(on: conn, buffer: acc)
                return
            }
            let headerData = acc[..<headerRange.lowerBound]
            guard let headerText = String(data: headerData, encoding: .utf8) else {
                conn.cancel()
                return
            }
            let lines = headerText.split(separator: "\r\n", omittingEmptySubsequences: false)
            guard let requestLine = lines.first else { conn.cancel(); return }
            let parts = requestLine.split(separator: " ")
            guard parts.count >= 2 else { conn.cancel(); return }
            let method = String(parts[0]).uppercased()
            let rawTarget = String(parts[1])

            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                if let colon = line.firstIndex(of: ":") {
                    let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces).lowercased()
                    let val = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
                    headers[key] = val
                }
            }
            let contentLength = Int(headers["content-length"] ?? "0") ?? 0
            if contentLength < 0 || contentLength > Self.maxRequestBytes {
                Task { @MainActor in self.sendJSON(413, body: Data("{\"error\":\"Payload too large\"}".utf8), on: conn) }
                return
            }
            let bodyStart = headerRange.upperBound
            let currentBodyCount = acc.count - bodyStart
            if currentBodyCount < contentLength {
                if isComplete { conn.cancel(); return }
                self.readHTTPRequest(on: conn, buffer: acc)
                return
            }
            let body = contentLength > 0 ? Data(acc[bodyStart..<(bodyStart + contentLength)]) : Data()
            Task { @MainActor in
                self.routeRequest(method: method, rawTarget: rawTarget, headers: headers, body: body, conn: conn)
            }
        }
    }

    private func routeRequest(method: String, rawTarget: String, headers: [String: String], body: Data, conn: NWConnection) {
        let origin = headers["origin"]
        if method == "OPTIONS" {
            sendHTTP(status: 204, statusText: "No Content", contentType: "text/plain", origin: origin, body: Data(), on: conn)
            return
        }

        let comps = URLComponents(string: "http://localhost" + rawTarget)
        let path = comps?.path ?? rawTarget
        let query = Dictionary(uniqueKeysWithValues: (comps?.queryItems ?? []).compactMap { item in
            item.value.map { (item.name, $0) }
        })

        if method == "GET" && path == "/v1/health" {
            struct Health: Codable { let ok: Bool; let name: String; let version: Int; let revision: Int }
            let payload = (try? Self.encoder.encode(Health(ok: true, name: deviceName, version: 1, revision: revision))) ?? Data()
            sendJSON(200, origin: origin, body: payload, on: conn)
            return
        }

        let suppliedToken: String = {
            if let auth = headers["authorization"], auth.lowercased().hasPrefix("bearer ") {
                return String(auth.dropFirst(7)).trimmingCharacters(in: .whitespaces)
            }
            if let qToken = query["token"] { return qToken }
            return ""
        }()
        guard !token.isEmpty, ArcSyncAccessPolicy.constantTimeEqual(suppliedToken, token) else {
            sendJSON(401, origin: origin, body: Data("{\"error\":\"Unauthorized\"}".utf8), on: conn)
            return
        }

        recordPeerFromQuery(query)

        switch (method, path) {
        case ("GET", "/v1/snapshot"):
            let requesterID = query["deviceId"]
            if let sinceStr = query["since"], let sinceRev = Int(sinceStr), sinceRev == revision,
               handoffs(forDevice: requesterID).isEmpty {
                sendHTTP(status: 304, statusText: "Not Modified", contentType: "application/json", origin: origin, body: Data(), on: conn)
                return
            }
            let snap = currentSnapshot(forDevice: requesterID)
            let data = (try? Self.encoder.encode(snap)) ?? Data()
            sendJSON(200, origin: origin, body: data, on: conn)

        case ("POST", "/v1/mutate"):
            guard let req = try? Self.decoder.decode(ArcSyncMutationRequest.self, from: body) else {
                sendJSON(400, origin: origin, body: Data("{\"error\":\"Invalid mutation payload\"}".utf8), on: conn)
                return
            }
            if let dev = req.device { recordPeer(dev) }
            applyMutations(req.mutations)
            let snap = currentSnapshot(forDevice: req.device?.id)
            let data = (try? Self.encoder.encode(snap)) ?? Data()
            sendJSON(200, origin: origin, body: data, on: conn)

        case ("POST", "/v1/sync"):
            guard let req = try? Self.decoder.decode(ArcSyncMergeRequest.self, from: body) else {
                sendJSON(400, origin: origin, body: Data("{\"error\":\"Invalid sync payload\"}".utf8), on: conn)
                return
            }
            recordPeer(req.device)
            let changed = applyMerge(req)
            let res = ArcSyncMergeResponse(snapshot: currentSnapshot(forDevice: req.device.id), merged: changed)
            let data = (try? Self.encoder.encode(res)) ?? Data()
            sendJSON(200, origin: origin, body: data, on: conn)

        case ("POST", "/v1/handoff"):
            guard let tab = try? Self.decoder.decode(ArcHandoffTab.self, from: body) else {
                sendJSON(400, origin: origin, body: Data("{\"error\":\"Invalid handoff payload\"}".utf8), on: conn)
                return
            }
            handleIncomingHandoff(tab)
            sendJSON(200, origin: origin, body: Data("{\"ok\":true}".utf8), on: conn)

        case ("GET", "/v1/events"):
            openSSEStream(on: conn, origin: origin)

        default:
            sendJSON(404, origin: origin, body: Data("{\"error\":\"Not found\"}".utf8), on: conn)
        }
    }

    // MARK: - Sync State Application

    private func recordPeerFromQuery(_ query: [String: String]) {
        guard let id = query["deviceId"], !id.isEmpty else { return }
        let name = query["deviceName"] ?? peers[id]?.name ?? "Device"
        let platform = query["platform"] ?? peers[id]?.platform ?? "ios"
        var info = peers[id] ?? ArcSyncDeviceInfo(id: id, name: name, platform: platform, lastSeenAt: clock.now)
        info.name = name
        info.platform = platform
        info.lastSeenAt = clock.now
        peers[id] = info
    }

    private func recordPeer(_ info: ArcSyncDeviceInfo) {
        var updated = info
        updated.lastSeenAt = clock.now
        peers[info.id] = updated
    }

    private func applyMutations(_ mutations: [ArcSyncMutation]) {
        var didMutate = false
        let docResult = ArcSyncMerger.apply(mutations, to: store.document, now: clock.now)
        if docResult.changed {
            isApplyingRemote = true
            store.replace(document: docResult.document)
            isApplyingRemote = false
            didMutate = true
        }

        let validSpaces = Set(store.document.spaces.map(\.id))
        for m in mutations {
            switch m.action {
            case .sendTab:
                if let handoff = m.handoff {
                    handleIncomingHandoff(handoff)
                } else if let url = m.url {
                    handleIncomingHandoff(ArcHandoffTab(
                        url: url,
                        title: m.title ?? url,
                        spaceID: m.spaceID,
                        fromDeviceID: m.deviceID,
                        fromDeviceName: m.deviceName,
                        createdAt: m.createdAt
                    ))
                }
            case .upsertRoute:
                if let r = m.route, let converted = r.toLinkRoute(validSpaceIDs: validSpaces) {
                    var routes = store.settings.linkRoutes
                    if let idx = routes.firstIndex(where: { $0.id == converted.id }) {
                        routes[idx] = converted
                    } else {
                        routes.append(converted)
                    }
                    store.settings.linkRoutes = routes
                    toolsState.routeTimestamps[r.id] = r.updatedAt
                    toolsStore.save(toolsState)
                    didMutate = true
                }
            case .deleteRoute:
                if let id = m.itemID {
                    store.settings.linkRoutes.removeAll { $0.id == id }
                    didMutate = true
                }
            case .upsertBoost:
                if let b = m.boost {
                    isApplyingRemote = true
                    BoostStore.shared.add(b.toBoost())
                    isApplyingRemote = false
                    didMutate = true
                }
            case .deleteBoost:
                if let id = m.itemID {
                    isApplyingRemote = true
                    BoostStore.shared.delete(id)
                    isApplyingRemote = false
                    didMutate = true
                }
            default:
                break
            }
        }

        if didMutate {
            revision &+= 1
            broadcastSyncRevision()
        }
    }

    private func applyMerge(_ req: ArcSyncMergeRequest) -> Bool {
        let localDoc = store.document.forSync()
        let merged = ArcSyncMerger.mergeDocument(base: req.baseDocument, local: localDoc, remote: req.document)
        var changed = false
        if merged != localDoc {
            isApplyingRemote = true
            store.replace(document: merged)
            isApplyingRemote = false
            changed = true
        }

        if let remoteRoutes = req.routes {
            let validSpaces = Set(merged.spaces.map(\.id))
            var routesByID = Dictionary(uniqueKeysWithValues: store.settings.linkRoutes.map { ($0.id, $0) })
            for rr in remoteRoutes {
                let localUpdated = toolsState.routeTimestamps[rr.id] ?? .distantPast
                if routesByID[rr.id] == nil || rr.updatedAt > localUpdated {
                    if let converted = rr.toLinkRoute(validSpaceIDs: validSpaces) {
                        routesByID[rr.id] = converted
                        toolsState.routeTimestamps[rr.id] = rr.updatedAt
                        changed = true
                    }
                }
            }
            store.settings.linkRoutes = Array(routesByID.values)
        }

        if let remoteBoosts = req.boosts {
            for rb in remoteBoosts {
                isApplyingRemote = true
                BoostStore.shared.add(rb.toBoost())
                isApplyingRemote = false
                changed = true
            }
        }

        if let remoteSearches = req.siteSearches, !remoteSearches.isEmpty {
            var existingByShortcut = Dictionary(uniqueKeysWithValues: toolsState.siteSearches.map { ($0.shortcut.lowercased(), $0) })
            for rs in remoteSearches {
                let key = rs.shortcut.lowercased()
                if existingByShortcut[key] != rs {
                    existingByShortcut[key] = rs
                    changed = true
                }
            }
            toolsState.siteSearches = Array(existingByShortcut.values).sorted { $0.shortcut < $1.shortcut }
        }
        toolsStore.save(toolsState)

        if changed {
            revision &+= 1
            broadcastSyncRevision()
        }
        return changed
    }

    private func handleIncomingHandoff(_ tab: ArcHandoffTab) {
        if tab.targetDeviceID == nil || tab.targetDeviceID == deviceID {
            onHandoffToMac?(tab)
            return
        }
        pendingHandoffs.append(tab)
        pruneHandoffs()
        broadcastSSE(event: "handoff", payload: tab)
    }

    private func handoffs(forDevice targetID: String?) -> [ArcHandoffTab] {
        pruneHandoffs()
        guard let targetID else { return [] }
        let matched = pendingHandoffs.filter { $0.targetDeviceID == nil || $0.targetDeviceID == targetID }
        if !matched.isEmpty {
            let deliveredIDs = Set(matched.map(\.id))
            pendingHandoffs.removeAll { deliveredIDs.contains($0.id) }
        }
        return matched
    }

    private func pruneHandoffs() {
        let cutoff = clock.now.addingTimeInterval(-24 * 3600)
        pendingHandoffs.removeAll { $0.createdAt < cutoff }
        if pendingHandoffs.count > 50 {
            pendingHandoffs.removeFirst(pendingHandoffs.count - 50)
        }
    }

    private func currentSnapshot(forDevice requesterID: String?) -> ArcSyncSnapshot {
        let routes = store.settings.linkRoutes.map {
            ArcSyncRoute(from: $0, updatedAt: toolsState.routeTimestamps[$0.id] ?? clock.now)
        }
        let boosts = BoostStore.shared.boosts.map(ArcSyncBoost.init(from:))
        var activePeers = otherDevices
        let macTabs = store.orderedSpaces.flatMap { space in
            store.tabs(under: space.todayContainerID).compactMap { item -> ArcHandoffTab? in
                guard let tab = item.tab, tab.url.hasPrefix("http") else { return nil }
                return ArcHandoffTab(
                    id: item.id,
                    url: tab.url,
                    title: item.displayTitle,
                    spaceID: space.id,
                    fromDeviceID: deviceID,
                    fromDeviceName: deviceName,
                    createdAt: clock.now
                )
            }
        }
        let selfInfo = ArcSyncDeviceInfo(
            id: deviceID,
            name: deviceName,
            platform: "mac",
            lastSeenAt: clock.now,
            activeSpaceID: store.focusedSpaceID,
            activeTabs: Array(macTabs.prefix(40))
        )
        activePeers.insert(selfInfo, at: 0)

        return ArcSyncSnapshot(
            revision: revision,
            updatedAt: clock.now,
            serverDeviceID: deviceID,
            serverDeviceName: deviceName,
            document: store.document.forSync(),
            routes: routes,
            siteSearches: toolsState.siteSearches,
            boosts: boosts,
            devices: activePeers,
            pendingHandoffs: handoffs(forDevice: requesterID)
        )
    }

    // MARK: - SSE

    private func openSSEStream(on conn: NWConnection, origin: String?) {
        let cors = corsHeaders(origin: origin)
        let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\(cors)\r\nretry: 3000\n\nevent: sync\ndata: {\"revision\":\(revision)}\n\n"
        sseClients[ObjectIdentifier(conn)] = conn
        conn.send(content: Data(header.utf8), completion: .contentProcessed { _ in })
    }

    private func sendKeepalives() {
        let ping = Data(": ping\n\n".utf8)
        for (_, conn) in sseClients {
            conn.send(content: ping, completion: .contentProcessed { _ in })
        }
    }

    private func broadcastSSE<T: Encodable>(event: String, payload: T) {
        guard !sseClients.isEmpty,
              let json = try? Self.encoder.encode(payload),
              let text = String(data: json, encoding: .utf8) else { return }
        let msg = Data("event: \(event)\ndata: \(text)\n\n".utf8)
        for (_, conn) in sseClients {
            conn.send(content: msg, completion: .contentProcessed { _ in })
        }
    }

    // MARK: - HTTP Serialization

    private func corsHeaders(origin: String?) -> String {
        let allowedOrigin: String
        if let origin, origin.hasPrefix("chrome-extension://") || origin.hasPrefix("http://localhost") || origin.hasPrefix("http://127.0.0.1") {
            allowedOrigin = origin
        } else {
            allowedOrigin = "*"
        }
        return "Access-Control-Allow-Origin: \(allowedOrigin)\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Max-Age: 600\r\n"
    }

    private func sendJSON(_ status: Int, origin: String? = nil, body: Data, on conn: NWConnection) {
        let text: String
        switch status {
        case 200: text = "OK"
        case 204: text = "No Content"
        case 304: text = "Not Modified"
        case 400: text = "Bad Request"
        case 401: text = "Unauthorized"
        case 403: text = "Forbidden"
        case 404: text = "Not Found"
        case 413: text = "Payload Too Large"
        default: text = "Error"
        }
        sendHTTP(status: status, statusText: text, contentType: "application/json; charset=utf-8", origin: origin, body: body, on: conn)
    }

    private func sendHTTP(status: Int, statusText: String, contentType: String, origin: String?, body: Data, on conn: NWConnection) {
        var header = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n"
        header += corsHeaders(origin: origin)
        header += "\r\n"
        var packet = Data(header.utf8)
        packet.append(body)
        conn.send(content: packet, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    // MARK: - Token & Network Interface Discovery

    private static func loadOrCreateToken() -> String {
        let url = AppPaths.file("sync-token")
        if let existing = try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           existing.count >= 16 {
            return existing
        }
        let fresh = generateTokenHex()
        writeSecretToken(fresh)
        return fresh
    }

    private static func writeSecretToken(_ value: String) {
        let url = AppPaths.file("sync-token")
        try? FileManager.default.createDirectory(at: AppPaths.supportDir, withIntermediateDirectories: true)
        try? Data((value + "\n").utf8).write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func generateTokenHex() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func persistEndpointFile() {
        let info = EndpointInfo(
            port: port,
            urls: reachableURLs,
            token: token,
            deviceID: deviceID,
            deviceName: deviceName,
            pairingURI: pairingURI
        )
        let url = AppPaths.file("sync-endpoint.json")
        if let data = try? Self.encoder.encode(info) {
            try? data.write(to: url, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }

    private static func discoverURLs(port: UInt16, magicDNS: String? = nil) -> [String] {
        var ips: [String] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifaddr) == 0, let first = ifaddr {
            defer { freeifaddrs(ifaddr) }
            var ptr: UnsafeMutablePointer<ifaddrs>? = first
            while let cur = ptr {
                let flags = Int32(cur.pointee.ifa_flags)
                if (flags & IFF_UP) != 0,
                   (flags & IFF_LOOPBACK) == 0,
                   let addr = cur.pointee.ifa_addr,
                   addr.pointee.sa_family == UInt8(AF_INET) {
                    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                        let ip = String(cString: host)
                        if ArcSyncAccessPolicy.isAllowedPeerIP(ip) { ips.append(ip) }
                    }
                }
                ptr = cur.pointee.ifa_next
            }
        }
        return ArcSyncEndpoints.pairingURLs(ips: ips, magicDNS: magicDNS, port: port)
    }

    /// Re-reads the Mac's addresses: Tailscale may have come up (or the Wi-Fi changed) since the
    /// listener started. The pairing screen calls it when it shows.
    func refreshReachableURLs() {
        guard isRunning else { return }
        let port = self.port
        reachableURLs = Self.discoverURLs(port: port, magicDNS: magicDNSName)
        persistEndpointFile()
        Task.detached(priority: .utility) {
            let name = Self.lookUpMagicDNSName()
            await MainActor.run {
                guard name != self.magicDNSName, self.port == port else { return }
                self.magicDNSName = name
                self.reachableURLs = Self.discoverURLs(port: port, magicDNS: name)
                self.persistEndpointFile()
            }
        }
    }

    /// This Mac's Tailscale MagicDNS name, from the Tailscale CLI; nil without Tailscale.
    private nonisolated static func lookUpMagicDNSName() -> String? {
        let candidates = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
        guard let cli = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli)
        process.arguments = ["status", "--json", "--peers=false"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return ArcSyncEndpoints.magicDNSName(fromStatusJSON: data)
    }

    private nonisolated static func peerIP(from endpoint: NWEndpoint) -> String {
        switch endpoint {
        case .hostPort(let host, _):
            switch host {
            case .ipv4(let addr):
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                return addr.rawValue.withUnsafeBytes { raw in
                    inet_ntop(AF_INET, raw.baseAddress, &buf, socklen_t(INET_ADDRSTRLEN))
                }.map { String(cString: $0) } ?? ""
            case .ipv6(let addr):
                var buf = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
                return addr.rawValue.withUnsafeBytes { raw in
                    inet_ntop(AF_INET6, raw.baseAddress, &buf, socklen_t(INET6_ADDRSTRLEN))
                }.map { String(cString: $0) } ?? ""
            case .name(let name, _):
                return name
            @unknown default:
                return ""
            }
        default:
            return ""
        }
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
            if let date = isoWithFraction.date(from: str) ?? isoPlain.date(from: str) {
                return date
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO8601 date: \(str)")
        }
        return d
    }()

    nonisolated private static let isoWithFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
