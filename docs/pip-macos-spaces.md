# PiP across macOS desktops and full-screen Spaces

The user reported that the original browser-only PiP disappeared when switching to another application's full-screen Space. The earlier nine browser PiP tests checked `document.pictureInPictureElement`; they could not detect this OS-window problem.

## Fix

On macOS, **Across desktops** opens a local Swift/AppKit companion. Its `NSPanel` is created with a titled non-activating style, `.canJoinAllSpaces`, `.fullScreenAuxiliary`, floating level, and `hidesOnDeactivate = false` before being shown. Its WebKit receiver has inactive scheduling disabled when the OS supports that setting.

Apple documents [canJoinAllSpaces](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/canjoinallspaces) as allowing a window to appear on all Spaces and [fullScreenAuxiliary](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/fullscreenauxiliary) as displaying on the same Space as a full-screen window. Chrome's own window remains outside the extension's control.

The source video stays in its original tab. Its media capture is encoded into short fragments and sent over Chrome native messaging to the local panel. The receiver treats the fragments as an infinite live stream. This matters because the first implementation interpreted finite fragment metadata as the end of playback even while Chrome continued sending video. Matching the keyframe interval to the 250 ms capture interval also avoids waiting several seconds between MP4 fragments.

No website login, cookies, page navigation, screen capture, microphone capture, external service, or external HTTP server is used by the companion. Only this extension's ID is allowed in its host registration. DRM and cross-origin capture restrictions still apply.

## Verification performed on this Mac

Two separate forms of evidence are retained:

- Cucumber exercises the actual built extension and compiled companion in isolated Chrome and Chrome for Testing profiles. It asserts native window configuration, decoding, continued live playback, blob video, captured audio-track presence and volume, and restoring the original page.
- The visible OS check opens a real player while Finder is moved into or raised on its native full-screen Space. After the UI transition, the test queries the companion's own public native window API and media state.

[NSWindow.isOnActiveSpace](https://developer.apple.com/documentation/appkit/nswindow/isonactivespace) reports whether a visible window is visible on the currently active Space. That makes the OS check stronger than looking only at a browser DOM flag or assuming an individual-window screenshot contains other apps' overlays.

Recorded results are in [Chrome for Testing](../artifacts/e2e/desktop-pip-os-chromium.json) and [installed Chrome](../artifacts/e2e/desktop-pip-os-chrome.json). Both record `visible`, `onActiveSpace`, `fullScreenAuxiliary`, and `allSpaces` as true during the full-screen Finder check, with the receiver unpaused and playback advancing. The installed Chrome check also records returning to the ordinary desktop.

These OS transitions were driven through native UI automation, separately from the unattended Cucumber runs. The Cucumber suite does not claim to create or inspect macOS Spaces by itself. Physical second-monitor movement and every possible application/OS version have not been tested. Native Arc equivalence remains outside these checks.

## Existing implementation preflight

[FullFloatPiP](https://github.com/Sigmame/full-float-pip) was checked as an example of an extension plus Swift/AppKit companion. No repository-root license was found during the check, and its URL/player reopening model did not provide the selected-video capture behavior used here. No code was copied or installed. This companion uses Apple's installed AppKit/WebKit frameworks and Chrome's existing native-messaging API.

## Repeating the OS check

```sh
npm run build:desktop-pip
npm run build
node scripts/inspect-desktop-pip.mjs
# Or: PIP_BROWSER=chrome node scripts/inspect-desktop-pip.mjs
```

Switch to a native full-screen app using the OS UI, then type a label such as `finder-full-screen` into the test's terminal. The assertion requires that the native window is visible on the active Space and its receiver is playing. Type `close` to close the browser, native panel, server, and disposable profile.
