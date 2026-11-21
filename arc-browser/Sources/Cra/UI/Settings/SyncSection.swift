import AppKit
import SwiftUI

/// Settings ▸ General ▸ Sync: iCloud keeps the sidebar, the settings and the shortcuts the
/// same on the user's Macs (SettingsSyncService); a folder a provider syncs is the other way.
/// Off, the card is one switch and "Use a folder instead…"; on, the state and Stop Syncing.
/// The same bundle backs Export… and Import… for people with one Mac.
import CoreImage.CIFilterBuiltins

struct SyncSection: View {
    @Environment(SettingsSyncService.self) private var sync
    @Environment(LocalSyncServer.self) private var liveSync
    @State private var importing: (URL, SyncBundleSummary)?
    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .alert("Use the sidebar from your other Mac?", isPresented: Binding(get: { sync.pendingChoice != nil }, set: { _ in })) {
                Button("Use That Sidebar") { sync.useRemote() }
                Button("Replace It with This Mac’s") { sync.useLocal() }
                Button("Cancel", role: .cancel) { sync.disable() }
            } message: {
                if let found = sync.pendingChoice { Text(Self.describe(found) + " Using it replaces this Mac’s sidebar, settings and shortcuts.") }
            }
            .alert("Import these settings?", isPresented: Binding(get: { importing != nil }, set: { if !$0 { importing = nil } })) {
                Button("Import") {
                    if let (url, _) = importing { notice = sync.importBundle(from: url) ? "Settings imported." : "The folder holds no Arc clone settings." }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                if let (_, s) = importing { Text(Self.describe(s) + " Importing replaces this Mac’s sidebar, settings and shortcuts.") }
            }
    }

