#include "ArcCoreLogic.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <functional>
#include <regex>
#include <stdexcept>
#include <unordered_set>

namespace arccore::logic {

namespace {

std::string lower(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return std::tolower(c); });
  return text;
}

std::string trim(const std::string& text) {
  const auto start = text.find_first_not_of(" \t\r\n");
  if (start == std::string::npos) return "";
  const auto end = text.find_last_not_of(" \t\r\n");
  return text.substr(start, end - start + 1);
}

bool contains(const std::string& haystack, const std::string& needle) {
  return !needle.empty() && haystack.find(needle) != std::string::npos;
}

struct UrlParts {
  std::string scheme, authority, rest;
};

std::optional<UrlParts> split(const std::string& url) {
  const auto schemeEnd = url.find("://");
  if (schemeEnd == std::string::npos || schemeEnd == 0) return std::nullopt;
  const auto scheme = url.substr(0, schemeEnd);
  if (!std::all_of(scheme.begin(), scheme.end(), [](unsigned char c) {
        return std::isalnum(c) || c == '+' || c == '-' || c == '.';
      }))
    return std::nullopt;
  const auto authorityStart = schemeEnd + 3;
  const auto authorityEnd = url.find_first_of("/?#", authorityStart);
  UrlParts parts{lower(scheme), url.substr(authorityStart, authorityEnd - authorityStart),
                 authorityEnd == std::string::npos ? "" : url.substr(authorityEnd)};
  return parts;
}

}  // namespace

std::string urlKey(const std::string& raw) {
  const auto url = trim(raw);
  auto parts = split(url);
  if (!parts || parts->authority.empty()) return url;
  // Lower-case the host but not any userinfo before '@'.
  const auto at = parts->authority.rfind('@');
  std::string userinfo = at == std::string::npos ? "" : parts->authority.substr(0, at + 1);
  std::string host = lower(at == std::string::npos ? parts->authority : parts->authority.substr(at + 1));
  if ((parts->scheme == "http" && host.size() > 3 && host.ends_with(":80")) ||
      (parts->scheme == "https" && host.size() > 4 && host.ends_with(":443")))
    host = host.substr(0, host.rfind(':'));
  std::string rest = parts->rest;
  if (rest.empty() || rest[0] != '/') rest = "/" + rest;
  return parts->scheme + "://" + userinfo + host + rest;
}

std::string hostname(const std::string& url) {
  auto parts = split(trim(url));
  if (!parts) return "";
  auto host = parts->authority;
  if (const auto at = host.rfind('@'); at != std::string::npos) host = host.substr(at + 1);
  if (const auto colon = host.rfind(':'); colon != std::string::npos && host.find(']') == std::string::npos)
    host = host.substr(0, colon);
  host = lower(host);
  return host.starts_with("www.") ? host.substr(4) : host;
}

std::string encodeURIComponent(const std::string& text) {
  static const std::string safe = "-_.!~*'()";
  std::string out;
  for (unsigned char c : text) {
    if (std::isalnum(c) || safe.find(static_cast<char>(c)) != std::string::npos) {
      out += static_cast<char>(c);
    } else {
      char buffer[4];
      std::snprintf(buffer, sizeof buffer, "%%%02X", c);
      out += buffer;
    }
  }
  return out;
}

Navigation parseInput(const std::string& raw) {
  const auto query = trim(raw);
  if (query.empty()) return {false, ""};
  static const std::regex explicitUrl(R"(^(https?://|about:|file://))", std::regex::icase);
  static const std::regex localhost(R"(^localhost(:\d+)?(/.*)?$)", std::regex::icase);
  static const std::regex domain(R"(^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(/.*)?$)", std::regex::icase);
  if (std::regex_search(query, explicitUrl)) return {true, query};
  if (std::regex_match(query, localhost)) return {true, "http://" + query};
  if (query.find(' ') == std::string::npos && std::regex_match(query, domain)) return {true, "https://" + query};
  return {false, "https://www.google.com/search?q=" + encodeURIComponent(query)};
}

Snapshot defaultSnapshot() {
  Snapshot snapshot;
  snapshot.spaces = {{"space-personal", "Personal", "#6366F1"}, {"space-work", "Work", "#0EA5E9"}};
  snapshot.activeSpaceId = "space-personal";
  snapshot.favorites = {{"fav-wikipedia", "Wikipedia", "https://www.wikipedia.org/"}};
  snapshot.pins = {
      {"pin-news", "space-personal", std::nullopt, "link", "Hacker News", "https://news.ycombinator.com/", false},
      {"folder-reading", "space-personal", std::nullopt, "folder", "Reading", "", false},
      {"pin-arc", "space-personal", "folder-reading", "link", "Arc", "https://arc.net/", false},
      {"pin-github", "space-work", std::nullopt, "link", "GitHub", "https://github.com/", false},
  };
  return snapshot;
}

