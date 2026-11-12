import AppKit
import WebKit

let outputLock = NSLock()
func send(_ value: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: value), body.count < 1_000_000 else { return }
    var length = UInt32(body.count).littleEndian
    outputLock.lock(); defer { outputLock.unlock() }
    FileHandle.standardOutput.write(Data(bytes: &length, count: 4))
    FileHandle.standardOutput.write(body)
}
func readExactly(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        let part = FileHandle.standardInput.readData(ofLength: count - data.count)
        if part.isEmpty { return nil }
        data.append(part)
    }
    return data
}

final class DesktopPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
final class Player: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    var panel: DesktopPanel?
    var web: WKWebView?
    var session = ""
    var isClosing = false
    var muted = false
    var volume = 1.0
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.global(qos: .userInitiated).async {
            while let header = readExactly(4) {
                let length = header.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) }
                guard length > 0, length <= 2_000_000, let body = readExactly(Int(length)),
                      let message = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { break }
                DispatchQueue.main.async { self.receive(message) }
            }
            DispatchQueue.main.async { self.close(); NSApplication.shared.terminate(nil) }
        }
    }
    func receive(_ message: [String: Any]) {
        let type = message["type"] as? String ?? ""
        if type == "open" {
            close()
            session = message["sessionId"] as? String ?? ""
            muted = message["muted"] as? Bool ?? false
            volume = min(1, max(0, message["volume"] as? Double ?? 1))
            open()
        } else if type == "start", message["sessionId"] as? String == session {
            guard let mime = message["mime"] as? String, mime.count < 150 else { return }
            evaluate("window.start", [mime, muted, volume, message["paused"] as? Bool ?? false])
        } else if type == "playback", message["sessionId"] as? String == session {
            guard let paused = message["paused"] as? Bool else { return }
            evaluate("window.setPlayback", [paused, message["failed"] as? Bool ?? false])
        } else if type == "chunk", message["sessionId"] as? String == session {
            guard let data = message["data"] as? String, data.count < 1_500_000 else { return }
            evaluate("window.chunk", [data])
        } else if type == "status" {
            let id = message["requestId"] as? String ?? ""
            web?.evaluateJavaScript("window.statusSnapshot()") { result, error in
                send(["type":"status", "requestId":id, "sessionId":self.session,
                      "media":result as? [String:Any] ?? [:], "window":self.windowState()])
            }
        } else if type == "close" { close() }
    }
    func evaluate(_ function: String, _ arguments: [Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: arguments), let json = String(data:data, encoding:.utf8) else { return }
        web?.evaluateJavaScript("\(function)(...\(json))") { _, error in
            if error != nil { send(["type":"error","sessionId":self.session,"error":"The desktop player could not receive video."]) }
        }
    }
    func windowState() -> [String:Any] {
        guard let panel = panel else { return ["visible":false] }
        return ["visible":panel.isVisible, "onActiveSpace":panel.isOnActiveSpace, "allSpaces":panel.collectionBehavior.contains(.canJoinAllSpaces),
                "fullScreenAuxiliary":panel.collectionBehavior.contains(.fullScreenAuxiliary),
                "nonactivating":panel.styleMask.contains(.nonactivatingPanel), "hidesOnDeactivate":panel.hidesOnDeactivate,
                "floating":panel.level == .floating]
    }
    func open() {
        let panel = DesktopPanel(contentRect:NSRect(x:0,y:0,width:480,height:270),
                                 styleMask:[.titled,.closable,.resizable,.nonactivatingPanel],
                                 backing:.buffered,defer:false)
        // Set these BEFORE the panel is first shown, for other apps' full-screen Spaces.
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary,.stationary,.ignoresCycle]
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.isReleasedWhenClosed = false
        panel.title = "Across desktops"
        panel.contentMinSize = NSSize(width:240,height:135)
        panel.contentAspectRatio = NSSize(width:16,height:9)
        panel.delegate = self
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.websiteDataStore = .nonPersistent()
        if #available(macOS 14.0, *) { configuration.preferences.inactiveSchedulingPolicy = .none }
        configuration.userContentController.add(self,name:"bridge")
        let web = WKWebView(frame:NSRect(x:0,y:0,width:480,height:270),configuration:configuration)
        panel.contentView = web
        self.panel = panel; self.web = web
        let resources = URL(fileURLWithPath:CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/receiver.html")
        guard let html = try? String(contentsOf:resources,encoding:.utf8) else {
            send(["type":"error","sessionId":session,"error":"Desktop player resources are missing."]); close(); return
        }
        web.loadHTMLString(html,baseURL:URL(string:"https://arc-pip.invalid/"))
        let pointerScreen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) }
        if let frame = (pointerScreen ?? NSScreen.main)?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x:frame.maxX-panel.frame.width-20,y:frame.minY+24))
        }
        panel.orderFrontRegardless()
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard var value = message.body as? [String:Any] else { return }
        value["sessionId"] = session
        if value["type"] as? String == "ready" { value["window"] = windowState() }
        send(value)
    }
    func windowWillClose(_ notification: Notification) { if !isClosing { close() } }
    func close() {
        guard panel != nil else { return }
        isClosing = true
        web?.configuration.userContentController.removeScriptMessageHandler(forName:"bridge")
        web?.loadHTMLString("",baseURL:nil)
        panel?.delegate = nil; panel?.close(); panel = nil; web = nil
        send(["type":"closed","sessionId":session]); session = ""
        isClosing = false
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let player = Player()
app.delegate = player
app.run()
