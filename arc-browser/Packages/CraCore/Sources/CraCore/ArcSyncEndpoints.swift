import Foundation

/// Where Live Sync reaches the Mac. Its pairing link lists every address it listens on: the LAN,
/// Tailscale (so the phone syncs away from home) and loopback (for the Chrome extension on the
/// same Mac). Tailscale's traffic is WireGuard-encrypted, which is why plain HTTP is fine on it.
public enum ArcSyncEndpoints {
    /// Tailscale's addresses: 100.64.0.0/10 (CGNAT), fd7a:115c:a1e0::/48, and MagicDNS names under ts.net.
    public static func isTailscale(_ url: String) -> Bool {
        guard let host = host(of: url) else { return false }
        if host.hasSuffix(".ts.net") { return true }
        if host.hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = host.split(separator: ".")
        guard parts.count == 4, let a = UInt8(parts[0]), let b = UInt8(parts[1]),
              parts.dropFirst(2).allSatisfy({ UInt8($0) != nil }) else { return false }
        return a == 100 && (64...127).contains(b)
    }

    /// Loopback reaches the device itself: right for the extension on the Mac, never for a phone.
    public static func isLoopback(_ url: String) -> Bool {
        guard let host = host(of: url) else { return false }
        return host == "localhost" || host == "::1" || host.hasPrefix("127.")
    }

    /// The order a phone tries the Mac's addresses in: the one that answered last (it is usually
    /// still right, and a dead LAN address costs a timeout each try), then the LAN, then Tailscale.
    /// Loopback is dropped, and so are duplicates.
    public static func phoneOrder(_ urls: [String], lastGood: String?) -> [String] {
        var seen: Set<String> = []
        let clean = urls.map(normalized).filter { !$0.isEmpty && !isLoopback($0) && seen.insert($0).inserted }
        let lan = clean.filter { !isTailscale($0) }
        let tailnet = clean.filter(isTailscale)
        var ordered = lan + tailnet
        if let lastGood = lastGood.map(normalized), let index = ordered.firstIndex(of: lastGood) {
            ordered.insert(ordered.remove(at: index), at: 0)
        }
        return ordered
    }

    /// This Mac's MagicDNS name from `tailscale status --json` (`Self.DNSName`, without its final
    /// dot), or nil when Tailscale is off or MagicDNS isn't on.
    public static func magicDNSName(fromStatusJSON data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["BackendState"] as? String).map({ $0 == "Running" }) ?? true,
              let me = root["Self"] as? [String: Any],
              let raw = me["DNSName"] as? String else { return nil }
        let name = raw.hasSuffix(".") ? String(raw.dropLast()) : raw
        return name.hasSuffix(".ts.net") ? name.lowercased() : nil
    }

    /// The Mac's addresses for its pairing link: LAN first, then Tailscale (IP and MagicDNS name), then loopback.
    public static func pairingURLs(ips: [String], magicDNS: String?, port: UInt16) -> [String] {
        let urls = ips.map { ip in ip.contains(":") ? "http://[\(ip)]:\(port)" : "http://\(ip):\(port)" }
        let lan = urls.filter { !isTailscale($0) && !isLoopback($0) }
        var tailnet = urls.filter(isTailscale)
        if let magicDNS { tailnet.append("http://\(magicDNS):\(port)") }
        var seen: Set<String> = []
        return (lan + tailnet + ["http://127.0.0.1:\(port)"]).filter { seen.insert($0).inserted }
    }

    private static func normalized(_ url: String) -> String {
        url.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private static func host(of url: String) -> String? {
        URLComponents(string: normalized(url))?.host?.lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    }
}