    @ViewBuilder private var content: some View {
        SettingsHeader("Sync")
        SettingsFeatureCard {
            SettingsPlainRow("Sync with iCloud",
                               detail: sync.iCloudAvailable
                                   ? "Your spaces, pinned tabs, favorites, settings and shortcuts stay the same on every Mac signed in to this iCloud account."
                                   : iCloudUnavailableReason,
                               trailing: {
                Toggle("Sync with iCloud", isOn: Binding(get: { sync.location == .iCloud }, set: { on in on ? enableICloud() : sync.disable() }))
                    .toggleStyle(.arcSwitch).labelsHidden()
                    .disabled(!sync.iCloudAvailable)
            }) {
                // macOS doesn't tell apps which Apple Account is signed in; System Settings shows it.
                Button("iCloud Settings…") { NSWorkspace.shared.open(Self.appleAccountSettings) }
            }
            if case .folder(let path)? = sync.location {
                SettingsCardDivider()
                SettingsCardRow {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Sync folder").font(.system(size: 13))
                        Text((path as NSString).abbreviatingWithTildeInPath)
                            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                } trailing: {
                    Button("Stop Syncing") { sync.disable() }
                }
            } else if sync.location == nil {
                SettingsCardDivider()
                SettingsCardRow {
                    Text("Or sync through a folder in Dropbox, OneDrive or a similar service").font(.system(size: 13))
                } trailing: {
                    Button("Use a Folder…") { chooseFolder() }
                }
            }
            if sync.location != nil {
                SettingsCardDivider()
                SettingsCardRow {
                    Text(status).font(.system(size: 13)).foregroundStyle(sync.error == nil ? .secondary : Color.red)
                } trailing: {
                    if !sync.otherDevices.isEmpty {
                        Text("Also on " + sync.otherDevices.joined(separator: ", ")).font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                }
            }
            SettingsCardDivider()
            SettingsCardRow {
                Text("Settings file").font(.system(size: 13))
            } trailing: {
                Button("Export…") { exportBundle() }
                Button("Import…") { importBundle() }
            }
        }
        SettingsFootnote(notice ?? "Spaces, pinned tabs, favorites, folders, settings and shortcuts sync. Logins, cookies, history and extensions stay on each Mac.")
        liveSyncSection
    }

    @ViewBuilder private var liveSyncSection: some View {
        SettingsHeader("Live Sync (iPhone & Chrome)").padding(.top, 20)
            .onAppear { liveSync.refreshReachableURLs() }
        SettingsCard {
            SettingsCardRow {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Local & Tailscale live sync").font(.system(size: 13, weight: .medium))
                    Text(liveSync.isRunning
                         ? "Listening on port \(liveSync.port) · \(liveSync.otherDevices.count) paired \(liveSync.otherDevices.count == 1 ? "peer" : "peers")"
                         : (liveSync.lastError ?? "Stopped"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            } trailing: {
                Toggle("Live Sync", isOn: Binding(get: { liveSync.enabled }, set: { liveSync.setEnabled($0) }))
                    .toggleStyle(.arcSwitch).labelsHidden()
            }

            if liveSync.enabled {
                SettingsCardDivider()
                SettingsCardRow {
                    HStack(alignment: .top, spacing: 14) {
                        if let qr = Self.qrImage(for: liveSync.pairingURI) {
                            Image(nsImage: qr)
                                .interpolation(.none)
                                .resizable()
                                .frame(width: 96, height: 96)
                                .background(Color.white)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Pair iPhone or Chrome extension").font(.system(size: 13, weight: .medium))
                            Text("Scan this QR code in Arc clone for iOS or paste the pairing link in Chrome.")
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                            ForEach(liveSync.reachableURLs, id: \.self) { endpoint in
                                Text(endpoint)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                            HStack(spacing: 8) {
                                Button("Copy Pairing Link") {
                                    copyToPasteboard(liveSync.pairingURI, message: "Copied pairing link to clipboard.")
                                }
                                Button("Copy Token") {
                                    copyToPasteboard(liveSync.token, message: "Copied sync token to clipboard.")
                                }
                                Button("Regenerate Token") {
                                    liveSync.regenerateToken()
                                    notice = "Generated a new sync token. Re-pair connected devices."
                                }
                            }
                            .padding(.top, 4)
                        }
                    }
                    .padding(.vertical, 4)
                } trailing: {
                    EmptyView()
                }

                if !liveSync.otherDevices.isEmpty {
                    SettingsCardDivider()
                    SettingsCardRow {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Connected peers").font(.system(size: 12, weight: .medium))
                            ForEach(liveSync.otherDevices) { peer in
                                Text("\(peer.name) · \(peer.platform) · \(Self.relative.localizedString(for: peer.lastSeenAt, relativeTo: Date()))")
                                    .font(.system(size: 11)).foregroundStyle(.secondary)
                            }
                        }
                    } trailing: {
                        EmptyView()
                    }
                }
            }
        }
        SettingsFootnote("Reaches devices only on loopback, your LAN, or Tailscale. Never exposes ports to the public internet.")
    }

    private func copyToPasteboard(_ value: String, message: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        notice = message
    }

    private static func qrImage(for text: String) -> NSImage? {
        guard !text.isEmpty, let data = text.data(using: .utf8) else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = data
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 6, y: 6))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    static let appleAccountSettings = URL(string: "x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings")!

    private var iCloudUnavailableReason: String {
        FileManager.default.ubiquityIdentityToken == nil
            ? "Sign in to iCloud in System Settings to sync this way."
            : "This build of Arc clone cannot use iCloud. The signed release can."
    }

    private var status: String {
        if let error = sync.error { return error }
        if sync.awaitingDownload { return "Waiting for iCloud to download your other Mac’s sidebar…" }
        if sync.pendingChoice != nil { return "Waiting for your choice" }
        guard let date = sync.lastSync else { return "Not synced yet" }
        return "Synced " + Self.relative.localizedString(for: date, relativeTo: Date())
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f
    }()

    private static func describe(_ s: SyncBundleSummary) -> String {
        let when = s.writtenAt.formatted(date: .abbreviated, time: .shortened)
        return "\(s.device) saved \(s.spaces) \(s.spaces == 1 ? "space" : "spaces") and \(s.tabs) \(s.tabs == 1 ? "tab" : "tabs") on \(when)."
    }

    private func enableICloud() {
        notice = nil
        if case .failed(let reason) = sync.enableICloud() { notice = reason }
    }

    private func folderPanel(prompt: String, message: String) -> NSOpenPanel {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = prompt
        panel.message = message
        return panel
    }

    private func chooseFolder() {
        let panel = folderPanel(prompt: "Sync Here", message: "Choose a folder your Macs share, in Dropbox, OneDrive or a similar service. Cra keeps its files in a “Cra” folder inside it.")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        notice = nil
        if case .failed(let reason) = sync.enable(folder: url) { notice = reason }
    }

    private func exportBundle() {
        let panel = folderPanel(prompt: "Export", message: "Choose where to save a “Cra” folder with your sidebar, settings and shortcuts.")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        notice = sync.export(to: url).map { "Not exported: \($0)" } ?? "Exported to \((url.path as NSString).abbreviatingWithTildeInPath)/Cra."
    }

    private func importBundle() {
        let panel = folderPanel(prompt: "Import", message: "Choose the folder that holds the exported “Cra” folder, or that folder itself.")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if let summary = sync.summary(ofBundleIn: url) { importing = (url, summary) } else { notice = "The folder holds no Arc clone settings." }
    }
}
