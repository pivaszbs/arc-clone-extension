import Foundation
import Testing
@testable import CraCore

@Suite("MobileSync")
struct MobileSyncTests {
    private let fixedNow = Date(timeIntervalSince1970: 1_750_000_000)

    @Test("MobileSettings preserves defaults on empty JSON and round-trips liveSync fields")
    func mobileSettingsLiveSyncRoundTrip() throws {
        let empty = try JSONDecoder().decode(MobileSettings.self, from: Data("{}".utf8))
        #expect(empty.hasLiveSync == false)
        #expect(empty.liveSyncURLs == nil)

        var configured = MobileSettings()
        configured.liveSyncURLs = ["http://192.168.1.2:46280", "http://127.0.0.1:46280"]
        configured.liveSyncToken = "tok123"
        configured.liveSyncPeerName = "Mac Studio"
        configured.liveSyncEnabled = true
        #expect(configured.hasLiveSync == true)

        let data = try JSONEncoder().encode(configured)
        let decoded = try JSONDecoder().decode(MobileSettings.self, from: data)
        #expect(decoded == configured)
    }

    @Test("MobileShareInbox Destination supports space, folder, and browseForMe while rejecting bare space")
    func mobileShareDestinationRoundTrip() throws {
        let sid = UUID()
        let fid = UUID()
        let spaceDest = MobileShareInbox.Destination.space(sid, folderID: fid)
        let encoded = try JSONEncoder().encode(spaceDest)
        let decoded = try JSONDecoder().decode(MobileShareInbox.Destination.self, from: encoded)
        #expect(decoded == spaceDest)

        let browse = MobileShareInbox.Destination.browseForMe
        #expect(MobileShareInbox.Destination(rawValue: browse.rawValue) == .browseForMe)
        #expect(MobileShareInbox.Destination(rawValue: "space") == nil)
    }

    @Test("MobileSpaces lists folders, space summaries, and applies optimisticPin")
    func mobileSpacesHelpers() {
        var doc = SidebarDocument.fresh()
        let space = doc.spaces[0]
        let folder = SidebarItem.folder("Reading", parent: space.pinnedContainerID)
        doc.items.append(folder)
        if let idx = doc.items.firstIndex(where: { $0.id == space.pinnedContainerID }) {
            doc.items[idx].children.append(folder.id)
        }

        let summaries = MobileSpaces.spaceSummaries(in: doc)
        #expect(summaries.count == 1)
        #expect(summaries[0].id == space.id)

        let folders = MobileSpaces.folders(in: doc, spaceID: space.id)
        #expect(folders.map(\.id) == [folder.id])

        let updated = MobileSpaces.optimisticPin(
            url: "https://swift.org",
            title: "Swift",
            spaceID: space.id,
            folderID: folder.id,
            in: doc,
            now: fixedNow
        )
        let updatedFolder = updated.items.first { $0.id == folder.id }
        #expect(updatedFolder?.children.count == 1)
        let pinnedItem = updated.items.first { $0.id == updatedFolder?.children.first }
        #expect(pinnedItem?.tab?.url == "https://swift.org")
    }
}