Browser::Browser() : Browser(defaultSnapshot()) {}

Browser::Browser(Snapshot snapshot) : random_(std::random_device{}()) { load(std::move(snapshot)); }

void Browser::load(Snapshot snapshot) {
  if (snapshot.spaces.empty()) snapshot.spaces = defaultSnapshot().spaces;
  const auto spaceExists = [&](const std::string& id) {
    return std::any_of(snapshot.spaces.begin(), snapshot.spaces.end(), [&](const Space& s) { return s.id == id; });
  };
  if (!spaceExists(snapshot.activeSpaceId)) snapshot.activeSpaceId = snapshot.spaces.front().id;

  // Drop pins in deleted Spaces, then pins whose folder is gone (repeat until
  // stable so orphaned subtrees disappear), and break any parent cycles.
  std::erase_if(snapshot.pins, [&](const Pin& pin) { return !spaceExists(pin.spaceId); });
  for (bool changed = true; changed;) {
    changed = false;
    std::unordered_set<std::string> folders;
    for (const auto& pin : snapshot.pins)
      if (pin.kind == "folder") folders.insert(pin.spaceId + "\n" + pin.id);
    const auto before = snapshot.pins.size();
    std::erase_if(snapshot.pins, [&](const Pin& pin) {
      return pin.parentId && !folders.contains(pin.spaceId + "\n" + *pin.parentId);
    });
    changed = snapshot.pins.size() != before;
  }
  for (auto& pin : snapshot.pins) {
    std::unordered_set<std::string> seen{pin.id};
    for (auto parent = pin.parentId; parent;) {
      if (!seen.insert(*parent).second) {
        pin.parentId.reset();
        break;
      }
      const auto it = std::find_if(snapshot.pins.begin(), snapshot.pins.end(),
                                   [&](const Pin& p) { return p.id == *parent; });
      parent = it == snapshot.pins.end() ? std::nullopt : it->parentId;
    }
  }
  state_ = std::move(snapshot);
}

std::string Browser::nextId(const char* prefix) {
  char buffer[17];
  std::snprintf(buffer, sizeof buffer, "%016llx", static_cast<unsigned long long>(random_()));
  return std::string(prefix) + "-" + buffer;
}

const Space& Browser::requireSpace(const std::string& spaceId) const {
  for (const auto& space : state_.spaces)
    if (space.id == spaceId) return space;
  throw std::invalid_argument("This Space no longer exists.");
}

Pin* Browser::findPin(const std::string& pinId) {
  for (auto& pin : state_.pins)
    if (pin.id == pinId) return &pin;
  return nullptr;
}

const Pin* Browser::findPin(const std::string& pinId) const {
  return const_cast<Browser*>(this)->findPin(pinId);
}

std::string Browser::addSpace(const std::string& name, const std::string& color) {
  const auto title = trim(name);
  if (title.empty()) throw std::invalid_argument("Enter a name for the Space.");
  auto id = nextId("space");
  state_.spaces.push_back({id, title, color.empty() ? "#6366F1" : color});
  return id;
}

void Browser::setActiveSpace(const std::string& spaceId) {
  requireSpace(spaceId);
  state_.activeSpaceId = spaceId;
}

void Browser::removeSpace(const std::string& spaceId) {
  requireSpace(spaceId);
  if (state_.spaces.size() == 1) throw std::invalid_argument("Keep at least one Space.");
  std::erase_if(state_.spaces, [&](const Space& s) { return s.id == spaceId; });
  std::erase_if(state_.pins, [&](const Pin& p) { return p.spaceId == spaceId; });
  if (state_.activeSpaceId == spaceId) state_.activeSpaceId = state_.spaces.front().id;
}

std::string Browser::pinUrl(const std::string& spaceId, const std::string& title, const std::string& url,
                            const std::optional<std::string>& folderId) {
  requireSpace(spaceId);
  if (trim(url).empty()) throw std::invalid_argument("Enter a URL to pin.");
  if (folderId) {
    const auto* folder = findPin(*folderId);
    if (!folder || folder->kind != "folder" || folder->spaceId != spaceId)
      throw std::invalid_argument("Folder no longer exists.");
  }
  const auto key = urlKey(url);
  const auto existing = std::find_if(state_.pins.begin(), state_.pins.end(), [&](const Pin& pin) {
    return pin.spaceId == spaceId && pin.kind == "link" && urlKey(pin.url) == key;
  });
  if (existing != state_.pins.end()) {
    Pin moved = *existing;
    if (moved.parentId == folderId) return moved.id;
    moved.parentId = folderId;
    state_.pins.erase(existing);
    state_.pins.push_back(moved);
    return moved.id;
  }
  const auto name = trim(title);
  auto id = nextId("pin");
  state_.pins.push_back({id, spaceId, folderId, "link", name.empty() ? hostname(url) : name, trim(url), false});
  return id;
}

