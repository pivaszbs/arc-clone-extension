# Arc for Chrome (Svelte 5 + TypeScript + Manifest V3)

An Arc Browser experience inside Google Chrome built with **Svelte 5**, **TypeScript**, **Vite**, and native Chrome Extension APIs (`chrome.sidePanel`, `chrome.tabs`, `chrome.windows`, `chrome.bookmarks`, `chrome.history`, `chrome.storage`, `chrome.commands`, `chrome.contextMenus`).

## Current behavior and limits

Favorites are shared across Spaces. Pinned pages, including pages inside folders, stay separate from Today. Opening a pinned page reuses its tab in the selected Space. Switching Spaces restores the most recently used tab in that Space within the current window, when one exists. Repeated pinning keeps one saved item; dropping it into a folder moves it.

The sidebar and command bar use the same Clear rules. Clear closes inactive Today tabs and preserves Favorites, pinned pages, native Chrome pinned tabs, and active tabs. Clear now saves recoverable HTTP(S) tabs in the local archive. The minute-based background alarm implements auto archive and protects active, audible, native-pinned, and saved tabs. Chrome tab-group sync remains a stored preference without a background implementation.

Pinned pages track the opened tab as well as the saved URL, so navigation keeps the tab out of Today. Reset Space returns linked open pins to their saved URLs. Pin bindings are local to the browser session. Chrome owns its toolbar, tab strip, and reserved shortcuts. An extension cannot guarantee an exact match to Arc's native browser frame. Peek also depends on whether the destination allows iframe embedding.

Run `npm test` for tab behavior regression tests, `npm run check` for Svelte and TypeScript checks, and `npm run build` to build Arc for Chrome in `dist-arc/` and Anime Study in `dist/`.

The sidebar, new-tab page, and webpage overlay share one command palette. It supports keyboard navigation, immediate input focus, loading and retry feedback, and ignores stale searches. Space dialogs keep keyboard focus inside and return it when dismissed. Row controls work with Enter and Space, and animations respect reduced-motion preferences.

For local UI checks without touching real tabs, run `npx vite --host 127.0.0.1` and open `/preview.html`, `/preview.html?surface=newtab&focused=1`, or `/preview.html?surface=overlay`. These previews run the real background dispatcher against sample, in-memory Chrome APIs. Translation output is a fixed sample. Searching for `offline` simulates a search failure. The preview entry is excluded from the extension build.

## Arc comparison and Cucumber tests

See [the functionality inventory and alternatives](docs/arc-parity.md) for Arcify, the Rust/Tauri Bushido browser, implementation coverage, and remaining gaps.

`npm run test:e2e` builds and runs the same Cucumber workflows in Chrome for Testing and installed Google Chrome, using isolated profiles and the real unpacked extension. Reports, screenshots, and the browser comparison are in `artifacts/e2e/`. These runs do not prove native Arc parity. Native Arc could be inspected visually but did not connect to Playwright's launch interface.

New sidebar controls provide archived-tab search/restore, pinned-item renaming, auto-archive settings, pinned URL reset, and native Split View where the browser supports its extension API.

## Routes, Site Search and Boosts

Open **Settings → Routes, Site Search and Boosts** in the sidebar.

