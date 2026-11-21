import CraCore
import Foundation
import Security

/// The Keychain's copy of "the intro has been seen" (MobileOnboardingMemory). Keychain items stay
/// when the app is deleted, so a reinstall or a fresh build doesn't show the intro again.
enum OnboardingKeychain {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "arcclone") + ".onboarding",
         kSecAttrAccount as String: "seen"]
    }

    static var seen: Bool {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess
    }

    static func markSeen() {
        guard !seen else { return }
        var item = query
        item[kSecValueData as String] = Data("1".utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }
}
