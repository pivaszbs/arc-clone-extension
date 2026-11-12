# Japanese Listening — standalone Safari extension

This is our own Safari Web Extension with a small containing iPad app. It does not use Userscripts or require Arc for Chrome. It shares the Japanese player controls, automatic subtitle discovery, translation questions, and review schedule with the existing project.

## Current build status

The web extension is bundled, and the Xcode project has been generated and structurally checked. The native Swift files have been syntax checked. Full Xcode and the iPadOS SDK are not installed on the development Mac, so native compilation, signing, and installation have not yet been verified. This archive is source code, not an installable signed iPad app.

## Free personal-device installation

1. Install Apple's free Xcode app on the Mac, open it, and let it complete its initial setup and download the iOS platform tools.
2. Open `JapaneseListening.xcodeproj` in Xcode.
3. In Xcode's account settings, sign in with your Apple Account. Credentials stay in Apple's sign-in interface.
4. In Signing & Capabilities, select your Personal Team for both the `JapaneseListening` app and `JapaneseListeningExtension` targets. If the default bundle identifiers are unavailable, choose your own unique reverse-domain prefix for the app and give the extension the same prefix plus `.Extension`.
5. Connect and trust the iPad in Xcode. Initial device pairing may require a cable; after pairing, Xcode can offer network deployment. Enable Developer Mode on the iPad if Xcode asks.
6. Select your iPad as the destination, choose the JapaneseListening scheme, and Run. Xcode builds and installs the containing app and Safari extension together.
7. On the iPad, go to Settings → Apps → Safari → Extensions, enable Japanese Listening, and allow it on the video websites and player frames you use.
8. Open a video in Safari. Tap **日本語 Learn**, confirm **Connected to video**, and enable listening quizzes.

A free Personal Team is for personal device testing and has provisioning restrictions, including short-lived profiles. Xcode may require reinstalling / re-signing the app periodically. A Wi-Fi download of a ZIP or JavaScript file cannot install this standalone extension by itself.

Apple's instructions:
- https://developer.apple.com/help/account/basics/about-your-developer-account
- https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension

## Rebuilding

Run `npm run build:safari` from the repository. It produces:

- `outputs/safari/JapaneseListening/` — app, extension resources, and Xcode project.
- `outputs/safari/JapaneseListening-Xcode.zip` — complete Xcode source package.
- `outputs/safari/JapaneseListening-WebExtension.zip` — web resources for Apple's packager, if an existing developer membership is used later.

You can set `SAFARI_BUNDLE_ID` and optionally `APPLE_DEVELOPMENT_TEAM` before building to prefill signing identifiers. Neither value is a password or certificate; no credentials are bundled.

## Runtime and privacy

The extension declares only the storage API, plus HTTPS website access for video pages, embedded players, and their subtitle CDNs. Safari controls which sites you allow. The learning panel only activates on YouTube, smotret-anime.com / .net, and their player frames. Other Arc browser functions and browser-history access are not included.

Subtitle discovery looks for player-provided Japanese text; it cannot create a transcript where none exists. Selected phrases may be sent to Google Translate to prepare answers. Review history stays in this Safari extension's local storage. It is separate from the earlier Userscripts / Chrome histories. Physical iPad playback still needs verification.