std::string Browser::createFolder(const std::string& spaceId, const std::string& title,
                                  const std::optional<std::string>& parentId) {
  requireSpace(spaceId);
  if (parentId) {
    auto* parent = findPin(*parentId);
    if (!parent || parent->kind != "folder" || parent->spaceId != spaceId)
      throw std::invalid_argument("Folder no longer exists.");
    parent->collapsed = false;
  }
  const auto name = trim(title);
  auto id = nextId("folder");
  state_.pins.push_back({id, spaceId, parentId, "folder", name.empty() ? "New Folder" : name, "", false});
  return id;
}

void Browser::toggleFolder(const std::string& pinId) {
  auto* folder = findPin(pinId);
  if (!folder || folder->kind != "folder") throw std::invalid_argument("Folder no longer exists.");
  folder->collapsed = !folder->collapsed;
}

void Browser::renamePin(const std::string& pinId, const std::string& title) {
  auto* pin = findPin(pinId);
  if (!pin) throw std::invalid_argument("This pinned item no longer exists.");
  const auto name = trim(title);
  if (name.empty()) throw std::invalid_argument("Enter a name for the pinned item.");
  pin->title = name;
}

void Browser::removePin(const std::string& pinId) {
  std::unordered_set<std::string> doomed{pinId};
  for (bool grew = true; grew;) {
    grew = false;
    for (const auto& pin : state_.pins)
      if (pin.parentId && doomed.contains(*pin.parentId) && doomed.insert(pin.id).second) grew = true;
  }
  std::erase_if(state_.pins, [&](const Pin& pin) { return doomed.contains(pin.id); });
}

std::vector<Row> Browser::visibleRows(const std::string& spaceId) const {
  std::vector<Row> rows;
  std::function<void(const std::optional<std::string>&, int)> visit = [&](const std::optional<std::string>& parent,
                                                                            int depth) {
    for (const auto& pin : state_.pins) {
      if (pin.spaceId != spaceId || pin.parentId != parent) continue;
      rows.push_back({pin.id, pin.kind, pin.title, pin.url, depth, pin.collapsed});
      if (pin.kind == "folder" && !pin.collapsed) visit(pin.id, depth + 1);
    }
  };
  visit(std::nullopt, 0);
  return rows;
}

std::string Browser::addFavorite(const std::string& title, const std::string& url) {
  if (trim(url).empty()) throw std::invalid_argument("Enter a URL for the Favorite.");
  const auto key = urlKey(url);
  for (const auto& favorite : state_.favorites)
    if (urlKey(favorite.url) == key) return favorite.id;
  const auto name = trim(title);
  auto id = nextId("fav");
  state_.favorites.push_back({id, name.empty() ? hostname(url) : name, trim(url)});
  return id;
}

void Browser::removeFavorite(const std::string& favoriteId) {
  std::erase_if(state_.favorites, [&](const Favorite& f) { return f.id == favoriteId; });
}

std::vector<SearchHit> Browser::search(const std::string& rawQuery, size_t limit) const {
  const auto query = lower(trim(rawQuery));
  if (query.empty()) return {};
  const auto score = [&](const std::string& title, const std::string& url, const std::string& folder) {
    const auto t = lower(title);
    double value = 0;
    if (t.starts_with(query)) value = 3;
    else if (contains(t, query)) value = 2;
    if (contains(lower(url), query)) value = std::max(value, 1.5);
    if (contains(lower(folder), query)) value = std::max(value, 1.0);
    return value;
  };

  std::vector<SearchHit> hits;
  for (const auto& favorite : state_.favorites) {
    if (const auto s = score(favorite.title, favorite.url, ""); s > 0)
      hits.push_back({"favorite", favorite.id, favorite.title, "Favorite · " + hostname(favorite.url), favorite.url,
                      state_.activeSpaceId, s + 0.75});
  }
  for (const auto& pin : state_.pins) {
    if (pin.kind != "link") continue;
    std::string path;
    for (auto parent = pin.parentId; parent;) {
      const auto* folder = findPin(*parent);
      if (!folder) break;
      path = " / " + folder->title + path;
      parent = folder->parentId;
    }
    const auto s = score(pin.title, pin.url, path);
    if (s <= 0) continue;
    const auto& space = requireSpace(pin.spaceId);
    hits.push_back({"pinned", pin.id, pin.title, space.name + path + " · " + hostname(pin.url), pin.url, pin.spaceId,
                    s + (pin.spaceId == state_.activeSpaceId ? 0.5 : 0)});
  }
  std::stable_sort(hits.begin(), hits.end(), [](const SearchHit& a, const SearchHit& b) { return a.score > b.score; });
  if (hits.size() > limit) hits.resize(limit);
  return hits;
}

}  // namespace arccore::logic
