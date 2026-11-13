#include "AnimeCoreLogic.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <limits>
#include <map>
#include <set>
#include <unordered_map>

namespace animecore::logic {
namespace {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

// ---------- UTF-8 helpers ----------

std::u32string decode(const std::string& in) {
  std::u32string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size();) {
    unsigned char c = static_cast<unsigned char>(in[i]);
    char32_t cp;
    int extra;
    if (c < 0x80) { cp = c; extra = 0; }
    else if ((c >> 5) == 0x6) { cp = c & 0x1F; extra = 1; }
    else if ((c >> 4) == 0xE) { cp = c & 0x0F; extra = 2; }
    else if ((c >> 3) == 0x1E) { cp = c & 0x07; extra = 3; }
    else { out.push_back(0xFFFD); i++; continue; }
    bool ok = true;
    for (int k = 1; k <= extra; k++) {
      if (i + k >= in.size() || (static_cast<unsigned char>(in[i + k]) >> 6) != 0x2) { ok = false; break; }
      cp = (cp << 6) | (static_cast<unsigned char>(in[i + k]) & 0x3F);
    }
    if (!ok) { out.push_back(0xFFFD); i++; continue; }
    out.push_back(cp);
    i += extra + 1;
  }
  return out;
}

std::string encode(const std::u32string& in) {
  std::string out;
  out.reserve(in.size());
  for (char32_t cp : in) {
    if (cp < 0x80) out.push_back(static_cast<char>(cp));
    else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }
  return out;
}

// JavaScript's String.prototype.trim / \s set.
bool isSpace(char32_t c) {
  return c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D || c == 0x20 || c == 0xA0 ||
         c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F ||
         c == 0x205F || c == 0x3000 || c == 0xFEFF;
}

std::u32string trim32(const std::u32string& s) {
  size_t a = 0, b = s.size();
  while (a < b && isSpace(s[a])) a++;
  while (b > a && isSpace(s[b - 1])) b--;
  return s.substr(a, b - a);
}

std::string trim(const std::string& s) { return encode(trim32(decode(s))); }

bool isAsciiSpace(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }

std::string asciiLower(std::string s) {
  for (char& c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return s;
}

// Lower-cases ASCII and Cyrillic, enough for the folder-name rules.
std::u32string lower32(std::u32string s) {
  for (char32_t& c : s) {
    if (c >= 'A' && c <= 'Z') c += 32;
    else if (c >= 0x0410 && c <= 0x042F) c += 0x20;
    else if (c == 0x0401) c = 0x0451;
  }
  return s;
}

bool contains(const std::string& haystack, const std::string& needle) {
  return haystack.find(needle) != std::string::npos;
}

std::vector<std::string> split(const std::string& s, char sep) {
  std::vector<std::string> parts;
  size_t start = 0;
  for (size_t i = 0; i <= s.size(); i++) {
    if (i == s.size() || s[i] == sep) {
      parts.push_back(s.substr(start, i - start));
      start = i + 1;
    }
  }
  return parts;
}

std::vector<std::string> splitLines(const std::string& s) {
  std::vector<std::string> lines = split(s, '\n');
  for (auto& line : lines) if (!line.empty() && line.back() == '\r') line.pop_back();
  return lines;
}

std::string join(const std::vector<std::string>& parts, size_t from, const std::string& sep) {
  std::string out;
  for (size_t i = from; i < parts.size(); i++) {
    if (i > from) out += sep;
    out += parts[i];
  }
  return out;
}

std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
  size_t pos = 0;
  while ((pos = s.find(from, pos)) != std::string::npos) {
    s.replace(pos, from.size(), to);
    pos += to.size();
  }
  return s;
}

// Removes `open ... close` spans that contain no `close` inside, like /<[^>]*>/g.
std::string stripSpans(const std::string& s, char open, char close) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == open) {
      size_t end = s.find(close, i + 1);
      if (end != std::string::npos) { i = end; continue; }
    }
    out.push_back(s[i]);
  }
  return out;
}

// ASS line breaks: \N and \n become newlines, \h a space.
std::string assBreaks(const std::string& s, bool hardSpaces) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '\\' && i + 1 < s.size() && (s[i + 1] == 'N' || s[i + 1] == 'n')) { out.push_back('\n'); i++; }
    else if (hardSpaces && s[i] == '\\' && i + 1 < s.size() && s[i + 1] == 'h') { out.push_back(' '); i++; }
    else out.push_back(s[i]);
  }
  return out;
}

std::string clean(const std::string& text) {
  std::string out = stripSpans(stripSpans(text, '<', '>'), '{', '}');
  out = replaceAll(out, "&amp;", "&");
  out = replaceAll(out, "&lt;", "<");
  out = replaceAll(out, "&gt;", ">");
  out = replaceAll(out, "&quot;", "\"");
  out = replaceAll(out, "&#39;", "'");
  return trim(out);
}

bool valid(const Cue& cue) {
  return std::isfinite(cue.start) && std::isfinite(cue.end) && cue.start >= 0 && cue.end > cue.start && !cue.text.empty();
}

// JavaScript Number(string): whitespace-trimmed, empty is 0, anything else invalid is NaN.
double jsNumber(const std::string& raw) {
  std::string s = trim(raw);
  if (s.empty()) return 0;
  char* end = nullptr;
  double value = std::strtod(s.c_str(), &end);
  if (end != s.c_str() + s.size()) return kNaN;
  if (s.find_first_of("xXpP") != std::string::npos) return kNaN;
  return value;
}

