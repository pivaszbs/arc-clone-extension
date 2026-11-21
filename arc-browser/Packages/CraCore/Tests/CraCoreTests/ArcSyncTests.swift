import Foundation
import Testing
@testable import CraCore

@Suite("ArcSyncProtocol")
struct ArcSyncTests {
    private let fixedNow = Date(timeIntervalSince1970: 1_750_000_000)

    private func makeDocument() -> (doc: SidebarDocument, spaceID: UUID, pinnedID: UUID, favID: UUID) {
        let sid = UUID()
        let favID = UUID()
        let pinID = UUID()
        let todayID = UUID()
        let space = Space(
            id: sid,
            title: "Work",
            emoji: "💼",
            theme: SpaceTheme(colors: ["#112233", "#445566"], intensity: 0.8, noise: 0.1, appearance: "dark"),
            favoritesContainerID: favID,
            pinnedContainerID: pinID,
            todayContainerID: todayID,
            createdAt: fixedNow
        )
        let items = [
            SidebarItem.container(.favorites(spaceID: sid), id: favID),
            SidebarItem.container(.pinned(spaceID: sid), id: pinID),
            SidebarItem.container(.today(spaceID: sid), id: todayID)
        ]
        return (SidebarDocument(spaceOrder: [sid], spaces: [space], items: items), sid, pinID, favID)
    }

    @Test("PhonePinOutbox prunes stale entries older than maxAge")
    func outboxPruning() {
        let old = PhonePinMutation(
            action: .pin,
            url: "https://old.example",
            title: "Old",
            createdAt: fixedNow.addingTimeInterval(-(PhonePinOutbox.maxAge + 60)),
            deviceID: "ios-1",
            deviceName: "iPhone"
        )
        let recent = PhonePinMutation(
            action: .pin,
            url: "https://fresh.example",
            title: "Fresh",
            createdAt: fixedNow.addingTimeInterval(-3600),
            deviceID: "ios-1",
            deviceName: "iPhone"
        )
        let outbox = PhonePinOutbox(mutations: [old, recent])
        let pruned = outbox.pruning(now: fixedNow)
        #expect(pruned.mutations == [recent])
    }

    @Test("applyPhonePins applies mutations idempotently and updates applied map")
    func applyPhonePinsIdempotent() {
        let (doc, sid, pinID, _) = makeDocument()
        let folderID = UUID()
        let m1 = PhonePinMutation(
            action: .createFolder,
            title: "Reading",
            spaceID: sid,
            itemID: folderID,
            createdAt: fixedNow.addingTimeInterval(-20),
            deviceID: "ios-1",
            deviceName: "iPhone"
        )
        let m2 = PhonePinMutation(
            action: .pin,
            url: "https://swift.org",
            title: "Swift",
            spaceID: sid,
            folderID: folderID,
            createdAt: fixedNow.addingTimeInterval(-10),
            deviceID: "ios-1",
            deviceName: "iPhone"
        )
        let outbox = PhonePinOutbox(mutations: [m2, m1])

        let first = ArcSyncMerger.applyPhonePins(outbox, appliedIDs: [:], to: doc, now: fixedNow)
        #expect(first.changed == true)
        #expect(first.appliedIDs.count == 2)
        let folder = first.document.items.first { $0.id == folderID }
        #expect(folder?.parentID == pinID)
        #expect(folder?.children.count == 1)
        let pinnedTab = first.document.items.first { $0.id == folder?.children.first }
        #expect(pinnedTab?.tab?.url == "https://swift.org")

        // Second pass with already-recorded IDs must be a no-op
        let second = ArcSyncMerger.applyPhonePins(outbox, appliedIDs: first.appliedIDs, to: first.document, now: fixedNow)
        #expect(second.changed == false)
        #expect(second.document == first.document)
    }

