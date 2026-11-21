import AVFoundation
import CraCore
import SwiftUI

struct SyncSettingsView: View {
    @ObservedObject var client = LiveSyncClient.shared
    @Environment(\.dismiss) private var dismiss

    @State private var pairLink = ""
    @State private var manualURL = ""
    @State private var manualToken = ""
    @State private var showingScanner = false
    @State private var working = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(client.isConnected ? "Connected to \(client.serverName ?? "Mac")" : "Not Connected")
                                .font(.headline)
                            if let synced = client.lastSyncedAt {
                                Text("Last synced \(synced.formatted(date: .omitted, time: .shortened))")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else {
                                Text("Scan QR or enter a pairing link from Mac Settings ▸ Sync.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if client.isConnected {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        }
                    }

                    if client.pendingOpsCount > 0 {
                        Text("\(client.pendingOpsCount) change(s) queued offline")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if let error = client.lastError {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                    if client.isConnected {
                        Button {
                            Task { await client.refreshNow() }
                        } label: {
                            Label(client.isSyncing ? "Syncing…" : "Sync Now", systemImage: "arrow.clockwise")
                        }
                        .disabled(client.isSyncing)

                        Button(role: .destructive) {
                            client.disconnect()
                        } label: {
                            Label("Disconnect", systemImage: "xmark.circle")
                        }
                    }
                } header: {
                    Text("Status")
                }

                Section {
                    Button {
                        showingScanner = true
                    } label: {
                        Label("Scan QR Code from Mac", systemImage: "qrcode.viewfinder")
                    }

                    HStack {
                        TextField("Paste arcsync://pair?... link", text: $pairLink)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Pair") {
                            Task {
                                working = true
                                if await client.pair(withURI: pairLink) { pairLink = "" }
                                working = false
                            }
                        }
                        .disabled(working || ArcSyncPairing.decodeURI(pairLink) == nil)
                    }
                } header: {
                    Text("Quick Pair")
                }

                if !client.discoveredPeers.isEmpty {
                    Section("Nearby Macs (Bonjour)") {
                        ForEach(client.discoveredPeers) { peer in
                            HStack {
                                Image(systemName: "laptopcomputer")
                                Text(peer.name)
                                Spacer()
                                Button("Use") {
                                    let host = peer.name.replacingOccurrences(of: " ", with: "-")
                                    manualURL = "http://\(host).local:46280"
                                }
                            }
                        }
                    }
                }

                Section("Manual Setup (LAN / Tailscale)") {
                    TextField("http://192.168.x.x:46280", text: $manualURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Sync Token", text: $manualToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Connect") {
                        Task {
                            working = true
                            _ = await client.pair(urls: manualURL.split(separator: ",").map(String.init), token: manualToken, name: "Mac")
                            working = false
                        }
                    }
                    .disabled(working || manualURL.trimmingCharacters(in: .whitespaces).isEmpty || manualToken.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                if !client.devices.isEmpty {
                    Section("Connected Devices") {
                        ForEach(client.devices) { device in
                            HStack {
                                Image(systemName: device.platform == "chrome" ? "globe" : "laptopcomputer")
                                VStack(alignment: .leading) {
                                    Text(device.name)
                                    Text(device.platform.capitalized).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Live Sync")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear { client.startDiscovery() }
            .onDisappear { client.stopDiscovery() }
            .sheet(isPresented: $showingScanner) {
                QRScannerSheet { scanned in
                    showingScanner = false
                    pairLink = scanned
                    Task {
                        working = true
                        _ = await client.pair(withURI: scanned)
                        working = false
                    }
                }
            }
        }
    }
}

private struct QRScannerSheet: View {
    let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if AVCaptureDevice.default(for: .video) != nil {
                    QRScannerRepresentable(onScan: onScan).ignoresSafeArea()
                } else {
                    ContentUnavailableView(
                        "Camera Unavailable",
                        systemImage: "camera.fill",
                        description: Text("Paste the arcsync://pair link from Mac Settings ▸ Sync.")
                    )
                }
            }
            .navigationTitle("Scan Mac QR Code")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController()
        controller.onScan = onScan
        return controller
    }

    func updateUIViewController(_ uiViewController: QRScannerController, context: Context) {}
}

private final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var handled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
        let capSession = session
        DispatchQueue.global(qos: .userInitiated).async { capSession.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let capSession = session
        DispatchQueue.global(qos: .userInitiated).async { capSession.stopRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !handled,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = obj.stringValue,
              ArcSyncPairing.decodeURI(value) != nil else { return }
        handled = true
        onScan?(value)
    }
}