double timestamp(const std::string& value) {
  auto numericPrefix = [](const std::string& v, size_t suffix) {
    if (v.size() <= suffix) return false;
    for (size_t i = 0; i + suffix < v.size(); i++) if (!(std::isdigit(static_cast<unsigned char>(v[i])) || v[i] == '.')) return false;
    return true;
  };
  if (value.size() > 2 && value.compare(value.size() - 2, 2, "ms") == 0 && numericPrefix(value, 2))
    return std::strtod(value.c_str(), nullptr) / 1000;
  if (value.size() > 1 && value.back() == 's' && numericPrefix(value, 1)) return std::strtod(value.c_str(), nullptr);
  double total = 0;
  for (const auto& part : split(value, ':')) total = total * 60 + jsNumber(part);
  return total;
}

// ---------- SRT / VTT ----------

bool digits(const std::string& s, size_t& i, int count) {
  for (int k = 0; k < count; k++, i++) if (i >= s.size() || !std::isdigit(static_cast<unsigned char>(s[i]))) return false;
  return true;
}

// (?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3}) at position i.
std::optional<double> stampAt(const std::string& s, size_t& i) {
  auto tail = [&](size_t j, double hours) -> std::optional<std::pair<double, size_t>> {
    size_t m0 = j;
    if (!digits(s, j, 2) || j >= s.size() || s[j] != ':') return std::nullopt;
    double minutes = std::stod(s.substr(m0, 2));
    size_t s0 = ++j;
    if (!digits(s, j, 2) || j >= s.size() || (s[j] != '.' && s[j] != ',')) return std::nullopt;
    double seconds = std::stod(s.substr(s0, 2));
    size_t ms0 = ++j;
    if (!digits(s, j, 3)) return std::nullopt;
    double ms = std::stod(s.substr(ms0, 3));
    return std::make_pair(hours * 3600 + minutes * 60 + seconds + ms / 1000, j);
  };
  for (int hourDigits : {2, 1}) {
    size_t j = i;
    if (digits(s, j, hourDigits) && j < s.size() && s[j] == ':') {
      double hours = std::stod(s.substr(i, hourDigits));
      if (auto found = tail(j + 1, hours)) { i = found->second; return found->first; }
    }
  }
  if (auto found = tail(i, 0)) { i = found->second; return found->first; }
  return std::nullopt;
}

std::optional<std::pair<double, double>> timingLine(const std::string& line) {
  size_t i = 0;
  auto start = stampAt(line, i);
  if (!start) return std::nullopt;
  size_t spaces = i;
  while (i < line.size() && isAsciiSpace(line[i])) i++;
  if (i == spaces || line.compare(i, 3, "-->") != 0) return std::nullopt;
  i += 3;
  spaces = i;
  while (i < line.size() && isAsciiSpace(line[i])) i++;
  if (i == spaces) return std::nullopt;
  auto end = stampAt(line, i);
  if (!end) return std::nullopt;
  return std::make_pair(*start, *end);
}

bool blank(const std::string& line) {
  for (char32_t c : decode(line)) if (!isSpace(c)) return false;
  return true;
}

std::vector<Cue> parseSrtVtt(const std::string& input) {
  std::string body = input;
  if (body.rfind("\xEF\xBB\xBF", 0) == 0) body = body.substr(3);
  body.erase(std::remove(body.begin(), body.end(), '\r'), body.end());
  std::vector<Cue> cues;
  std::vector<std::string> block;
  auto flush = [&]() {
    for (size_t index = 0; index < block.size(); index++) {
      auto timing = timingLine(block[index]);
      if (!timing) continue;
      std::string text = trim(stripSpans(stripSpans(join(block, index + 1, "\n"), '<', '>'), '{', '}'));
      if (!text.empty() && std::isfinite(timing->first) && timing->second > timing->first)
        cues.push_back({timing->first, timing->second, text});
      break;
    }
    block.clear();
  };
  for (const auto& line : split(body, '\n')) {
    if (blank(line)) flush();
    else block.push_back(line);
  }
  flush();
  std::stable_sort(cues.begin(), cues.end(), [](const Cue& a, const Cue& b) { return a.start < b.start; });
  return cues;
}

bool hasEventsSection(const std::string& body) { return contains(asciiLower(body), "[events]"); }

bool drawingTag(const std::string& text) {
  for (size_t i = 0; i + 3 < text.size(); i++)
    if (text[i] == '{' && text[i + 1] == '\\' && text[i + 2] == 'p' && text[i + 3] >= '1' && text[i + 3] <= '9') return true;
  return false;
}

int fieldIndex(const std::vector<std::string>& fields, const std::string& name) {
  auto it = std::find(fields.begin(), fields.end(), name);
  return it == fields.end() ? -1 : static_cast<int>(it - fields.begin());
}

std::vector<std::string> formatFields(const std::string& list) {
  std::vector<std::string> fields;
  for (auto& field : split(list, ',')) fields.push_back(asciiLower(trim(field)));
  return fields;
}

