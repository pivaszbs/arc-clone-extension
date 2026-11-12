#include "../cpp/core/ArcCoreLogic.hpp"

#include <cstdio>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

using namespace arccore::logic;

static int failures = 0;
static int passed = 0;

#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::fprintf(stderr, "  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                      \
      return;                                                          \
    }                                                                  \
  } while (0)

template <typename F>
static bool throws(F&& f) {
  try {
    f();
  } catch (const std::invalid_argument&) {
    return true;
  }
  return false;
}

static std::string ids(const std::vector<Row>& rows) {
  std::string out;
  for (const auto& row : rows) out += (out.empty() ? "" : ",") + row.title + ":" + std::to_string(row.depth);
  return out;
}

static Snapshot empty() {
  Snapshot s;
  s.spaces = {{"a", "Personal", "#000"}, {"b", "Work", "#111"}};
  s.activeSpaceId = "a";
  return s;
}

static void urlKeyNormalises() {
  CHECK(urlKey("HTTPS://Example.COM") == "https://example.com/");
  CHECK(urlKey("https://example.com:443/a?b#c") == "https://example.com/a?b#c");
  CHECK(urlKey("http://example.com:8080") == "http://example.com:8080/");
  CHECK(urlKey("https://example.com/Path") != urlKey("https://example.com/path"));
  CHECK(urlKey("not a url") == "not a url");
  CHECK(hostname("https://www.Example.com:8080/x") == "example.com");
}

static void parseInputMatchesExtension() {
  auto n = parseInput("example.com/docs");
  CHECK(n.isUrl && n.url == "https://example.com/docs");
  n = parseInput("localhost:3000");
  CHECK(n.isUrl && n.url == "http://localhost:3000");
  n = parseInput("https://a.test");
  CHECK(n.isUrl && n.url == "https://a.test");
  n = parseInput("arc browser & folders");
  CHECK(!n.isUrl && n.url == "https://www.google.com/search?q=arc%20browser%20%26%20folders");
  n = parseInput("   ");
  CHECK(!n.isUrl && n.url.empty());
}

static void nestedFoldersRenderDepthFirst() {
  Browser b(empty());
  b.pinUrl("a", "Top", "https://top.test", std::nullopt);
  const auto work = b.createFolder("a", "Work", std::nullopt);
  const auto docs = b.createFolder("a", "Docs", work);
  b.pinUrl("a", "Spec", "https://spec.test", docs);
  b.pinUrl("a", "Board", "https://board.test", work);
  CHECK(ids(b.visibleRows("a")) == "Top:0,Work:0,Docs:1,Spec:2,Board:1");
  CHECK(b.visibleRows("b").empty());
  b.toggleFolder(docs);
  CHECK(ids(b.visibleRows("a")) == "Top:0,Work:0,Docs:1,Board:1");
  b.toggleFolder(work);
  CHECK(ids(b.visibleRows("a")) == "Top:0,Work:0");
  // Creating a subfolder expands its parent.
  b.createFolder("a", "More", work);
  CHECK(ids(b.visibleRows("a")) == "Top:0,Work:0,Docs:1,Board:1,More:1");
}

static void pinningAnExistingUrlMovesIt() {
  Browser b(empty());
  const auto id = b.pinUrl("a", "Saved", "https://saved.test", std::nullopt);
  const auto folder = b.createFolder("a", "F", std::nullopt);
  CHECK(b.pinUrl("a", "Renamed?", "HTTPS://saved.test/", folder) == id);
  CHECK(ids(b.visibleRows("a")) == "F:0,Saved:1");
  // Same URL in another Space is a separate pin.
  CHECK(b.pinUrl("b", "Saved", "https://saved.test", std::nullopt) != id);
}

static void removingAFolderRemovesItsSubtree() {
  Browser b(empty());
  const auto outer = b.createFolder("a", "Outer", std::nullopt);
  const auto inner = b.createFolder("a", "Inner", outer);
  b.pinUrl("a", "Deep", "https://deep.test", inner);
  b.pinUrl("a", "Keep", "https://keep.test", std::nullopt);
  b.removePin(outer);
  CHECK(ids(b.visibleRows("a")) == "Keep:0");
  CHECK(b.snapshot().pins.size() == 1);
}

