import Foundation
import Testing
@testable import CraCore

@Suite("ArcSyncEndpoints")
struct ArcSyncEndpointsTests {
    @Test func tellsTailscaleAddressesApart() {
        #expect(ArcSyncEndpoints.isTailscale("http://100.72.200.13:46280"))
        #expect(ArcSyncEndpoints.isTailscale("http://100.127.0.1:46280/"))
        #expect(ArcSyncEndpoints.isTailscale("http://antons-macbook-pro-2.tail1234.ts.net:46280"))
        #expect(ArcSyncEndpoints.isTailscale("http://[fd7a:115c:a1e0::1]:46280"))
        #expect(!ArcSyncEndpoints.isTailscale("http://100.1.2.3:46280"))  // public 100.x, not CGNAT
        #expect(!ArcSyncEndpoints.isTailscale("http://192.168.1.20:46280"))
        #expect(!ArcSyncEndpoints.isTailscale("http://127.0.0.1:46280"))
        #expect(!ArcSyncEndpoints.isTailscale("not a url"))
    }

    @Test func phoneSkipsLoopbackAndTriesLANBeforeTailscale() {
        let urls = ["http://127.0.0.1:46280", "http://100.72.200.13:46280", "http://192.168.1.20:46280",
                    "http://localhost:46280", "http://192.168.1.20:46280/"]
        #expect(ArcSyncEndpoints.phoneOrder(urls, lastGood: nil)
                == ["http://192.168.1.20:46280", "http://100.72.200.13:46280"])
    }

    @Test func phoneTriesTheAddressThatAnsweredLastFirst() {
        let urls = ["http://192.168.1.20:46280", "http://100.72.200.13:46280", "http://mac.tail1.ts.net:46280"]
        #expect(ArcSyncEndpoints.phoneOrder(urls, lastGood: "http://mac.tail1.ts.net:46280/")
                == ["http://mac.tail1.ts.net:46280", "http://192.168.1.20:46280", "http://100.72.200.13:46280"])
        // An address the Mac no longer lists isn't tried.
        #expect(ArcSyncEndpoints.phoneOrder(urls, lastGood: "http://10.0.0.9:46280")
                == ["http://192.168.1.20:46280", "http://100.72.200.13:46280", "http://mac.tail1.ts.net:46280"])
    }

    @Test func readsTheMagicDNSNameFromTailscaleStatus() {
        let running = #"{"BackendState":"Running","Self":{"DNSName":"Antons-MacBook-Pro-2.tail1234.ts.net.","TailscaleIPs":["100.72.200.13"]}}"#
        #expect(ArcSyncEndpoints.magicDNSName(fromStatusJSON: Data(running.utf8)) == "antons-macbook-pro-2.tail1234.ts.net")
        let stopped = #"{"BackendState":"Stopped","Self":{"DNSName":"mac.tail1234.ts.net."}}"#
        #expect(ArcSyncEndpoints.magicDNSName(fromStatusJSON: Data(stopped.utf8)) == nil)
        let noMagicDNS = #"{"BackendState":"Running","Self":{"DNSName":""}}"#
        #expect(ArcSyncEndpoints.magicDNSName(fromStatusJSON: Data(noMagicDNS.utf8)) == nil)
        #expect(ArcSyncEndpoints.magicDNSName(fromStatusJSON: Data("garbage".utf8)) == nil)
    }

    @Test func pairingLinkListsLANThenTailscaleThenLoopback() {
        let urls = ArcSyncEndpoints.pairingURLs(ips: ["100.72.200.13", "192.168.1.20", "192.168.1.20"],
                                                magicDNS: "mac.tail1234.ts.net", port: 46280)
        #expect(urls == ["http://192.168.1.20:46280", "http://100.72.200.13:46280",
                         "http://mac.tail1234.ts.net:46280", "http://127.0.0.1:46280"])
        #expect(ArcSyncEndpoints.pairingURLs(ips: [], magicDNS: nil, port: 1) == ["http://127.0.0.1:1"])
    }
}