std::vector<Cue> parseAss(const std::string& body) {
  std::vector<std::string> fields;
  std::vector<Cue> cues;
  for (const auto& line : splitLines(body)) {
    if (line.rfind("Format:", 0) == 0) { fields = formatFields(line.substr(7)); continue; }
    int textAt = fieldIndex(fields, "text"), startAt = fieldIndex(fields, "start"), endAt = fieldIndex(fields, "end");
    if (line.rfind("Dialogue:", 0) != 0 || textAt < 0 || startAt < 0 || endAt < 0) continue;
    auto parts = split(line.substr(9), ',');
    auto part = [&](int index) { return index >= 0 && index < static_cast<int>(parts.size()) ? parts[index] : std::string(); };
    std::string style = asciiLower(trim(part(fieldIndex(fields, "style"))));
    if (contains(style, "furi") || contains(style, "ruby") || contains(style, "karaoke")) continue;
    std::string rawText = join(parts, textAt, ",");
    if (drawingTag(rawText)) continue;
    Cue cue{timestamp(trim(part(startAt))), timestamp(trim(part(endAt))), clean(assBreaks(rawText, true))};
    if (valid(cue)) cues.push_back(cue);
  }
  std::stable_sort(cues.begin(), cues.end(), [](const Cue& a, const Cue& b) { return a.start < b.start; });
  return cues;
}

// ---------- Theme detection ----------

bool isWord(char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '_'; }
bool isAlnum(char c) { return std::isalnum(static_cast<unsigned char>(c)); }

// \b(?:<prefix>\d*|<word>)(?:[-_\s]?(?:romaji|jp|...))?(?![a-z0-9]) on a lower-cased ASCII view.
bool themeWord(const std::string& lower, const std::string& prefix, const std::string& word) {
  static const std::vector<std::string> suffixes = {"romaji", "jp", "kanji", "rus", "en", "sub", "lyrics", "song"};
  auto endsOk = [&](size_t at) { return at >= lower.size() || !isAlnum(lower[at]); };
  auto withSuffix = [&](size_t at) {
    if (endsOk(at)) return true;
    std::vector<size_t> starts = {at};
    if (at < lower.size() && (lower[at] == '-' || lower[at] == '_' || isAsciiSpace(lower[at]))) starts.push_back(at + 1);
    for (size_t from : starts)
      for (const auto& suffix : suffixes)
        if (lower.compare(from, suffix.size(), suffix) == 0 && endsOk(from + suffix.size())) return true;
    return false;
  };
  for (size_t i = 0; i < lower.size(); i++) {
    if (i > 0 && isWord(lower[i - 1])) continue;
    if (lower.compare(i, prefix.size(), prefix) == 0) {
      size_t j = i + prefix.size();
      while (j < lower.size() && std::isdigit(static_cast<unsigned char>(lower[j]))) j++;
      if (withSuffix(j)) return true;
    }
    if (lower.compare(i, word.size(), word) == 0 && withSuffix(i + word.size())) return true;
  }
  return false;
}

bool wordBounded(const std::string& lower, const std::string& word) {
  for (size_t pos = lower.find(word); pos != std::string::npos; pos = lower.find(word, pos + 1)) {
    bool before = pos == 0 || !isWord(lower[pos - 1]);
    size_t after = pos + word.size();
    if (before && (after >= lower.size() || !isWord(lower[after]))) return true;
  }
  return false;
}

bool openingLabel(const std::string& label) {
  if (themeWord(asciiLower(label), "op", "opening") || contains(label, "オープニング")) return true;
  auto text = decode(label);
  std::u32string theme = U"主題歌";
  for (size_t pos = text.find(theme); pos != std::u32string::npos; pos = text.find(theme, pos + 1))
    if (pos == 0 || isSpace(text[pos - 1])) return true;
  return false;
}

bool endingLabel(const std::string& label) {
  return themeWord(asciiLower(label), "ed", "ending") || contains(label, "エンディング") || contains(label, "エンドクレジット");
}

const std::u32string kOpenBrackets = U"【［[(（〈＜";
const std::u32string kCloseBrackets = U"】］])）〉＞";

// "【オープニング】" -> "オープニング".
std::string cueLabel(const std::string& text) {
  auto s = trim32(decode(text));
  if (s.size() < 3 || kOpenBrackets.find(s.front()) == std::u32string::npos ||
      kCloseBrackets.find(s.back()) == std::u32string::npos)
    return "";
  auto inner = s.substr(1, s.size() - 2);
  for (char32_t c : inner) if (kCloseBrackets.find(c) != std::u32string::npos) return "";
  return encode(inner);
}

bool musicNote(char32_t c) { return c == U'♪' || c == U'♫' || c == U'♬' || c == U'♩'; }

bool isMusic(const std::string& text) {
  auto s = decode(text);
  if (!s.empty() && std::all_of(s.begin(), s.end(), [](char32_t c) { return isSpace(c) || musicNote(c); })) return true;
  if (!s.empty() && musicNote(s.front())) return true;
  auto label = lower32(trim32(decode(cueLabel(text))));
  static const std::vector<std::u32string> names = {U"music", U"singing", U"音楽", U"歌", U"テーマ曲", U"主題歌"};
  if (std::find(names.begin(), names.end(), label) != names.end()) return true;
  if (label.rfind(U"music", 0) == 0) {
    auto rest = label.substr(5);
    size_t spaces = 0;
    while (spaces < rest.size() && isSpace(rest[spaces])) spaces++;
    if (spaces > 0 && rest.substr(spaces) == U"playing") return true;
  }
  return false;
}

// {\k12, {\kf12, {\ko12 karaoke timing tags.
bool karaokeTag(const std::string& text) {
  auto lower = asciiLower(text);
  for (size_t pos = lower.find("{\\k"); pos != std::string::npos; pos = lower.find("{\\k", pos + 1)) {
    size_t j = pos + 3;
    if (j < lower.size() && std::isdigit(static_cast<unsigned char>(lower[j]))) return true;
    if (j < lower.size() && (lower[j] == 'f' || lower[j] == 'o') && j + 1 < lower.size() &&
        std::isdigit(static_cast<unsigned char>(lower[j + 1])))
      return true;
  }
  return false;
}

