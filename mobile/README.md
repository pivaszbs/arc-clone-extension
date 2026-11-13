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