    @Test("ArcSyncMerger handles favorite, unfavorite, createSpace, rename, move, and cycle prevention")
    func mergerOperationsAndCycleGuard() {
        let (doc, sid, pinID, favID) = makeDocument()
        let folderA = UUID()
        let folderB = UUID()
        let tabID = UUID()
        let newSpaceID = UUID()

        let step1 = ArcSyncMerger.apply([
            ArcSyncMutation(action: .createFolder, title: "A", spaceID: sid, itemID: folderA, createdAt: fixedNow, deviceID: "chrome", deviceName: "Chrome"),
            ArcSyncMutation(action: .createFolder, title: "B", spaceID: sid, folderID: folderA, itemID: folderB, createdAt: fixedNow, deviceID: "chrome", deviceName: "Chrome"),
            ArcSyncMutation(action: .favorite, url: "https://github.com", title: "GitHub", spaceID: sid, itemID: tabID, createdAt: fixedNow, deviceID: "chrome", deviceName: "Chrome"),
            ArcSyncMutation(action: .createSpace, title: "Play", spaceID: newSpaceID, emoji: "🎮", colors: ["#FF0066", "#220033"], createdAt: fixedNow, deviceID: "chrome", deviceName: "Chrome")
        ], to: doc, now: fixedNow)

        #expect(step1.changed == true)
        #expect(step1.document.spaces.contains { $0.id == newSpaceID && $0.title == "Play" })
        #expect(step1.document.items.first { $0.id == favID }?.children.contains(tabID) == true)

        // Attempt illegal cycle: moving ancestor folderA into descendant folderB must be ignored!
        let cycleAttempt = ArcSyncMerger.apply([
            ArcSyncMutation(action: .move, spaceID: sid, folderID: folderB, itemID: folderA, createdAt: fixedNow, deviceID: "chrome", deviceName: "Chrome")
        ], to: step1.document, now: fixedNow)
        #expect(cycleAttempt.changed == false)
        #expect(cycleAttempt.document.items.first { $0.id == folderA }?.parentID == pinID)

        // Unfavorite & rename folder
        let step2 = ArcSyncMerger.apply([
            ArcSyncMutation(action: .unfavorite, spaceID: sid, itemID: tabID, createdAt: fixedNow, deviceID: "mac", deviceName: "Mac"),
            ArcSyncMutation(action: .rename, title: "Alpha", spaceID: sid, itemID: folderA, createdAt: fixedNow, deviceID: "mac", deviceName: "Mac")
        ], to: step1.document, now: fixedNow)
        #expect(step2.changed == true)
        #expect(step2.document.items.first { $0.id == favID }?.children.isEmpty == true)
        #expect(step2.document.items.first { $0.id == folderA }?.title == "Alpha")
    }

    @Test("ArcSyncAccessPolicy permits local/LAN/Tailscale IPs and blocks public IPs")
    func accessPolicyChecks() {
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("127.0.0.1") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("::1") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("::ffff:127.0.0.1") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("10.0.1.42") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("172.16.5.9") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("172.31.255.1") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("192.168.1.50") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("100.64.0.1") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("100.127.255.254") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("fe80::1%en0") == true)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("fd7a:115c:a1e0::1") == true)

        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("8.8.8.8") == false)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("1.1.1.1") == false)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("172.15.0.1") == false)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("172.32.0.1") == false)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("100.128.0.1") == false)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("2001:4860:4860::8888") == false)
        #expect(ArcSyncAccessPolicy.isAllowedPeerIP("") == false)
    }

    @Test("ArcSyncAccessPolicy constantTimeEqual checks tokens safely")
    func tokenEquality() {
        #expect(ArcSyncAccessPolicy.constantTimeEqual("abc123", "abc123") == true)
        #expect(ArcSyncAccessPolicy.constantTimeEqual("abc123", "abc124") == false)
        #expect(ArcSyncAccessPolicy.constantTimeEqual("abc123", "abc1234") == false)
        #expect(ArcSyncAccessPolicy.constantTimeEqual("", "") == true)
    }

    @Test("ArcSyncPairing encodes and decodes pairing URI")
    func pairingRoundTrip() {
        let uri = ArcSyncPairing.encodeURI(
            name: "Anton's Mac",
            token: "deadbeef0123",
            urls: ["http://192.168.1.10:46280", "http://100.100.1.5:46280"]
        )
        let decoded = ArcSyncPairing.decodeURI(uri)
        #expect(decoded == ArcSyncPairing.Payload(
            name: "Anton's Mac",
            token: "deadbeef0123",
            urls: ["http://192.168.1.10:46280", "http://100.100.1.5:46280"]
        ))
        #expect(ArcSyncPairing.decodeURI("https://example.com") == nil)
        #expect(ArcSyncPairing.decodeURI("arcsync://pair?name=Mac&token=&urls=http://127.0.0.1:46280") == nil)
    }
}