std::vector<Range> mergeRanges(std::vector<Range> ranges, double gap = 0) {
  std::stable_sort(ranges.begin(), ranges.end(), [](const Range& a, const Range& b) { return a.start < b.start; });
  std::vector<Range> merged;
  for (const auto& range : ranges) {
    if (!merged.empty() && range.start <= merged.back().end + gap) merged.back().end = std::max(merged.back().end, range.end);
    else merged.push_back(range);
  }
  return merged;
}

template <typename T>
std::vector<Range> toRanges(const std::vector<T>& items) {
  std::vector<Range> ranges;
  for (const auto& item : items) ranges.push_back({item.start, item.end});
  return ranges;
}

bool letterOrNumber(char32_t c) {
  if (c < 0x80) return std::isalnum(static_cast<int>(c));
  if (isSpace(c) || c == 0xFFFD) return false;
  if ((c >= 0x2000 && c <= 0x2BFF) ||  // punctuation, arrows, symbols, music notes
      (c >= 0x3000 && c <= 0x3004) || (c >= 0x3008 && c <= 0x3020) || c == 0x3030 || c == 0x30FB ||
      (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF01 && c <= 0xFF0F) || (c >= 0xFF1A && c <= 0xFF20) ||
      (c >= 0xFF3B && c <= 0xFF40) || (c >= 0xFF5B && c <= 0xFF65) || (c >= 0xA0 && c <= 0xBF) || c == 0xD7 || c == 0xF7)
    return false;
  return true;
}

// Approximates text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').
// Returns the key and its length in UTF-16 code units, like String.length.
std::pair<std::string, size_t> normalizeKey(const std::string& text) {
  std::u32string out;
  size_t length = 0;
  for (char32_t c : lower32(decode(text))) {
    if (c >= 0xFF01 && c <= 0xFF5E) c -= 0xFEE0;  // full-width ASCII
    if (c >= 'A' && c <= 'Z') c += 32;
    if (!letterOrNumber(c)) continue;
    out.push_back(c);
    length += c > 0xFFFF ? 2 : 1;
  }
  return {encode(out), length};
}

struct KeyedCue {
  double start;
  double end;
  std::string key;
};

enum class Part { Op, Ed };

std::optional<Segment> findRepeatedTheme(const std::vector<Cue>& cues, const std::vector<std::vector<Cue>>& references,
                                         Part part, double duration) {
  auto lines = [&](const std::vector<Cue>& track, double end) {
    std::vector<KeyedCue> out;
    for (const auto& cue : track) {
      if (part == Part::Op ? !(cue.start < 360) : !(cue.start >= end - 300)) continue;
      auto [key, length] = normalizeKey(cue.text);
      if (length >= 8) out.push_back({cue.start, cue.end, key});
    }
    return out;
  };
  auto current = lines(cues, duration);
  if (current.size() < 6 || current.size() > 750) return std::nullopt;
  std::optional<Segment> best;
  size_t bestCount = 0;

  for (const auto& reference : references) {
    double referenceEnd = 0;
    for (const auto& cue : reference) referenceEnd = std::max(referenceEnd, cue.end);
    std::unordered_map<std::string, std::vector<double>> byText;
    for (const auto& cue : lines(reference, referenceEnd)) byText[cue.key].push_back(cue.start);
    auto single = [&](const std::string& key) -> std::optional<double> {
      auto it = byText.find(key);
      if (it == byText.end() || it->second.size() != 1) return std::nullopt;
      return it->second[0];
    };
    // A repeated theme keeps the timing between its lines even when the episode starts it later.
    std::vector<double> offsets;
    for (const auto& cue : current)
      if (auto time = single(cue.key)) {
        double offset = std::floor(*time - cue.start + 0.5);
        if (std::find(offsets.begin(), offsets.end(), offset) == offsets.end()) offsets.push_back(offset);
      }
    for (double offset : offsets) {
      std::vector<KeyedCue> matches;
      for (const auto& cue : current)
        if (auto time = single(cue.key); time && std::abs(*time - cue.start - offset) <= 1.5) matches.push_back(cue);
      for (const auto& run : mergeRanges(toRanges(matches), 22)) {
        double length = run.end - run.start;
        if (length < 55 || length > 140) continue;
        std::set<std::string> matched, total;
        for (const auto& cue : matches) if (cue.start >= run.start && cue.end <= run.end) matched.insert(cue.key);
        for (const auto& cue : current) if (cue.start >= run.start && cue.end <= run.end) total.insert(cue.key);
        if (matched.size() >= 6 && matched.size() >= total.size() * 0.8 && matched.size() > bestCount) {
          best = Segment{run.start, run.end, "repeated-subtitles"};
          bestCount = matched.size();
        }
      }
    }
  }
  return best;
}

std::string extension(const std::string& name) {
  auto dot = name.find_last_of('.');
  auto slash = name.find_last_of('/');
  if (dot == std::string::npos || (slash != std::string::npos && dot < slash) || dot + 1 == name.size()) return "";
  return asciiLower(name.substr(dot + 1));
}

std::string stem(const std::string& name) {
  auto ext = extension(name);
  return ext.empty() ? name : name.substr(0, name.size() - ext.size() - 1);
}

