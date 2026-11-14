// Mirrors tests/japanese-captions.test.mjs from the extension.
// Run: npm run test:core (from mobile/)
#include <cmath>
#include <cstdio>
#include <string>

#include "../cpp/core/AnimeCoreLogic.hpp"

using namespace animecore::logic;

static int failures = 0;
#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);      \
      failures++;                                                      \
    }                                                                  \
  } while (0)

static bool near(double a, double b) { return std::abs(a - b) < 1e-6; }
static bool segment(const std::optional<Segment>& s, double start, double end, const char* source) {
  if (!s) { std::printf("  (missing segment, wanted %g-%g %s)\n", start, end, source); return false; }
  bool ok = near(s->start, start) && near(s->end, end) && s->source == source;
  if (!ok) std::printf("  (got %g-%g %s, wanted %g-%g %s)\n", s->start, s->end, s->source.c_str(), start, end, source);
  return ok;
}

int main() {
  {
    std::string ass = R"([Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,0:00:01.00,0:01:15.00,Default,♬
Dialogue: 0,0:00:40.00,0:00:43.00,Default,日本語です。
Dialogue: 0,0:01:30.00,0:02:15.00,Default,{\pos(172,497)}♬～
Dialogue: 0,0:02:15.00,0:03:00.00,Default,{\pos(172,497)}♬～
Dialogue: 0,0:22:00.00,0:22:45.00,Default,♬
Dialogue: 0,0:22:46.00,0:23:30.00,Default,♬)";
    auto result = detectOpEd(ass, parseSubtitles(ass), 1440, {});
    CHECK(segment(result.op, 90, 180, "subtitle-music"));
    CHECK(segment(result.ed, 1320, 1410, "subtitle-music"));
  }
  {
    auto vtt = parseSubtitles("WEBVTT\n\n00:01.000 --> 00:03.000\nそれは何ですか。");
    CHECK(vtt.size() == 1 && near(vtt[0].start, 1) && vtt[0].text == "それは何ですか。");
    auto ass = parseSubtitles("[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,{\\an8}日本語,です。");
    CHECK(ass.size() == 1 && near(ass[0].start, 1) && near(ass[0].end, 3.5) && ass[0].text == "日本語,です。");
    auto srt = parseSubtitles("\xEF\xBB\xBF" "1\r\n00:00:01,500 --> 00:00:02,000\r\n<i>やあ</i>\r\n\r\n2\r\n01:00:00,000 --> 01:00:01,000\r\n二行\r\n目\r\n");
    CHECK(srt.size() == 2 && near(srt[0].start, 1.5) && srt[0].text == "やあ" && near(srt[1].start, 3600) && srt[1].text == "二行\n目");
  }
  {
    std::string vtt = "WEBVTT\n\n00:45.000 --> 02:15.000\n【オープニング】\n\n22:15.000 --> 23:45.000\n（音楽）";
    auto result = detectOpEd(vtt, parseSubtitles(vtt), 1440, {});
    CHECK(segment(result.op, 45, 135, "subtitle-label"));
    CHECK(segment(result.ed, 1335, 1425, "subtitle-music"));
  }
  {
    const char* lyrics[] = {"夕焼けの向こうへ歩いてゆこう", "長い長い道を渡ってゆこう", "遠く光る星を探しにゆこう",
                            "止まらない風の声を聞こう", "もう一度君とこの空を見よう", "何度でも明日を迎えにゆこう"};
    auto theme = [&](double start, const std::string& prefix) {
      std::vector<Cue> cues;
      for (int i = 0; i < 6; i++) cues.push_back({start + i * 15, start + i * 15 + 4, prefix + lyrics[i]});
      return cues;
    };
    auto episode = theme(45, ""), endingA = theme(1320, "また会える日まで");
    episode.insert(episode.end(), endingA.begin(), endingA.end());
    auto reference = theme(90, ""), endingB = theme(1332, "また会える日まで");
    reference.insert(reference.end(), endingB.begin(), endingB.end());
    auto result = detectOpEd("", episode, 1440, {reference});
    CHECK(segment(result.op, 45, 124, "repeated-subtitles"));
    CHECK(segment(result.ed, 1320, 1399, "repeated-subtitles"));
  }
  {
    std::vector<Cue> cues = {{5, 120, "場面の説明"}, {15, 17, "本当ですか"}};
    for (int i = 0; i < 15; i++) cues.push_back({106.0 + i * 3, 108.0 + i * 3, "そうです"});
    CHECK(!detectOpEd("", cues, 1440, {}).op);
  }
  {
    CHECK(!isJapanese({{1, 2, "What is that?"}}));
    CHECK(!isJapanese({{1, 2, "這是什麼"}}));
    CHECK(isJapanese({{1, 2, "それは何ですか。"}}));
  }
  {
    auto t = folderTitle("Смотреть аниме Фрирен онлайн - 28765 - AniLibria");
    CHECK(t.title == "Фрирен" && t.credit == "AniLibria");
    t = folderTitle("Смотреть аниме Sousou no Frieren онлайн - 28765");
    CHECK(t.title == "Sousou no Frieren" && t.credit.empty());
    t = folderTitle("Frieren - NDA Studio Дубляж");
    CHECK(t.title == "Frieren" && t.credit == "NDA Studio Дубляж");
    CHECK(episodeLabel("Episode 002 - 6061922.mp4") == "Episode 2");
    CHECK(episodeLabel("Show/Episode 010.mp4") == "Episode 10");
    CHECK(episodeLabel("Bonus clip.mp4") == "Bonus clip");
  }
  {
    auto pairs = pairEpisodes({"S/Episode 10 - 2.mp4", "S/Episode 2 - 1.ass", "S/Episode 2 - 1.mp4", "S/notes.txt", "S/Episode 10 - 2.srt"});
    CHECK(pairs.size() == 2 && pairs[0].video == "S/Episode 2 - 1.mp4" && pairs[0].subtitle == "S/Episode 2 - 1.ass" &&
          pairs[1].subtitle == "S/Episode 10 - 2.srt" && pairs[1].label == "Episode 10");
  }
  {
    Skips frames;
    frames.op = Range{88, 178};
    frames.recap = Range{0, 60};
    OpEd subs;
    subs.op = Segment{90, 180, "subtitle-music"};
    subs.ed = Segment{1320, 1410, "subtitle-music"};
    auto skips = resolveSkipRanges(frames, subs, 0);
    CHECK(skips.op && near(skips.op->start, 88));
    CHECK(skips.ed && near(skips.ed->start, 1320));
    frames.recap = Range{100, 150};
    CHECK(!resolveSkipRanges(frames, subs, 0).op);
    std::vector<Cue> cues = {{1, 3, "a"}, {5, 8, "b"}};
    CHECK(cueIndexAt(cues, 2) == 0 && cueIndexAt(cues, 4) == -1 && cueIndexAt(cues, 7.9) == 1);
  }
  {
    // Match repeated lyrics despite Cyrillic case and full-width ASCII differences.
    std::vector<Cue> episode, reference;
    for (int i = 0; i < 6; i++) {
      episode.push_back({45.0 + i * 15, 49.0 + i * 15, "ПЕСНЯ ЁЖИКА ＡＢＣ " + std::to_string(i)});
      reference.push_back({90.0 + i * 15, 94.0 + i * 15, "песня ёжика abc " + std::to_string(i)});
    }
    CHECK(segment(detectOpEd("", episode, 1440, {reference}).op, 45, 124, "repeated-subtitles"));
    CHECK(parseSubtitles(R"({"events":[]})").empty());
    CHECK(parseSubtitles("<text start=\"1\" dur=\"2\">日本語</text>").empty());
  }
  {
    // Match 12x8 RGB24 frame sequences with an offset OP (90s) and ED (75s).
    auto encodeB64 = [](const std::vector<uint8_t>& bytes) {
      static const char kTab[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      std::string out;
      for (size_t i = 0; i < bytes.size(); i += 3) {
        uint32_t b = static_cast<uint32_t>(bytes[i]) << 16;
        if (i + 1 < bytes.size()) b |= static_cast<uint32_t>(bytes[i + 1]) << 8;
        if (i + 2 < bytes.size()) b |= static_cast<uint32_t>(bytes[i + 2]);
        out.push_back(kTab[(b >> 18) & 63]);
        out.push_back(kTab[(b >> 12) & 63]);
        out.push_back(i + 1 < bytes.size() ? kTab[(b >> 6) & 63] : '=');
        out.push_back(i + 2 < bytes.size() ? kTab[b & 63] : '=');
      }
      return out;
    };
    auto makeFrames = [&](int totalSec, int themeStart, int themeLen, uint8_t bgSeed, uint8_t bgSlope, uint8_t bgPixSlope, uint8_t themeSeed) {
      FrameWindow win;
      std::vector<uint8_t> raw(static_cast<size_t>(totalSec) * 288, 0);
      for (int t = 0; t < totalSec; t++) {
        win.times.push_back(static_cast<double>(t));
        bool inTheme = t >= themeStart && t < themeStart + themeLen;
        int rel = t - themeStart;
        for (size_t p = 0; p < 288; p++) {
          raw[t * 288 + p] = inTheme
                                 ? static_cast<uint8_t>((themeSeed + rel * 37 + p * 7) & 0xFF)
                                 : static_cast<uint8_t>((bgSeed + t * bgSlope + p * bgPixSlope) & 0xFF);
        }
      }
      win.dataBase64 = encodeB64(raw);
      return win;
    };
    VideoFingerprint cur{makeFrames(200, 30, 90, 10, 53, 11, 100), makeFrames(150, 40, 75, 20, 53, 11, 150)};
    VideoFingerprint ref{makeFrames(200, 60, 90, 200, 97, 17, 100), makeFrames(150, 20, 75, 220, 97, 17, 150)};
    auto skips = matchVideoThemes(cur, ref);
    CHECK(skips.op && near(skips.op->start, 29.5) && near(skips.op->end, 119.5));
    CHECK(skips.ed && near(skips.ed->start, 39.5) && near(skips.ed->end, 114.5));
  }
  if (failures) { std::printf("%d check(s) failed\n", failures); return 1; }
  std::printf("all core checks passed\n");
  return 0;
}
