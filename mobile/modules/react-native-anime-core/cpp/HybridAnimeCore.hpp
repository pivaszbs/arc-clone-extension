#pragma once

#include "HybridAnimeCoreSpec.hpp"

namespace margelo::nitro::animecore {

// Thin JSI-facing adapter. All behaviour lives in core/AnimeCoreLogic.cpp.
class HybridAnimeCore : public HybridAnimeCoreSpec {
 public:
  HybridAnimeCore() : HybridObject(TAG) {}

  std::vector<Cue> parseSubtitles(const std::string& body) override;
  bool isJapanese(const std::vector<Cue>& cues, bool declaredJapanese) override;
  OpEdIntervals detectOpEd(const std::string& body, const std::vector<Cue>& cues, double duration,
                           const std::vector<std::vector<Cue>>& references) override;
  SkipRanges resolveSkipRanges(const SkipRanges& frames, const OpEdIntervals& subtitles, double subtitleOffset) override;
  FolderTitle folderTitle(const std::string& folderName) override;
  std::string episodeLabel(const std::string& fileName) override;
  std::vector<EpisodePair> pairEpisodes(const std::vector<std::string>& paths) override;
  double cueIndexAt(const std::vector<Cue>& cues, double time) override;
  SkipRanges matchVideoThemes(const VideoFingerprint& current, const VideoFingerprint& reference) override;
};

}  // namespace margelo::nitro::animecore
