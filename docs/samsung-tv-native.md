# Anime Study for Samsung S85F

The native C# app targets Tizen 9.0 on the 2025 S85F (QE55S85FAUXXU). It uses Samsung's NUI interface and native video player. The Mac companion serves downloaded episodes to the TV over the local network. [S85F model groups](https://developer.samsung.com/smarttv/develop/specifications/tv-model-groups.html) · [Samsung's media APIs](https://developer.samsung.com/smarttv/develop/tizen-net-tv/guides/multimedia.html)

## Build and install

Run `python3 scripts/build-native-tv.py` with the .NET 8 SDK on your path. It builds for the TV's .NET 6 runtime and writes the unsigned package to `outputs/samsung-tv-native/AnimeStudy-0.1.0-unsigned.tpk`.

A physical Samsung TV requires Developer Mode and a Samsung certificate profile that includes that TV's DUID. Connect the TV in Tizen Studio Device Manager and create the certificate in Certificate Manager. Use the active profile to sign the native project package. The project also supports MSBuild packaging with `TizenCreateTpkOnBuild=true` and the signing profile's certificate inputs. [Samsung's device setup](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html) · [Samsung's certificates guide](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html) · [Tizen packaging options](https://github.com/Samsung/build-task-tizen/blob/master/doc/tizen.net.sdk-reference.md)

## Watch

Run `python3 -m native.tv.serve` from the project folder on your Mac. The server opens `~/Downloads/Arc Anime` by default. Enter the printed address in the TV app. Pick a series and an episode with the remote. Keep the Mac awake and the companion running while watching.

The app displays matching Japanese ASS, SSA, SRT, or VTT sidecars. It saves progress on the TV and advances when an episode finishes. Put Chrome's exported `anime-study-tv.json` beside the episodes to bring over skip predictions and initial progress. During playback, **Up** skips a suggested segment or pauses on the current subtitle. **Down** dismisses a skip suggestion or cycles how often to pause on subtitles. In a study pause, **Up** replays the line and **OK** continues.

The native project has compiled and its catalog, HTTP range requests, and Japanese subtitle parsing have been checked on the Mac. Installation, video rendering, and remote input still need testing on the TV.