// localeCompare(..., { numeric: true }) approximation: digit runs compare as numbers.
bool naturalLess(const std::string& a, const std::string& b) {
  size_t i = 0, j = 0;
  while (i < a.size() && j < b.size()) {
    bool da = std::isdigit(static_cast<unsigned char>(a[i])), db = std::isdigit(static_cast<unsigned char>(b[j]));
    if (da && db) {
      size_t ei = i, ej = j;
      while (ei < a.size() && std::isdigit(static_cast<unsigned char>(a[ei]))) ei++;
      while (ej < b.size() && std::isdigit(static_cast<unsigned char>(b[ej]))) ej++;
      auto na = a.substr(i, ei - i), nb = b.substr(j, ej - j);
      na.erase(0, std::min(na.find_first_not_of('0'), na.size()));
      nb.erase(0, std::min(nb.find_first_not_of('0'), nb.size()));
      if (na.size() != nb.size()) return na.size() < nb.size();
      if (na != nb) return na < nb;
      i = ei;
      j = ej;
      continue;
    }
    char ca = static_cast<char>(std::tolower(static_cast<unsigned char>(a[i])));
    char cb = static_cast<char>(std::tolower(static_cast<unsigned char>(b[j])));
    if (ca != cb) return static_cast<unsigned char>(ca) < static_cast<unsigned char>(cb);
    i++;
    j++;
  }
  return a.size() - i < b.size() - j;
}

}  // namespace

std::vector<Cue> parseSubtitles(const std::string& body) {
  if (body.size() > 5000000) return {};
  auto basic = parseSrtVtt(body);
  if (!basic.empty()) return basic;
  if (hasEventsSection(body)) return parseAss(body);
  return {};
}

bool isJapanese(const std::vector<Cue>& cues, bool declaredJapanese) {
  if (cues.empty()) return false;
  auto kana = [](char32_t c) { return c >= 0x3040 && c <= 0x30FF; };
  auto japanese = [&](char32_t c) { return kana(c) || (c >= 0x3400 && c <= 0x9FFF); };
  if (declaredJapanese) {
    for (const auto& cue : cues) for (char32_t c : decode(cue.text)) if (japanese(c)) return true;
    return false;
  }
  size_t withKana = 0;
  for (const auto& cue : cues) {
    auto text = decode(cue.text);
    if (std::any_of(text.begin(), text.end(), kana)) withKana++;
  }
  return static_cast<double>(withKana) >= std::max(1.0, cues.size() * 0.3);
}

