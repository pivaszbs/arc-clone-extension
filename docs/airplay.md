# Apple TV playback from Offline Study

Chrome's Cast picker discovers Google Cast receivers. Apple's documented JavaScript AirPlay picker, `webkitShowPlaybackTargetPicker()`, is a Safari API. The Chrome extension API catalog has no AirPlay or macOS Control Center picker. [Google's Chrome casting guide](https://support.google.com/chrome/answer/3228332?hl=en) · [Apple's Safari AirPlay API](https://developer.apple.com/documentation/webkitjs/adding_an_airplay_button_to_your_safari_media_controls) · [Chrome extension API catalog](https://developer.chrome.com/docs/extensions/reference/api)

## Open the Anime Study player in Safari

Run `npm run cast:setup` once and keep `npm run cast:serve` running. The companion uses `ffmpeg` and `ffprobe` from your PATH. In Offline Study open an episode and choose **Cast to TV → Open AirPlay in Safari**. In Safari, choose **AirPlay** and select the TV. Both devices need access to the same local network.

The companion prepares an H.264/AAC MP4, copying compatible streams without re-encoding them. Safari opens at the current position and receives the episode's detected skip ranges and auto-skip preferences. **Save AirPlay MP4** keeps a copy of the prepared file. Japanese subtitles, when loaded, are included as a selectable track. **Stop Safari AirPlay** in Chrome ends the local share and removes the temporary copy. Safari plays one episode per handoff. [Apple’s video format guidance](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari) · [WebKit’s AirPlay guide](https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/)

## Mirror Anime Study with subtitles

Open **Control Center → Screen Mirroring** on the Mac and choose the Apple TV or AirPlay-enabled smart TV. Depending on macOS and the receiver, choose the Anime Study window or mirror the display. Mirroring preserves the rendered player, including its Japanese subtitle overlay and study controls. Apple documents choosing the target in Control Center. The public APIs for opening an AirPlay picker apply to media playback in a native app or Safari. [Apple's AirPlay guide for Mac](https://support.apple.com/guide/mac-help/mchld7e543a0/mac) · [Apple's native AirPlay guide](https://developer.apple.com/documentation/avfoundation/supporting-airplay-in-your-app)

## Play just the episode on the TV

QuickTime Player can open a downloaded video and send it through its **External Playback Menu**. This streams the movie from QuickTime. Anime Study's subtitle overlay, skip controls and watch position remain in Chrome. [QuickTime Player guide](https://support.apple.com/en-au/guide/quicktime-player/-qtp6cee0761b/mac)

Install or update the macOS companion with `npm run install:desktop-pip`. In Offline Study choose **Cast to TV → Open in QuickTime**. With downloads permission, Anime Study looks up the selected episode in Chrome's download history. The companion checks the file's name, size and modification time before opening it. For a file outside Chrome's download history, open it from Finder in QuickTime. [Chrome DownloadItem documentation](https://developer.chrome.com/docs/extensions/reference/api/downloads#type-DownloadItem) · [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
