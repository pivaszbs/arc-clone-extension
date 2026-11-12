#include "HybridAnimeCore.hpp"

#include "core/AnimeCoreLogic.hpp"

namespace margelo::nitro::animecore {
namespace core = ::animecore::logic;

namespace {

std::vector<core::Cue> toCore(const std::vector<Cue>& cues) {
  std::vector<core::Cue> out;
  out.reserve(cues.size());
  for (const auto& cue : cues) out.push_back({cue.start, cue.end, cue.text});
  return out;
}

std::optional<core::Range> toCore(const std::optional<TimeRange>& range) {
  if (!range) return std::nullopt;
  return core::Range{range->start, range->end};
}

std::optional<core::Segment> toCore(const std::optional<ThemeSegment>& segment) {
  if (!segment) return std::nullopt;
  return core::Segment{segment->start, segment->end, segment->source};
}

std::optional<TimeRange> fromCore(const std::optional<core::Range>& range) {
  if (!range) return std::nullopt;
  return TimeRange(range->start, range->end);
}

std::optional<ThemeSegment> fromCore(const std::optional<core::Segment>& segment) {
  if (!segment) return std::nullopt;
  return ThemeSegment(segment->start, segment->end, segment->source);
}

}  // namespace

std::vector<Cue> HybridAnimeCore::parseSubtitles(const std::string& body) {
  std::vector<Cue> out;
  for (const auto& cue : core::parseSubtitles(body)) out.emplace_back(cue.start, cue.end, cue.text);
  return out;
}

bool HybridAnimeCore::isJapanese(const std::vector<Cue>& cues, bool declaredJapanese) {
  return core::isJapanese(toCore(cues), declaredJapanese);
}

OpEdIntervals HybridAnimeCore::detectOpEd(const std::string& body, const std::vector<Cue>& cues, double duration,
                                          const std::vector<std::vector<Cue>>& references) {
  std::vector<std::vector<core::Cue>> refs;
  refs.reserve(references.size());
  for (const auto& reference : references) refs.push_back(toCore(reference));
  auto found = core::detectOpEd(body, toCore(cues), duration, refs);
  return OpEdIntervals(fromCore(found.op), fromCore(found.ed));
}

SkipRanges HybridAnimeCore::resolveSkipRanges(const SkipRanges& frames, const OpEdIntervals& subtitles,
                                              double subtitleOffset) {
  core::Skips coreFrames{toCore(frames.op), toCore(frames.ed), toCore(frames.recap)};
  core::OpEd coreSubtitles{toCore(subtitles.op), toCore(subtitles.ed)};
  auto skips = core::resolveSkipRanges(coreFrames, coreSubtitles, subtitleOffset);
  return SkipRanges(fromCore(skips.op), fromCore(skips.ed), fromCore(skips.recap));
}

FolderTitle HybridAnimeCore::folderTitle(const std::string& folderName) {
  auto title = core::folderTitle(folderName);
  return FolderTitle(title.title, title.credit);
}

std::string HybridAnimeCore::episodeLabel(const std::string& fileName) { return core::episodeLabel(fileName); }

std::vector<EpisodePair> HybridAnimeCore::pairEpisodes(const std::vector<std::string>& paths) {
  std::vector<EpisodePair> out;
  for (const auto& pair : core::pairEpisodes(paths)) out.emplace_back(pair.video, pair.subtitle, pair.label);
  return out;
}

double HybridAnimeCore::cueIndexAt(const std::vector<Cue>& cues, double time) {
  return core::cueIndexAt(toCore(cues), time);
}

}  // namespace margelo::nitro::animecore