OpEd detectOpEd(const std::string& rawBody, const std::vector<Cue>& cues, double videoDuration,
                const std::vector<std::vector<Cue>>& references) {
  double duration = std::isfinite(videoDuration) && videoDuration > 0 ? videoDuration : 0;
  std::vector<Cue> timed;
  for (const auto& cue : cues) if (valid(cue) && (!duration || cue.end <= duration + 0.5)) timed.push_back(cue);
  std::stable_sort(timed.begin(), timed.end(), [](const Cue& a, const Cue& b) { return a.start < b.start; });
  double limit = duration ? duration : std::max(1420.0, (timed.empty() ? 0 : timed.back().end) + 30);
  std::vector<Range> taggedOp, taggedEd, music, speech;

  auto classify = [&](Range range, const std::string& text, const std::string& metadata, bool comment) {
    if (!std::isfinite(range.start) || !std::isfinite(range.end) || range.start < 0 || range.end <= range.start ||
        range.end > limit + 0.5)
      return;
    std::string visible = clean(text);
    std::string label = metadata + " " + cueLabel(visible);
    if (openingLabel(label)) taggedOp.push_back(range);
    else if (endingLabel(label)) taggedEd.push_back(range);
    else if (wordBounded(asciiLower(metadata), "song") || wordBounded(asciiLower(metadata), "lyrics") ||
             wordBounded(asciiLower(metadata), "karaoke") || wordBounded(asciiLower(metadata), "romaji") ||
             karaokeTag(text) || isMusic(visible))
      music.push_back(range);
    else if (!comment && !visible.empty()) speech.push_back(range);
  };

  bool isAss = hasEventsSection(rawBody);
  if (isAss) {
    std::vector<std::string> fields;
    for (const auto& line : splitLines(rawBody)) {
      size_t lead = 0;
      while (lead < line.size() && isAsciiSpace(line[lead])) lead++;
      std::string body = line.substr(lead);
      std::string lower = asciiLower(body);
      if (lower.rfind("format:", 0) == 0) {
        auto pieces = split(body, ':');
        fields = formatFields(pieces.size() > 1 ? pieces[1] : "");
        continue;
      }
      bool dialogue = lower.rfind("dialogue:", 0) == 0, comment = lower.rfind("comment:", 0) == 0;
      int textAt = fieldIndex(fields, "text");
      if ((!dialogue && !comment) || textAt < 0 || fieldIndex(fields, "start") < 0 || fieldIndex(fields, "end") < 0) continue;
      std::string rest = body.substr(dialogue ? 9 : 8);
      size_t skip = 0;
      while (skip < rest.size() && isAsciiSpace(rest[skip])) skip++;
      auto parts = split(rest.substr(skip), ',');
      auto field = [&](const std::string& name) {
        int index = fieldIndex(fields, name);
        return index >= 0 && index < static_cast<int>(parts.size()) ? trim(parts[index]) : std::string();
      };
      std::string text = assBreaks(join(parts, textAt, ","), false);
      std::string style = field("style");
      std::string lowerStyle = asciiLower(style);
      if (contains(lowerStyle, "furi") || contains(lowerStyle, "ruby") || drawingTag(text)) continue;
      std::string name = field("name");
      if (name.empty()) name = field("actor");
      classify({timestamp(field("start")), timestamp(field("end"))}, text, style + " " + name + " " + field("effect"), comment);
    }
  } else {
    for (const auto& cue : timed) classify({cue.start, cue.end}, cue.text, "", false);
  }

  auto early = [&](const Range& range) { return range.start <= std::min(360.0, limit / 2); };
  auto late = [&](const Range& range) { return range.start >= std::max(limit / 2, limit - 240); };
  std::vector<Range> themes;
  for (const auto& range : mergeRanges(music, 6)) {
    double length = range.end - range.start;
    if (length < 65 || length > 140) continue;
    if (std::any_of(speech.begin(), speech.end(),
                    [&](const Range& cue) { return cue.start < range.end - 1 && cue.end > range.start + 1; }))
      continue;
    std::vector<Range> inside;
    for (const auto& cue : music) if (cue.start >= range.start && cue.end <= range.end) inside.push_back(cue);
    double covered = 0;
    for (const auto& cue : mergeRanges(inside)) covered += cue.end - cue.start;
    if (covered >= length * 0.55) themes.push_back(range);
  }

  auto detect = [&](Part part, const std::function<bool(const Range&)>& inWindow) -> std::optional<Segment> {
    for (const auto& range : mergeRanges(part == Part::Op ? taggedOp : taggedEd, 10))
      if (range.end - range.start >= 45 && range.end - range.start <= 150)
        return Segment{range.start, range.end, isAss ? "ass-style" : "subtitle-label"};
    auto musicTheme = std::find_if(themes.begin(), themes.end(), inWindow);
    if (musicTheme != themes.end() && (part == Part::Op || duration))
      return Segment{musicTheme->start, musicTheme->end, "subtitle-music"};
    if (!references.empty() && duration) {
      auto repeated = findRepeatedTheme(timed, references, part, duration);
      if (repeated && inWindow({repeated->start, repeated->end})) return repeated;
    }
    if (timed.size() < 15 || (part == Part::Ed && !duration)) return std::nullopt;
    auto occupied = mergeRanges(toRanges(timed));
    std::vector<Range> gaps;
    for (size_t index = 0; index < occupied.size(); index++)
      gaps.push_back({index ? occupied[index - 1].end : 0, occupied[index].start});
    if (part == Part::Ed) gaps.push_back({occupied.back().end, duration});
    std::vector<Range> candidates;
    for (const auto& gap : gaps)
      if (inWindow(gap) && gap.end - gap.start >= 75 && gap.end - gap.start <= 110) candidates.push_back(gap);
    if (candidates.size() != 1) return std::nullopt;
    // Keep a small margin before dialogue or the end of the file.
    return Segment{candidates[0].start, candidates[0].end - 0.5, "dialogue-gap"};
  };

  return {detect(Part::Op, early), detect(Part::Ed, late)};
}

bool overlapsRecap(const std::optional<Range>& opening, const std::optional<Range>& recap) {
  return opening && recap && opening->start < recap->end && recap->start < opening->end;
}

Skips resolveSkipRanges(const Skips& frames, const OpEd& subtitles, double subtitleOffset) {
  auto resolve = [&](const std::optional<Segment>& segment, const std::optional<Range>& frame) -> std::optional<Range> {
    std::optional<Range> subtitleRange;
    if (segment) subtitleRange = Range{segment->start + subtitleOffset, segment->end + subtitleOffset};
    // Theme lyrics usually start after the intro music and stop before the outro, so a frame match is more exact.
    if (frame && (!subtitleRange || (frame->start < subtitleRange->end && frame->end > subtitleRange->start))) return frame;
    if (segment && segment->source != "dialogue-gap" && subtitleRange) return subtitleRange;
    return frame ? frame : subtitleRange;
  };
  auto clamp = [](std::optional<Range> range) {
    if (range) range->start = std::max(0.0, range->start);
    return range;
  };
  Skips out;
  out.recap = clamp(frames.recap);
  auto opening = resolve(subtitles.op, frames.op);
  out.op = overlapsRecap(opening, frames.recap) ? std::nullopt : clamp(opening);
  out.ed = clamp(resolve(subtitles.ed, frames.ed));
  return out;
}

