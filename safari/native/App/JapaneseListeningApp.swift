import SwiftUI

@main
struct JapaneseListeningApp: App {
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        Image(systemName: "ear.badge.waveform")
                            .font(.system(size: 54))
                            .foregroundStyle(.purple)
                            .accessibilityHidden(true)
                        Text("Learn while you watch.")
                            .font(.largeTitle.bold())
                        Text("Your Safari extension is installed. Enable it once, then use it directly on your video pages.")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                        GroupBox("Enable in Safari") {
                            VStack(alignment: .leading, spacing: 16) {
                                Text("1. Open Settings → Apps → Safari → Extensions.")
                                Text("2. Enable Japanese Listening and allow it on the video websites you use.")
                                Text("3. In Safari, open YouTube or smotret-anime and tap 日本語 Learn.")
                                Text("4. Turn on Pause for listening quizzes.")
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 8)
                        }
                        Text("Japanese subtitles are discovered automatically when the player supplies them. Correct answers space reviews further apart; mistakes bring phrases back sooner.")
                        Text("Use video websites inside Safari. This extension does not run inside the YouTube app.")
                            .foregroundStyle(.secondary)
                        Text("Selected subtitle lines may be sent to Google Translate for answer choices. Your review history stays on this device.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(32)
                    .frame(maxWidth: 680, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .navigationTitle("Japanese Listening")
            }
        }
    }
}
