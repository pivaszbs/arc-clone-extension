import Testing
@testable import CraCore

@Suite("MobileOnboardingMemory")
struct MobileOnboardingMemoryTests {
    @Test func eitherCopyMeansSeen() {
        #expect(!MobileOnboardingMemory.seen(settings: false, keychain: false))
        #expect(MobileOnboardingMemory.seen(settings: true, keychain: false))
        // Reinstalled: the settings file is new, the Keychain remembers.
        #expect(MobileOnboardingMemory.seen(settings: false, keychain: true))
    }

    @Test func theCopiesAreBroughtBackInLine() {
        #expect(MobileOnboardingMemory.repairs(settings: false, keychain: false) == nil)
        #expect(MobileOnboardingMemory.repairs(settings: true, keychain: true) == nil)
        #expect(MobileOnboardingMemory.repairs(settings: false, keychain: true)! == (true, true))
        #expect(MobileOnboardingMemory.repairs(settings: true, keychain: false)! == (true, true))
    }
}