FolderTitle folderTitle(const std::string& folderName) {
  auto plain = decode(folderName);
  const std::u32string prefix = U"смотреть аниме";
  if (lower32(plain.substr(0, prefix.size())) == prefix && plain.size() > prefix.size() && isSpace(plain[prefix.size()])) {
    size_t i = prefix.size();
    while (i < plain.size() && isSpace(plain[i])) i++;
    plain = plain.substr(i);
  }
  std::u32string title, credit;
  bool matched = false;
  // ^(.*?) - \d+(?: - (.+))?$
  for (size_t i = 0; i + 3 < plain.size() && !matched; i++) {
    if (plain.compare(i, 3, U" - ") != 0) continue;
    size_t j = i + 3;
    while (j < plain.size() && plain[j] >= '0' && plain[j] <= '9') j++;
    if (j == i + 3) continue;
    if (j == plain.size()) { title = plain.substr(0, i); matched = true; }
    else if (plain.compare(j, 3, U" - ") == 0 && j + 3 < plain.size()) {
      title = plain.substr(0, i);
      credit = plain.substr(j + 3);
      matched = true;
    }
  }
  if (!matched) {
    // Without an id, drop a trailing translation credit such as "- NDA Studio Дубляж".
    auto hyphen = plain.find_last_of(U'-');
    if (hyphen != std::u32string::npos && hyphen > 0 && hyphen + 1 < plain.size() && isSpace(plain[hyphen - 1]) &&
        isSpace(plain[hyphen + 1])) {
      size_t from = hyphen + 1;
      while (from < plain.size() && isSpace(plain[from])) from++;
      auto candidate = plain.substr(from);
      auto lower = lower32(candidate);
      for (const std::u32string word : {U"дубляж", U"озвучка", U"субтитр", U"войсовер", U"dub", U"sub"})
        if (lower.find(word) != std::u32string::npos) { credit = candidate; break; }
    }
    if (!credit.empty()) {
      title = plain.substr(0, plain.rfind(credit));
      size_t end = title.size();
      while (end > 0 && isSpace(title[end - 1])) end--;
      if (end > 0 && title[end - 1] == '-') {
        size_t start = end - 1;
        size_t ws = start;
        while (ws > 0 && isSpace(title[ws - 1])) ws--;
        if (ws < start) title = title.substr(0, ws);
      }
    } else {
      title = plain;
    }
  }
  const std::u32string online = U"онлайн";
  if (title.size() > online.size() && lower32(title.substr(title.size() - online.size())) == online &&
      isSpace(title[title.size() - online.size() - 1])) {
    size_t end = title.size() - online.size();
    while (end > 0 && isSpace(title[end - 1])) end--;
    title = title.substr(0, end);
  }
  return {encode(trim32(title)), encode(trim32(credit))};
}

std::string episodeLabel(const std::string& fileName) {
  std::string name = fileName.substr(fileName.find_last_of('/') == std::string::npos ? 0 : fileName.find_last_of('/') + 1);
  auto lower = asciiLower(name);
  if (lower.rfind("episode", 0) == 0) {
    size_t i = 7, spaces;
    while (i < name.size() && isAsciiSpace(name[i])) i++;
    spaces = i - 7;
    size_t digitsStart = i;
    while (i < name.size() && std::isdigit(static_cast<unsigned char>(name[i]))) i++;
    if (spaces > 0 && i > digitsStart && (i == name.size() || !isWord(name[i]))) {
      auto number = name.substr(digitsStart, i - digitsStart);
      number.erase(0, std::min(number.find_first_not_of('0'), number.size() - 1));
      return "Episode " + number;
    }
  }
  auto dot = name.find_last_of('.');
  return dot == std::string::npos || dot + 1 == name.size() ? name : name.substr(0, dot);
}

std::vector<EpisodePair> pairEpisodes(const std::vector<std::string>& paths) {
  static const std::set<std::string> subtitleTypes = {"ass", "ssa", "srt", "vtt"};
  // AVPlayer cannot open WebM or MKV, so only list containers iOS plays.
  static const std::set<std::string> videoTypes = {"mp4", "m4v", "mov"};
  std::map<std::string, std::string> subtitles;
  std::vector<std::string> videos;
  for (const auto& path : paths) {
    auto ext = extension(path);
    if (subtitleTypes.count(ext)) subtitles[stem(path)] = path;
    else if (videoTypes.count(ext)) videos.push_back(path);
  }
  std::stable_sort(videos.begin(), videos.end(), naturalLess);
  std::vector<EpisodePair> pairs;
  for (const auto& video : videos) {
    auto found = subtitles.find(stem(video));
    pairs.push_back({video, found == subtitles.end() ? std::nullopt : std::optional<std::string>(found->second), episodeLabel(video)});
  }
  return pairs;
}

int cueIndexAt(const std::vector<Cue>& cues, double time) {
  // Cues are sorted by start; overlapping cues show the latest one that started.
  auto it = std::upper_bound(cues.begin(), cues.end(), time, [](double t, const Cue& cue) { return t < cue.start; });
  for (auto index = it - cues.begin() - 1; index >= 0 && index >= (it - cues.begin()) - 8; index--)
    if (time < cues[index].end) return static_cast<int>(index);
  return -1;
}