- **Routes** (Arc's Air Traffic Control): give a site such as `github.com` or `google.com/maps` a Space. A link to it opened from a page or another app lands in that Space, and the sidebar switches there when the tab opens in front. Tabs you open from the sidebar or command bar stay where you opened them.
- **Site Search**: in the command bar type a shortcut, a space, and a query. `yt lofi` searches YouTube. YouTube, Wikipedia, GitHub, Reddit and DuckDuckGo are set up; add your own with a URL containing `%s`.
- **Boosts**: your own CSS for a site, applied each time it loads, subdomains included. Editing, turning off or removing a Boost updates open tabs at once.

## Video picture in picture

Standard HTML videos have a browser **Picture in picture** button. On macOS they also have an **Across desktops** button, which uses the local desktop companion to remain above other applications' full-screen Spaces.

Build and register the macOS player once:

```sh
npm run install:desktop-pip
npm run build
```

Reload the extension in Chrome, approve its local native-messaging permission if Chrome requests it, then refresh the video page. Choose **Across desktops** at the video's top right. **Return to page** closes the desktop window and restores the original player. The desktop window's play/pause button controls the source video.

The installer registers both unpacked extension IDs in the `local.arcclone.desktop_video.json` file in your user-level Chrome NativeMessagingHosts folder. Other hosts are preserved. If the loaded extension has a different ID, pass it explicitly to `node scripts/install-desktop-pip.mjs EXTENSION_ID`. The companion executable remains under `outputs/desktop-pip/Arc Desktop Video.app/` in this workspace. It starts on request and exits when the connection closes.

The desktop player receives a capture of the selected video through local native messaging. It does not reopen the media URL, forward cookies, run an HTTP server, or capture the screen or microphone. It can therefore handle a same-origin blob source without transferring that blob URL to another browser. Captured audio follows the original mute and volume settings, while the page is muted to prevent duplicate audio. Closing the panel restores the page state. There is a short encoding/buffering delay.

Videos added dynamically and videos inside allowed iframes receive controls. Videos must be at least 180 by 90 CSS pixels and visible. Site PiP opt-outs are respected. Protected/DRM video is rejected; cross-origin restrictions can also prevent video capture. The custom buttons are hidden while the original page itself is fullscreen. Closed shadow roots and browser-internal pages are outside this implementation. Capture ending or a source change closes the desktop session; reopen it for a replacement stream.

`npm run test:e2e` runs the original browser PiP scenarios plus real macOS companion tests for window configuration, live playback, blob sources, captured audio, volume, and returning to the page. Companion tests run only on macOS and register hosts inside their disposable browser profiles. No everyday browser profile is copied.

The additional OS check uses `node scripts/inspect-desktop-pip.mjs`, or `PIP_BROWSER=chrome node scripts/inspect-desktop-pip.mjs`. Switch Spaces through the UI, then type a label in its terminal. It records the companion's own `NSPanel.isOnActiveSpace`, visibility, playback, and source-stream state. Type `close` to clean up. Full-screen Finder and ordinary desktop transitions were checked with this method. See [the OS verification record](docs/pip-macos-spaces.md).

The browser option continues to use the [standard video PiP API](https://developer.chrome.com/blog/watch-video-using-picture-in-picture). Neither option automatically starts when changing tabs.

## Japanese learning

The standalone iPad Safari extension is built with `npm run build:safari`. It generates the web extension, a containing SwiftUI iPad app, and an Xcode project under `outputs/safari/JapaneseListening/`, plus ZIP packages. It has no Userscripts or Arc dependency. See `safari/INSTALL.md` for signing and personal-device installation. Full Xcode is required to compile and install the iPad app; the web bundle and generated project alone are not an installable app.

For an iPad Safari build, run `npm run build:ipad`. The self-contained Userscripts file is written to `outputs/ipad/arc-japanese.user.js`; follow `outputs/ipad/SETUP.md`. This reuses the same player controls and quiz engine with a Userscripts storage / translation adapter. It does not require Xcode or an Apple developer subscription. Device compatibility still needs testing on an iPad.

On YouTube and smotret-anime.com / smotret-anime.net, click **日本語 Learn** at the bottom right. For embedded anime players, use the button inside the player frame. Open a video with Japanese audio and enable Japanese captions when available.

On an Anime365 Japanese-subtitled episode in Chrome, the study player uses the episode's ASS download and follows the embedded video's clock. **Earlier** and **Later** shift the study subtitles by half a second. **Return to page player** restores the site's video controls and keeps the playback position.

Use **Offline** beside the episode player to find the video and subtitle downloads. The **Anime Study** toolbar icon opens the offline library. Saved phrases and local playback are available offline. Translation of a new phrase requires a connection.

For a whole series, select **Download series** beside the player or paste an Anime365 link in **Offline study**. Check the episode list, then start the queue. Chrome downloads one file at a time into `Downloads/Arc Anime`. You can pause the queue or retry failed files. Episodes without a downloadable video and Japanese subtitle pair are listed as unavailable. To watch, choose **Open a downloaded series folder** and select the series folder. Matching subtitle files load when you choose an episode.

- Replay the last five seconds, loop the captured section, or slow playback to 0.85× / 0.7×. Closing the panel stops its loop and restores the previous speed.
- Capture a Japanese caption, select Japanese page text and capture it, or paste a phrase. Add its meaning yourself or click **Translate to English**. Only that explicit translation action sends the phrase to Arc's existing Google Translate service.
- Save a phrase with its source and time, or let a listening quiz save it automatically. **Review** asks you to choose its translation and grades the selected answer automatically. Incorrect answers return in ten minutes; correct answers return after one day, then two, four, and up to thirty days. You do not mark phrases or vocabulary as known yourself.
- Saved cards stay in this Chrome profile's local extension storage, separate from Arc settings. **Export** downloads a JSON backup. Importing backups is not implemented yet.

Japanese subtitle discovery runs automatically. It reads native player tracks, including disabled Japanese tracks in hidden mode, YouTube caption-track metadata, matching player track URLs, and subtitle requests observed after attachment. Responses in VTT, SRT, ASS, TTML, and YouTube XML / JSON3 are parsed into timed lines. It falls back to visible Japanese captions when needed. File loading is an optional override, not a required setup step. YouTube's visible captions do not expose exact line timings, so replay uses the preceding five seconds. Japanese SRT / VTT files can be loaded for accurate line timings; the file must match the video, and it stays in memory until navigation or reload. Burned-in text recognition, audio transcription, external subtitle-catalog matching, and automatic grammar explanations are not implemented. Players that supply no accessible Japanese text cannot be made quiz-ready by request discovery alone. Some embedded players or signed caption URLs may not allow retrieval; physical iPad / authenticated-site checks remain necessary. Controls cannot appear over a player that puts the raw video element into native fullscreen.

### Learn: words from the episode you are watching

**Learn** is built for complete beginners. It teaches single words, in the lines where the episode actually uses them.

- Turning Learn on lists the **words in play**: the most frequent everyday words in this episode's Japanese subtitles that you have not met, plus any you are still learning from earlier episodes. Each has its reading and meaning; **▶** plays the first line that uses it. **I know it** drops a word and brings in the next one.
- While you watch, playback pauses at the end of a line that contains a word in play. The first time, the word is shown with its meaning. The next times it is asked: pick the meaning from four choices, with the line still on screen and **Replay** available. Word stops are at least 20 seconds of video apart.
- Every paused line is split into words with a reading under each. Tap any word for its dictionary form and meaning, then **Learn this word** or **I know it**. Verb and adjective endings are folded back, so 見ました opens 見る.
- **Readings** switches between romaji and kana. Start with romaji; move to kana when you can read it.
- A missed word returns after a minute, a first correct answer after ten minutes, and a second moves it to day-based reviews (1, 2, 4 … up to 60 days). Due words are asked in the episode when they come up, and under **Review** when they do not. The word list shows how much of the episode's vocabulary you already know.
- **Words in play** sets how many new or unlearned words Learn works on at once (3, 5, 8, or off). **Other lines** keeps the earlier behaviour of pausing on a share of all lines to study them.

The same flow runs on YouTube videos with Japanese captions. Word picking needs timed captions; with visible-only YouTube captions, Learn teaches words as they come up instead of by frequency. Names and words outside the dictionary are left as plain text. Splitting is dictionary-based and can mis-split unusual kana runs. Word progress is stored locally beside the saved phrases. The Samsung TV app does not have the word flow yet.

Words are shown split into kanji groups, each with its own reading underneath (泥 doro · 棒 bou, 食 ta · べる beru). The splits come from [JmdictFurigana](https://github.com/Doublevil/JmdictFurigana) (CC BY-SA 4.0); words without one show a single reading under the kanji.

Word data comes from [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) (Electronic Dictionary Research and Development Group, CC BY-SA 4.0) through [jmdict-simplified](https://github.com/scriptin/jmdict-simplified). `src/japanese/dictionary-data.json` holds the 22,661 common entries; regenerate it with `node scripts/build-dictionary.mjs path/to/jmdict-eng-common-*.json path/to/JmdictFurigana.json`.

### Beginner anime

The **Beginner anime** tab in the offline library lists the 40 easiest series on smotret-anime that have Japanese subtitles, easiest first. `scripts/rank-beginner-anime.mjs` measures every series with Japanese subtitles on six or more episodes, using the subtitles of its first three episodes: words a minute while someone is talking, how many different words cover 90% of the dialogue, the share of everyday anime vocabulary, and how much text the dictionary cannot read. Openings and endings are left out. Chinese shows with Japanese subtitles and adult genres are excluded. Each entry shows how many of its 50 most frequent words you already know, links to episode 1 with Japanese subtitles, and **Download series** opens the series check in Downloads. Re-rank with `node scripts/rank-beginner-anime.mjs [cache-directory]`; it downloads about 800 subtitle files, one at a time.

### Pausing on other lines

Enable **Pause for listening quizzes** to pause after eligible Japanese lines and choose the translation from four options. Phrases already in your review history are tested when due. Other lines are eligible when the browser's Japanese word segmentation estimates zero to two unfamiliar words; words from successful quiz answers form the vocabulary estimate. Initially, short lines help build that history. This estimate does not perform dictionary lemmatization or measure mastery of every word in a sentence.

Unfamiliar lines are sampled at 25% by default, adjustable to 10%, 50%, or every eligible line, with at least 30 seconds of video between sampled unfamiliar-line questions. Native / imported subtitle timings pause at the line end; visible YouTube captions pause when the line changes or clears. Seeking skips pending questions. Quiz mode sends selected subtitle lines to Arc's Google Translate service when no saved meaning exists; answers and results remain local. Failed translation requests can be retried or skipped without a learning penalty. Closing the panel disables quizzes for that frame. The first version uses translation choices, not AI grading of typed answers.

Reload **Anime Study** in Chrome's extensions page, then refresh the video page.

For a local UI preview, run `npx vite --host 127.0.0.1` and open `/preview.html?surface=japanese` on the displayed local address. The preview uses temporary mock storage and does not affect your real saved phrases.

## ✨ Features

1. **Vertical Arc Sidebar (`chrome.sidePanel`)**
   - **Spaces** (`Personal`, `Work`, `Research`, plus custom Spaces) with Arc-inspired gradient themes (`Cosmic Indigo`, `Solar Sunset`, `Forest Canopy`, `Pacific Tide`, `Warm Terracotta`, `Obsidian Dark`).
   - **Favorites Grid**: Persistent top squircle icon tiles across all Spaces.
   - **Pinned Tabs & Nested Folders**: Organize pinned pages and collapsible folders per Space.
   - **Today's Tabs & Auto-Clear**: Real-time open tabs list per Space with audio mute/unmute toggle, Space mover (`⇄`), and one-click `Clear` to archive/close unpinned tabs.
   - **Top URL & Quick Copy Bar**: Click to launch the Command Bar, copy the active URL with one click (`🔗`), or pop the current tab into a **Little Arc** window (`❐`).

2. **Arc Command Bar (`Cmd+K` / `Ctrl+K` or `Alt+Space`)**
   - Works both as an in-page floating glassmorphic modal on any website (isolated inside a Shadow DOM) and inside the Side Panel.
   - Instant search across **Open Tabs**, **Favorites**, **Pinned Items**, **Chrome Bookmarks**, **Browsing History**, **Arc Quick Actions**, or direct URL / Google Search.
   - Press `Enter` to open/switch, or `Shift+Enter` to preview in **Arc Peek**.

3. **Arc Peek & Little Arc (`Shift+Click` or `Alt+Click` on links)**
   - Hold `Shift` (configurable to `Alt/Option` in Settings) and click any link on a webpage or in the sidebar to open an **Arc Peek** preview modal right over the current page.
   - Includes one-click buttons to expand to a full tab (`↗ Open Full Tab`) or pop out into a standalone borderless Chrome popup window (`❐ Little Arc Window`) for sites that block iframes.
   - Also accessible via right-click context menu: **"Open in Arc Peek / Little Arc"**.

4. **Highlight-to-Translate (`🌐 Translate`)**
   - Highlight any text on any webpage to reveal a floating **Arc Translate** pill (or set to **Instant Auto-Translate** in Settings, or press `Alt+T`).
   - Auto-detects the source language and translates into your chosen target language (16 languages supported, changeable on the fly).
   - Includes **Text-to-Speech (`🔊 Listen`)** and one-click **Copy (`📋 Copy`)**.
   - Also includes a standalone **Arc Quick Translator** drawer (`🌐`) in the bottom dock of the Sidebar.

---

## Load the extensions in Google Chrome

Run `npm install` and `npm run build`, then open `chrome://extensions` and enable **Developer mode**.

1. If you already use the combined extension, **reload its existing entry first**. The entry loaded from `dist/` becomes **Anime Study** and keeps your offline library and saved phrases. For a new install, use **Load unpacked** and select `dist/`.
2. Use **Load unpacked** to select `dist-arc/` for **Arc for Chrome**. On its first load, Arc copies saved Spaces, pins, Favorites, and settings from the existing installation in `dist/` in the same Chrome profile.
3. Refresh open website tabs. The **Anime Study** toolbar button opens the offline library. The **Arc for Chrome** toolbar button opens its sidebar.

Either extension can run independently. On macOS, run `npm run install:desktop-pip` to register both unpacked extensions with the desktop companion.

## Anime Study across Mac, phone, Chrome and TV

Run `npm run mac:up` on the Mac. It starts the library server and the OP/ED worker. The URL token comes from `ANIME_STUDY_TOKEN` or `~/Library/Application Support/AnimeStudy/token`, and it is never stored in the repo. The server answers on the home network and, when Tailscale is running, on the Mac's Tailscale name. Only this Mac, private networks and Tailscale devices (100.64.0.0/10) are accepted. `catalog.json` lists every address. The phone remembers them and switches automatically when one stops answering. The TV uses the home network address because Tizen cannot run Tailscale.

Progress, skip timings and auto-skip choices sync master-master through `shared/sync/replica-core.ts`, mirroring `native/tv/replica.py`. The phone keeps that state in a file and Chrome keeps it in `localStorage`. Changes are saved locally first and sent when the Mac answers. The newest change wins. On the phone or iPad, a series from the Mac has Download buttons (per episode, or all at once) that copy episodes to the device over the home network, so they play from Local Files without the Mac. Its Download tab sends an Anime365 series to the Mac, where Chrome downloads it into the library.

### Movies & TV on the Samsung TV (Stremio + Torrentio)

The TV app's **Movies & TV** button plays films and series that aren't anime, using Stremio's open add-on protocol. The Mac server (`native/tv/stremio.py`) relays all of it, so the TV never contacts these services directly and the token and private-network checks still apply:

- **Cinemeta**, Stremio's catalog, provides search, popular titles, posters and episode lists.
- **Torrentio** lists torrents for the chosen movie or episode. 1080p comes first, then 720p, then 4K, each sorted by seeders. Formats a Samsung TV usually can't play (DTS, TrueHD, AV1, Dolby Vision without HDR10, cam rips) are listed last and marked *may not play on TV*.
- The **Stremio app's streaming server** on the Mac (`127.0.0.1:11470`) downloads the torrent and streams it. The Mac server forwards the video, with seeking, at `stremio/play/<hash>/<file>`.

Set up: install and open the [Stremio desktop app](https://www.stremio.com/downloads) on the Mac and leave it running (it starts the streaming server), then run `npm run mac:up` as usual. To use your own Torrentio settings (providers, quality filter, a debrid service), set `ANIME_STUDY_TORRENTIO` to the configured address from torrentio.strem.fun/configure, without `/manifest.json`.

On the TV, Movies & TV starts with popular titles. **Movies / Series** switches the type. Type a name and choose **Search**. Series open to seasons, then episodes, then the list of streams. A torrent can take up to a minute to start. If a stream fails, go back and pick another; 1080p x264 files start fastest. Resume positions are kept on the TV only; Learn, subtitles, auto-skip and Next episode aren't available for these streams yet. Torrents download from, and upload to, other peers from the Mac's internet connection, so only play what you're allowed to.

### The phone's TV tab: pick a movie on the phone, watch it on the TV

The phone and iPad app has a **TV** tab. **Movies & TV** opens first: search or browse popular titles, open a series' seasons and episodes, then tap a stream. The Mac (`tv/play`) plays it on the TV. When the TV is off or in standby, or Anime Study isn't open, the Mac turns the TV on, opens Anime Study and hands the stream over as soon as the app connects. From standby that takes about 10 seconds.

**Remote** controls the TV itself, through the Mac and Samsung's remote API (`native/tv/samsung_remote.py`):
- Power and **Open Anime Study**.
- A d-pad with OK, Back, Home, Menu and Source.
- Volume and mute, plus play/pause.
- **Type on the TV**, which fills the TV's focused field or runs a Movies & TV search.

While Anime Study is open, the d-pad and typing go to the app; otherwise they go to the TV set's own keys. What's playing shows with its usual controls.

The Mac learns the TV's address from the Anime Study TV app's connection, so nothing needs configuring (or set `ANIME_STUDY_SAMSUNG_TV`). The first control asks for **Allow** on the TV; the token is kept in `~/Library/Application Support/AnimeStudy/samsung-tv.json`. Waking the TV from fully off uses Wake-on-LAN, which a Wi-Fi Samsung TV only answers with **Settings → All Settings → Connection → Expert Settings → Power On with Mobile** turned on.

### Movies & TV like the anime library: progress, Continue watching, seasons, offline

- **Progress and Continue watching.** The TV reports how far each movie or episode got to the Mac (`stremio/progress`, kept by `native/tv/movie_history.py`). Resume uses the newest position, even after a reinstall. **Continue watching** heads Movies & TV on the phone and the TV, one entry per show. A finished episode continues with the next one.
- **Next episode.** At the end of an episode, the next one starts by itself when autoplay is on. **Next episode** and the phone remote's ⏭ do the same. The Mac picks the stream from the same release group (Torrentio's `bingeGroup`), so quality and language stay the same.
- **Saved for offline.** On the phone, ↓ beside a stream, or **Save Season N for offline** on a season, puts it in the Mac library (`native/tv/movie_library.py`). The Mac downloads it through Stremio and converts it to MP4 with ffmpeg: H.264/HEVC video is copied, audio is made AAC when needed, and an English text subtitle is kept as `.srt`. Files land in `<library>/<Title> (<year>)/` or `<library>/<Show> - Season N/`, with `poster.jpg` and `movies-tv.json`. The library then treats them like downloaded anime: shows group their seasons (`franchise: imdb:<id>`), progress syncs across devices, and the phone's **Download** copies them to the device for watching without a connection. **Saving to the Mac library** on the phone shows the queue, one file at a time, with Cancel and Retry. It survives a Mac restart and resumes partial downloads. Saving needs ffmpeg (`brew install ffmpeg`) and the Stremio app running.
