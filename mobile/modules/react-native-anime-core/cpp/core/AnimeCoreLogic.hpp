// Shared Anime Study logic, ported from the extension's TypeScript
// (src/japanese/study.ts, captions.ts, video-themes.ts, OfflineStudy.svelte).
// Plain C++20 with no React Native dependency, so it can be unit tested with clang++
// and reused from iOS and Android through the Nitro hybrid object.
#pragma once

#include <optional>
#include <string>
#include <vector>

namespace animecore::logic {

struct Cue {
  double start = 0;
  double end = 0;
  std::string text;
};

struct Range {
  double start = 0;
  double end = 0;
};

// source: ass-style | subtitle-label | subtitle-music | repeated-subtitles | dialogue-gap
struct Segment {
  double start = 0;
  double end = 0;
  std::string source;
};

struct OpEd {
  std::optional<Segment> op;
  std::optional<Segment> ed;
};

struct Skips {
  std::optional<Range> op;
  std::optional<Range> ed;
  std::optional<Range> recap;
};

struct FolderTitle {
  std::string title;
  std::string credit;
};

struct EpisodePair {
  std::string video;
  std::optional<std::string> subtitle;
  std::string label;
};

// SRT / WebVTT, then ASS / SSA. Cues are sorted by start time.
std::vector<Cue> parseSubtitles(const std::string& body);

// At least 30% of cues contain kana (or any CJK when the track says it is Japanese).
bool isJapanese(const std::vector<Cue>& cues, bool declaredJapanese = false);

// Opening and ending ranges from subtitle labels, music cues, lines repeated in other
// episodes, or a single long dialogue gap.
OpEd detectOpEd(const std::string& rawBody, const std::vector<Cue>& cues, double videoDuration,
                const std::vector<std::vector<Cue>>& references);

// Combine saved frame predictions with subtitle detection the way the web player does.
Skips resolveSkipRanges(const Skips& frames, const OpEd& subtitles, double subtitleOffset);

bool overlapsRecap(const std::optional<Range>& opening, const std::optional<Range>& recap);

// "Смотреть аниме <title> онлайн - <id> - <translation team>" -> title + team.
FolderTitle folderTitle(const std::string& folderName);

// "Episode 002 - 6061922.mp4" -> "Episode 2".
std::string episodeLabel(const std::string& fileName);

// Pairs videos with subtitles that share their path stem, sorted in natural order.
std::vector<EpisodePair> pairEpisodes(const std::vector<std::string>& paths);

// Index of the cue showing at `time`, or -1.
int cueIndexAt(const std::vector<Cue>& cues, double time);

}  // namespace animecore::logic