namespace {

constexpr size_t kFrameBytes = 12 * 8 * 3;
constexpr int kThemeInterval = 2;

struct FrameSample {
  double time = 0;
  const uint8_t* pixels = nullptr;
};

std::vector<uint8_t> decodeBase64(const std::string& input) {
  static const int kLookup[256] = {
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
      52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
      -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
      15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
      -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
      41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
      -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  };
  std::vector<uint8_t> out;
  out.reserve((input.size() / 4) * 3);
  int val = 0;
  int valb = -8;
  for (unsigned char c : input) {
    int d = kLookup[c];
    if (d == -1) continue;
    val = (val << 6) + d;
    valb += 6;
    if (valb >= 0) {
      out.push_back(static_cast<uint8_t>((val >> valb) & 0xFF));
      valb -= 8;
    }
  }
  return out;
}

double frameDistance(const uint8_t* a, const uint8_t* b) {
  int total = 0;
  for (size_t i = 0; i < kFrameBytes; i++) {
    total += std::abs(static_cast<int>(a[i]) - static_cast<int>(b[i]));
  }
  return static_cast<double>(total) / static_cast<double>(kFrameBytes);
}

double alignedDistance(const uint8_t* sample, const std::vector<FrameSample>& reference, int aligned, int tolerance = 1) {
  double best = std::numeric_limits<double>::infinity();
  int refSize = static_cast<int>(reference.size());
  for (int nearby = aligned - tolerance; nearby <= aligned + tolerance; nearby++) {
    if (nearby >= 0 && nearby < refSize) {
      best = std::min(best, frameDistance(sample, reference[nearby].pixels));
    }
  }
  return best;
}

struct WindowMatch {
  double start = 0;
  double end = 0;
  int hits = 0;
  double mean = 0;
  int offset = 0;
};

std::optional<WindowMatch> matchWindow(const std::vector<FrameSample>& current,
                                       const std::vector<FrameSample>& reference,
                                       double minimumSeconds) {
  if (current.empty() || reference.empty()) return std::nullopt;
  std::optional<WindowMatch> best;
  const double maximumSeconds = 150.0;
  const double minimumCoverage = 0.75;
  const int maximumGap = 3;
  const double maximumDistance = 30.0;
  const int curLen = static_cast<int>(current.size());
  const int refLen = static_cast<int>(reference.size());

  for (int offset = -(curLen - 1) * kThemeInterval; offset < refLen; offset++) {
    int first = 0, last = 0, hits = 0, changes = 0;
    double total = 0.0;
    auto consider = [&]() {
      if (hits <= 0) return;
      int span = last - first + 1;
      double seconds = static_cast<double>((span - 1) * kThemeInterval);
      double mean = total / static_cast<double>(hits);
      if (seconds >= minimumSeconds && seconds <= maximumSeconds &&
          static_cast<double>(hits) / static_cast<double>(span) >= minimumCoverage &&
          changes >= 5 && mean <= 19.0 &&
          (!best || hits > best->hits || (hits == best->hits && mean < best->mean))) {
        best = WindowMatch{current[first].time, current[last].time, hits, mean, offset};
      }
    };
    int from = std::max(0, static_cast<int>(std::ceil(-static_cast<double>(offset) / kThemeInterval)));
    int to = std::min(curLen, static_cast<int>(std::ceil(static_cast<double>(refLen - offset) / kThemeInterval)));
    for (int idx = from; idx < to; idx++) {
      if (hits && idx - last > maximumGap) {
        consider();
        hits = 0;
        changes = 0;
        total = 0.0;
      }
      double diff = alignedDistance(current[idx].pixels, reference, idx * kThemeInterval + offset);
      if (diff > maximumDistance) continue;
      if (hits) {
        if (frameDistance(current[idx].pixels, current[last].pixels) > 14.0) changes++;
      } else {
        first = idx;
      }
      last = idx;
      hits++;
      total += diff;
    }
    consider();
  }
  return best;
}

Range refineWindow(const std::vector<FrameSample>& current,
                   const std::vector<FrameSample>& reference,
                   const WindowMatch& best) {
  int first = -1, last = -1;
  for (int i = 0; i < static_cast<int>(current.size()); i++) {
    if (first < 0 && current[i].time == best.start) first = i;
    if (current[i].time == best.end) last = i;
  }
  if (first < 0 || last < 0) return {best.start, best.end};
  auto matches = [&](int idx) {
    return alignedDistance(current[idx].pixels, reference, idx + best.offset) <= 30.0;
  };
  while (first > 0 && matches(first - 1)) first--;
  while (last < static_cast<int>(current.size()) - 1 && matches(last + 1)) last++;
  double start = first > 0 ? (current[first - 1].time + current[first].time) / 2.0
                           : std::max(0.0, current[first].time - 0.5);
  double end = last < static_cast<int>(current.size()) - 1
                   ? (current[last].time + current[last + 1].time) / 2.0
                   : current[last].time + 0.5;
  return {std::round(start * 100.0) / 100.0, std::round(end * 100.0) / 100.0};
}

std::optional<Range> matchPart(const FrameWindow& curWin, const FrameWindow& refWin, double minSeconds) {
  auto curBytes = decodeBase64(curWin.dataBase64);
  auto refBytes = decodeBase64(refWin.dataBase64);
  size_t curCount = std::min(curWin.times.size(), curBytes.size() / kFrameBytes);
  size_t refCount = std::min(refWin.times.size(), refBytes.size() / kFrameBytes);
  if (curCount == 0 || refCount == 0) return std::nullopt;

  std::vector<FrameSample> curSamples;
  curSamples.reserve(curCount);
  for (size_t i = 0; i < curCount; i++) {
    curSamples.push_back({curWin.times[i], curBytes.data() + i * kFrameBytes});
  }
  std::vector<FrameSample> refSamples;
  refSamples.reserve(refCount);
  for (size_t i = 0; i < refCount; i++) {
    refSamples.push_back({refWin.times[i], refBytes.data() + i * kFrameBytes});
  }

  std::vector<FrameSample> subsampled;
  subsampled.reserve((curCount + 1) / kThemeInterval);
  for (size_t i = 0; i < curCount; i += kThemeInterval) {
    subsampled.push_back(curSamples[i]);
  }

  auto best = matchWindow(subsampled, refSamples, minSeconds);
  if (!best) return std::nullopt;
  return refineWindow(curSamples, refSamples, *best);
}

}  // namespace

Skips matchVideoThemes(const VideoFingerprint& current, const VideoFingerprint& reference) {
  Skips out;
  out.op = matchPart(current.op, reference.op, 70.0);
  out.ed = matchPart(current.ed, reference.ed, 60.0);
  return out;
}

}  // namespace animecore::logic
