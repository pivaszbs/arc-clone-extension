# Anime Study for iPhone and iPad

Expo (SDK 58) app version of the extension's Offline Study page. The shared logic lives in C++ in
`modules/react-native-anime-core` and reaches JS through a Nitro hybrid object (JSI): subtitle parsing,
opening/ending detection, combining skip ranges, folder titles and episode pairing.

## Run
Needs Xcode (not just Command Line Tools), because this is a dev build rather than Expo Go.

    npm install
    npm run test:core      # C++ core tests (clang++)
    npm run typecheck
    npx expo run:ios       # iPhone simulator
    npm run ios:ipad       # iPad simulator

## Episodes
Copy a downloads folder ("Смотреть аниме <title> онлайн - <id> - <team>") into Files › On My iPhone › Anime Study,
or use the + button. Videos (.mp4/.m4v/.mov) pair with .ass/.srt/.vtt files that have the same name.
Saved frame predictions are read from `video-themes.json` ({ "<file>": { op, ed, recap } }) or `<episode>.themes.json`.

## Transfer browser predictions

In the extension's Offline Study page, select a series, run frame checking, then choose
**Export saved skip predictions** in Library. Save the downloaded `video-themes.json`
beside that series' videos and copy/import the folder into Anime Study. For loose-file
imports, select the JSON file along with the videos. Export includes saved predictions
available at the time of the click; export again after scanning finishes for later results.
The browser chooses the download directory, so move the file beside the videos if needed.

The JSON maps exact filenames, including extensions, to ranges in seconds:

```json
{
  "Episode 1.mp4": {
    "op": { "start": 60, "end": 150 },
    "ed": { "start": 1320, "end": 1410 },
    "recap": { "start": 0, "end": 40 }
  }
}
```

A single `Episode 1.themes.json` can instead contain just the inner range object.
That file takes precedence over the series JSON. Invalid or negative ranges are ignored.
Export omits empty entries and openings overlapping recaps. It does not export subtitle-derived
ranges, progress, media, or other series. No server or paid service is involved.

## Native parity and validation limits

The C++ parser supports SRT, VTT, and ASS. YouTube JSON3, XML, and TTML from the browser's
network-caption reader are not implemented in C++; local subtitle pairing currently uses
ASS/SSA/SRT/VTT. Do not treat network-caption parity as complete. Use a supported subtitle
format for local playback. A future parser should use maintained JSON/XML libraries rather
than adding hand-written parsers, with malformed-input and timing fixtures from the browser suite.

Repeated-lyric matching normalizes full-width ASCII and lowercases ASCII and Cyrillic.
It still approximates Unicode letter/number classification and lacks full NFKC normalization,
including half-width kana and combining-mark composition. ICU is an existing implementation
worth evaluating when native builds are available; no native dependency was added here.

Simulator execution requires a complete Xcode installation and installed iOS simulator runtimes.
Command Line Tools alone can run `npm run test:core`, but cannot build this app. Playback,
Files import, haptics, rotation, and Nitro linking still require simulator/device verification.
Only `.mp4`, `.m4v`, and `.mov` are supported video candidates; codec compatibility depends on iOS.
