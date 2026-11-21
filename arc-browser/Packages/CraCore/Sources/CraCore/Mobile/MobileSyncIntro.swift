import Foundation

/// Cra's version of Arc Search 1.49's "Sync with Arc Desktop" (Victor's recording, 3:30): the
/// Spaces sheet before anything has synced, and the "Every tab, anywhere." card over the tab
/// row's Spaces button. Arc signs in to an Arc account; Cra has none, its Mac sends its Spaces
/// through iCloud, so the two buttons lead to how to turn that on, or where to get Cra.
public enum MobileSyncIntro {
    public enum Page: Equatable { case intro, haveMac, noMac }

    public static let title = "Sync with Arc clone for Mac"
    public static let body = "Search and browse your Arc clone Spaces on the go."
    public static let haveMacButton = "I have Arc clone on my Mac"
    public static let noMacButton = "I don\u{2019}t have Arc clone yet"
    public static let goBack = "Go back"

    public static let haveMacTitle = "Turn on Sync on your Mac"
    /// Live Sync pairs over the local network or Tailscale (ArcSyncEndpoints), so iCloud isn't
    /// needed; `iCloud` is kept for the builds whose signing carries the iCloud container.
    public static func haveMacBody(iCloud: Bool) -> String {
        "In Arc clone on your Mac, open Settings, turn on Live Sync and scan its QR code from this iPhone\u{2019}s Settings \u{25B8} Live Sync. With Tailscale on both, they sync away from home too."
    }

    public static let noMacTitle = "Get Arc clone on your computer first"
    public static let noMacBody = "Build Arc clone for Mac from its repo (arc-browser/scripts/build.sh), then pair this iPhone with it."

    public static let cardTitle = "Every tab, anywhere."
    public static let cardDetail = "Sync with Arc clone for Mac"

    /// The card shows over the tab row until it is closed, and never once the Mac's Spaces are here.
    public static func showsCard(hasSpaces: Bool, dismissed: Bool) -> Bool { !hasSpaces && !dismissed }

    /// The Spaces sheet while iCloud is asked for the Mac's sidebar (Arc Search 1.49: a cloud with
    /// two waves over it and "Connecting").
    public static let connecting = "Connecting"

    /// Arc Search 1.49 asks once, after the desktop's Spaces first show up, to set up its share
    /// extension (Victor's screenshot IMG_1898, 13 Nov). Cra's extension saves to the phone's tabs.
    public static let shareTitle = "Save links to Arc clone from other apps!"
    public static let shareBody = "Set up Arc clone\u{2019}s share extension to add links from other apps to your tabs."
    public static let shareSetUp = "Set up"
    public static let shareNoThanks = "No, thanks"

    /// The prompt comes once, the first time the Mac's Spaces are on the phone.
    public static func showsSharePrompt(hasSpaces: Bool, seen: Bool) -> Bool { hasSpaces && !seen }

    /// The how-to sheet "Set up" opens (IMG_1899): three steps, then a button that opens a share
    /// menu to try it in.
    public static let guideTitle = "Save to Arc clone from any app"
    /// A step: its blue label, then its text (a line break where Arc breaks it), with the SF Symbol `symbol` drawn where `{icon}` is.
    public struct GuideStep: Equatable, Sendable {
        public let label: String
        public let text: String
        public let symbol: String?
    }
    public static let guideSteps = [
        GuideStep(label: "Step 1:", text: "Open a {icon} share menu", symbol: "square.and.arrow.up"),
        GuideStep(label: "Step 2:", text: "Scroll past the apps and\ntap \u{201C}More\u{201D}", symbol: nil),
        GuideStep(label: "Step 3:", text: "Tap Edit, find \u{201C}Arc clone\u{201D}, tap {icon}", symbol: "plus.circle.fill"),
    ]
    public static let guideButton = "Show share menu"
}
