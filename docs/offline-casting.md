# Casting Offline Study to a TV

Offline Study loads downloaded episodes through browser-local `blob:` URLs. Chromium’s Remote Playback check accepts `http:`, `https:`, and `file:` sources. A `blob:` source cannot use that device picker. [Chromium source compatibility check](https://chromium.googlesource.com/chromium/src/+/HEAD/media/remoting/renderer_controller.cc#338)

Chrome’s **Cast tab** sends the rendered tab, so the video and Offline Study’s Japanese subtitle and study overlays travel together. Open the episode in Offline Study, select Chrome’s **⋮ → Cast, save, and share → Cast…**, choose **Cast tab** under **Sources** if shown, and select the TV. Start fullscreen after connecting if you want the video to fill the TV. Stop from Chrome’s Cast toolbar control. [Google’s Chrome casting guide](https://support.google.com/chromecast/answer/3228332?hl=en) · [Google’s tab projection explanation](https://support.google.com/chromecast/answer/3210064?hl=en)

The Mac and a Google Cast-compatible TV or receiver need to be on the same Wi-Fi network. On macOS 15 or later, enable **Google Chrome** under **System Settings → Privacy & Security → Local Network** if Chrome cannot discover the receiver. [Google’s local network guide](https://support.google.com/chromecast/answer/10063094?hl=en) · [Google’s discovery troubleshooting](https://support.google.com/chromecast/answer/7172427?hl=en)

Chrome’s public extension API catalog has no method to open the browser’s Cast tab picker. The documented `tabCapture` API returns the tab’s audio and video as a local media stream. Chromium implements tab mirroring and Remote Playback as distinct media routes, and its remoting controller honors the media element’s Remote Playback opt-out. [Chrome extension API catalog](https://developer.chrome.com/docs/extensions/reference/api) · [Tab Capture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) · [Chromium media routes](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/ui/media_router/media_route_starter.cc) · [Chromium remoting opt-out](https://chromium.googlesource.com/chromium/src/+/HEAD/media/remoting/renderer_controller.cc#475)

A direct Google Cast integration would need an HTTP or HTTPS media URL reachable by the receiver and a sender outside the extension’s privileged pages, where Google’s CDN-hosted sender SDK can load. Receiver playback uses separate subtitle tracks with appropriate CORS headers, so it would need dedicated work to reproduce the study overlays and interactions. [Web Sender SDK](https://developers.google.com/cast/docs/web_sender/integrate) · [Web Receiver overview](https://developers.google.com/cast/docs/web_receiver) · [Subtitle track requirements](https://developers.google.com/cast/docs/web_sender/advanced) · [Manifest V3 extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)

## Try direct casting

Run these commands from the project folder:

```sh
npm run cast:setup
npm run cast:serve
```

Leave the companion running. Reload the Anime Study extension, open a downloaded episode, choose **Cast to TV**, and select a Google Cast receiver on the same network. The companion temporarily stages the selected file, then serves it over HTTP to that receiver. The TV begins at the episode's current position and can play any loaded sidecar subtitles as WebVTT. Use the TV remote for playback and **Manage cast → Stop casting** to end the session and release the temporary file. A receiver needs to support the source video's codecs. [PyChromecast](https://github.com/home-assistant-libs/pychromecast) · [Google Cast supported media](https://developers.google.com/cast/docs/media)

If discovery returns no devices on macOS, check the Local Network permission for the app running the companion, such as Terminal. Chrome tab casting remains available under **Mirror this tab instead**. [Apple's Local Network controls](https://support.apple.com/guide/mac-help/control-access-to-your-local-network-on-mac-mchla4f49138/mac)
