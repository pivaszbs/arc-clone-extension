#pragma once

// Platform-independent Arc browser model: Spaces, shared Favorites and a
// nested pinned tree per Space. No React Native or JSI types here, so the
// logic builds and tests with plain clang++ on any host.

#include <cstdint>
#include <optional>
#include <random>
#include <string>
#include <vector>

namespace arccore::logic {

struct Space {
  std::string id;
  std::string name;
  std::string color;
};

// Pins are stored flat; `parentId` points at a folder pin in the same Space.
// Sibling order is the order of the `pins` vector.
struct Pin {
  std::string id;
  std::string spaceId;
  std::optional<std::string> parentId;
  std::string kind;  // "link" | "folder"
  std::string title;
  std::string url;   // empty for folders
  bool collapsed = false;
};

struct Favorite {
  std::string id;
  std::string title;
  std::string url;
};

struct Snapshot {
  std::vector<Space> spaces;
  std::vector<Pin> pins;
  std::vector<Favorite> favorites;
  std::string activeSpaceId;
};

struct Row {
  std::string id;
  std::string kind;
  std::string title;
  std::string url;
  int depth = 0;
  bool collapsed = false;
};

struct SearchHit {
  std::string kind;  // "favorite" | "pinned"
  std::string id;
  std::string title;
  std::string subtitle;
  std::string url;
  std::string spaceId;
  double score = 0;
};

struct Navigation {
  bool isUrl = false;
  std::string url;
};

// Host-only URLs equal their trailing-slash form; scheme and host are
// case-insensitive and default ports are dropped. Other text is unchanged.
std::string urlKey(const std::string& url);
std::string hostname(const std::string& url);
// Address bar / Command Bar input: URL, bare domain, localhost or a search.
Navigation parseInput(const std::string& raw);
std::string encodeURIComponent(const std::string& text);

Snapshot defaultSnapshot();

class Browser {
 public:
  Browser();
  explicit Browser(Snapshot snapshot);

  const Snapshot& snapshot() const { return state_; }
  // Replaces the state, repairing references to Spaces or folders that no longer exist.
  void load(Snapshot snapshot);

  std::string addSpace(const std::string& name, const std::string& color);
  void setActiveSpace(const std::string& spaceId);
  void removeSpace(const std::string& spaceId);

  // Pins a URL into a Space (optionally inside a folder). Pinning a URL the
  // Space already has moves that pin instead of duplicating it, keeping its id and title.
  std::string pinUrl(const std::string& spaceId, const std::string& title, const std::string& url,
                     const std::optional<std::string>& folderId);
  // Creates a folder at the top level or inside `parentId`, expanding the parent.
  std::string createFolder(const std::string& spaceId, const std::string& title,
                           const std::optional<std::string>& parentId);
  void toggleFolder(const std::string& pinId);
  void renamePin(const std::string& pinId, const std::string& title);
  // Removes a pin; removing a folder removes everything inside it.
  void removePin(const std::string& pinId);
  // Rows to draw for a Space, depth-first, skipping the contents of collapsed folders.
  std::vector<Row> visibleRows(const std::string& spaceId) const;

  std::string addFavorite(const std::string& title, const std::string& url);
  void removeFavorite(const std::string& favoriteId);

  // Ranks Favorites and pinned links in every Space; the active Space wins ties.
  std::vector<SearchHit> search(const std::string& query, size_t limit) const;

 private:
  Snapshot state_;
  std::mt19937_64 random_;

  std::string nextId(const char* prefix);
  const Space& requireSpace(const std::string& spaceId) const;
  Pin* findPin(const std::string& pinId);
  const Pin* findPin(const std::string& pinId) const;
};

}  // namespace arccore::logic