static void invalidOperationsAreRejected() {
  Browser b(empty());
  const auto link = b.pinUrl("a", "L", "https://l.test", std::nullopt);
  const auto folder = b.createFolder("a", "F", std::nullopt);
  CHECK(throws([&] { b.createFolder("a", "X", "missing"); }));
  CHECK(throws([&] { b.createFolder("a", "X", link); }));
  CHECK(throws([&] { b.createFolder("b", "X", folder); }));  // folder lives in another Space
  CHECK(throws([&] { b.pinUrl("missing", "X", "https://x.test", std::nullopt); }));
  CHECK(throws([&] { b.renamePin(link, "   "); }));
  CHECK(throws([&] { b.setActiveSpace("missing"); }));
  b.renamePin(link, "  Named ");
  CHECK(b.visibleRows("a")[0].title == "Named");
}

static void spacesKeepAtLeastOne() {
  Browser b(empty());
  b.pinUrl("b", "W", "https://w.test", std::nullopt);
  b.setActiveSpace("b");
  b.removeSpace("b");
  CHECK(b.snapshot().activeSpaceId == "a");
  CHECK(b.snapshot().pins.empty());
  CHECK(throws([&] { b.removeSpace("a"); }));
  const auto id = b.addSpace(" Study ", "");
  CHECK(b.snapshot().spaces.back().id == id && b.snapshot().spaces.back().name == "Study");
}

static void favoritesAreSharedAndDeduplicated() {
  Browser b(empty());
  const auto id = b.addFavorite("Mail", "https://mail.test");
  CHECK(b.addFavorite("Mail again", "https://MAIL.test/") == id);
  CHECK(b.snapshot().favorites.size() == 1);
  b.removeFavorite(id);
  CHECK(b.snapshot().favorites.empty());
}

static void searchRanksAcrossSpacesAndFolders() {
  Browser b(empty());
  const auto docs = b.createFolder("a", "Docs", std::nullopt);
  b.pinUrl("a", "Spec", "https://spec.test", docs);
  b.pinUrl("b", "Docs portal", "https://portal.test", std::nullopt);
  b.addFavorite("Doc favorite", "https://fav.test");
  const auto hits = b.search("doc", 10);
  CHECK(hits.size() == 3);
  CHECK(hits[0].kind == "favorite");
  CHECK(hits[1].title == "Docs portal" && hits[1].spaceId == "b");
  CHECK(hits[2].title == "Spec" && hits[2].subtitle == "Personal / Docs · spec.test");
  CHECK(b.search("doc", 1).size() == 1);
  CHECK(b.search("  ", 10).empty());
}

static void loadRepairsBrokenState() {
  Snapshot s = empty();
  s.activeSpaceId = "gone";
  s.pins = {
      {"f", "a", std::nullopt, "folder", "F", "", false},
      {"x", "a", "f", "link", "X", "https://x.test", false},
      {"orphan", "a", "missing", "folder", "O", "", false},
      {"orphan-child", "a", "orphan", "link", "OC", "https://oc.test", false},
      {"lost-space", "zzz", std::nullopt, "link", "L", "https://l.test", false},
      {"c1", "a", "c2", "folder", "C1", "", false},
      {"c2", "a", "c1", "folder", "C2", "", false},
  };
  Browser b(s);
  CHECK(b.snapshot().activeSpaceId == "a");
  const auto rows = ids(b.visibleRows("a"));
  CHECK(rows.find("F:0,X:1") == 0);
  CHECK(rows.find("O") == std::string::npos);
  CHECK(rows.find("C1") != std::string::npos && rows.find("C2") != std::string::npos);  // cycle broken, both visible
  Snapshot none;
  Browser fallback(none);
  CHECK(!fallback.snapshot().spaces.empty());
}

int main() {
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  const std::vector<std::pair<const char*, std::function<void()>>> tests = {
      {"urlKey normalises scheme, host, port and root path", urlKeyNormalises},
      {"parseInput matches the extension's Command Bar rules", parseInputMatchesExtension},
      {"nested folders render depth-first and hide collapsed subtrees", nestedFoldersRenderDepthFirst},
      {"pinning an existing URL moves it and keeps its identity", pinningAnExistingUrlMovesIt},
      {"removing a folder removes its subtree", removingAFolderRemovesItsSubtree},
      {"invalid operations are rejected", invalidOperationsAreRejected},
      {"Spaces keep at least one and move the active Space", spacesKeepAtLeastOne},
      {"Favorites are shared and deduplicated", favoritesAreSharedAndDeduplicated},
      {"search ranks across Spaces and folder paths", searchRanksAcrossSpacesAndFolders},
      {"load repairs orphaned and cyclic state", loadRepairsBrokenState},
  };
  for (const auto& [name, test] : tests) {
    const auto before = failures;
    test();
    std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", name);
    if (failures == before) ++passed;
  }
  std::printf("%d passed, %d failed\n", passed, failures);
  return failures == 0 ? 0 : 1;
}
