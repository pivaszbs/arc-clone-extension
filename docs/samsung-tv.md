# Anime Study for Samsung TV

The browser preview targets Samsung TVs running Tizen 6.0 or later, generally 2021 models and newer. The Mac companion serves MP4 or M4V episodes while you watch. Both devices need access to the same local network. [Samsung TV engine versions](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)

Run `npm run tv:serve` to share `~/Downloads/Arc Anime` and its immediate series folders. A native client can load `catalog.json` relative to the printed address to list those series. Each episode includes relative URLs for its video and any matching subtitle file, plus saved playback data when available. The browser preview opens the first series by default. Pass a series folder explicitly to preview only that series.

## Try it in the TV browser

From the project folder on your Mac, run:

```sh
npm run tv:serve -- "/path/to/downloaded series folder"
```

Open the printed address in the Samsung TV's Internet browser. Keep the Mac awake and the command running. Use the remote's arrow keys and Select to move around. Back returns to the episode list. The app saves the TV's position locally and advances to the next episode on the same screen.

For the packaged app, open the app and enter the printed address on its first screen. The address changes when you restart the companion. Use **Change library** to enter the new one. Anyone on the local network with this address can open the selected series while the command is running.

### Bring over your Chrome settings

In Chrome's Offline Study open the series and choose **Library → Export TV playback data**. Put the resulting `anime-study-tv.json` beside the episodes, or pass `--metadata "/path/to/anime-study-tv.json"` when starting the companion. This brings over resume positions, skip predictions, auto-skip settings, and the ending action. Reload the TV page after updating the file. Later viewing progress is saved on the TV.

Put Japanese ASS, SSA, SRT, or VTT files beside their matching videos with the same base name. **Learn** makes the current subtitle selectable and lets you choose how often playback pauses for study. Use **Replay line** or **Continue** at a study pause. When the app knows the recap, opening, or ending range, it shows the skip prompt and follows the exported auto-skip setting.

## Install the Tizen app

Run `npm run build:tv` and import `outputs/samsung-tv/AnimeStudy` as a Samsung TV Web project in Tizen Studio. Install the Samsung TV and Certificate extensions, create a Samsung certificate profile for the TV, enable Developer Mode on the TV, and connect it through Device Manager. Choose **Run As → Tizen Web Application**. [Samsung SDK setup](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html) · [Testing on a Samsung TV](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)

## Debug playback

Open **Diagnostics** on the library screen or in the player's bottom controls. It shows the connection result, media error code, playhead, resolution, subtitle count, skip ranges, and recent playback events. Use **Up** to focus the report and **Back** to close it. You can share a photo of the report for troubleshooting.

Start the companion with `npm run tv:serve -- "/path/to/downloaded series folder" --verbose` to log request types and HTTP statuses on your Mac. Open the printed address in Chrome on the Mac to use DevTools against the same player.

For breakpoints and network inspection on the Samsung TV itself, connect it in Tizen Studio and use **Debug As → Tizen Web Application**. Web Inspector opens automatically. [Samsung Web Inspector](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/web-inspector.html)
