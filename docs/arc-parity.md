# Arc functionality and extension comparison

Researched 10 November 2026. Reference application installed on this machine: Arc 1.172.1. Comparison host installed: Google Chrome 157.0.8103.39. Automated test browser: the Chrome for Testing version installed by Playwright.

## Existing implementations

| Project | What it provides | Decision |
| --- | --- | --- |
| [Arcify](https://github.com/nisargkolhe/arcify) | An existing Chrome sidebar extension focused on Arc-style tab management. GPL-3.0. | Closest extension alternative found. A useful reference if replacing this extension is preferable. No code copied. |
| [Bushido](https://github.com/visualstudioblyat/bushido) | Rust/Tauri browser with a React interface and system WebView rendering. Its README describes workspaces, split layouts, and built-in filtering. GPL-3.0. | A Rust alternative, rather than an exact Arc clone. Adopting it would replace the existing extension with a separate browser. Its README still lists cross-platform builds as future work. No unverified performance or privacy claims adopted. |
| [Zen](https://github.com/zen-browser/desktop) | An open-source desktop browser with an established repository and a Firefox-based architecture. | Another standalone browser to evaluate, rather than an extension foundation. |
| This repository | Existing Svelte/TypeScript Manifest V3 extension, working command palette, sidebar, webpage overlay, and Japanese-learning tools. | Retained at the user's request. Reusing it preserves the existing tools and installation workflow. |

Repository availability and documented functionality were checked; these alternatives were not installed, audited, or benchmarked. No paid service is needed for the core extension.

## Functionality inventory

Arc behavior was checked against its [official command list](https://start.arc.net/command-bar-actions), [focus and multitasking guide](https://start.arc.net/find-focus), and [macOS release notes](https://resources.arc.net/hc/en-us/articles/20498293324823-Arc-for-macOS-2022-Release-Notes). Features vary by OS and release. Historical documentation does not establish availability in every current Arc build.

| Arc functionality | Extension implementation | Verification and remaining difference |
| --- | --- | --- |
| Vertical sidebar | Native Chrome side panel and injected webpage sidebar | Actual extension UI tested. Chrome still owns its browser frame and horizontal tab strip. |
| Spaces | Named, themed workspaces with separate Today lists | Cucumber creates and switches Spaces, checks persistence, and moves a tab. Browser tabs remain visible to Chrome itself. |
| Space icons and colors | Emoji selection and six existing gradient themes | Space creation uses the default theme; individual color-picker variations are not exhaustively tested. |
| Favorites | Shared icon tiles across Spaces | Cucumber checks shared visibility. Favorites do not have isolated account profiles. |
| Pinned tabs | Per-Space saved URLs with tracked live-tab identity | Cucumber checks separation from Today, renaming, navigation, and URL reset. |
| Folders | Collapsible pinned folders, one folder level | Cucumber creates and collapses a folder. Arbitrarily nested folders are not implemented. |
| Today | Unpinned web tabs belonging to the active Space | Cucumber checks Space filtering and movement. Extension tool pages are excluded. |
| Clear Today | Closes inactive Today tabs and saves recoverable HTTP(S) entries | Cucumber checks saved pins survive, archive search, and restore. Active tabs are intentionally retained; verify this difference against your preferred Arc behavior. |
| Timed auto archive | Real Chrome alarm, checked every minute; never/12h/24h/7d/30d options | Cucumber exercises the real alarm with a shortened interval. Active, audible, pinned, and saved pages are protected. |
| Archive | Local persistent records with search and restore to the original Space | Cucumber restores via the drawer. If the Space was deleted, restores into the active Space. No automatic archive retention expiry. |
| Reset Space | Returns linked open pins to their saved URLs | Tested through the command palette. Unopened pins stay unopened. |
| Command bar | Shared keyboard-search UI for tabs, saved URLs, history, bookmarks, actions and navigation | Cucumber exercises URL entry, existing-tab reuse, reset action, focus, and Escape. Chrome reserves some native shortcuts. |
| Peek | Modified-click preview in a webpage overlay with expand/popup actions | Cucumber loads a real local destination inside the iframe and checks parent navigation. Sites can prohibit embedding. Does not automatically open every external link from pinned tabs as native Arc does. |
| Little Arc | Separate popup window | Cucumber verifies the browser window type and URL. Arc's native external-link routing is not reproduced. |
| Split View | Calls the native extension Split View API when the browser exposes it | Cucumber verifies real split IDs when supported and an explicit error otherwise. Two adjacent tabs with matching window/group/pin state are required. Arc-style persistent four-pane layouts are not implemented. |
| Sidebar focus/hover | Existing pinned, hover, and off modes | Existing UI; not part of the current automated comparison. |
| Copy link | Existing clipboard action | Existing UI; not part of the current automated comparison. |
| Tab mute, duplicate and ordering | Existing handlers and controls | Existing code; not all interactions covered by Cucumber. |
| Profiles/account isolation | Host browser profile only | Separate per-Space cookies, history, passwords, and extensions are not implemented. An extension cannot create Chrome profiles. |
| Air Traffic Control | No URL-to-Space routing rules | Not implemented. |
| Site Search | No saved site-search templates | Not implemented. |
| Boosts | No per-site style editor | Not implemented. |
| Easels, captures, library | No corresponding authoring or media library | Not implemented. |
| Favorite app previews | No authenticated Gmail/calendar/etc. preview integrations | Not implemented. |
| Sync across devices | Local extension storage | No Arc account or encrypted sync service. |
| Arc Max/AI | No Arc Max service | Existing unrelated voice/Japanese tools are not claimed as Arc Max equivalents. |
| Video picture in picture | Per-video native PiP control for standard HTML video, including dynamic videos and allowed iframes | Cucumber checks native enter/exit, external close, multiple videos, keyboard activation, blocked requests, opt-outs, and persistence across tab switches. Opens on request; automatic PiP is not implemented. The macOS companion adds an Across desktops mode with a non-activating auxiliary panel. Actual full-screen Finder/desktop transitions were checked through the native window API; see [the OS verification](pip-macos-spaces.md). |
| Browser internals | Uses Chrome's existing downloads, security, history and developer tools | No replacement rendering engine, ad blocker, or browser update system. |

The Split View implementation follows [Chrome's API documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs) and [the official introduction](https://developer.chrome.com/blog/split-view-api-extensions). Runtime detection is required even when a browser reports a recent Chromium version. Chrome's [side panel documentation](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) defines the native panel boundary.

## Native Arc visual reference

Arc was inspected through its native accessibility tree and a local screenshot. Observed elements included icon-tile Favorites, a Space heading, vertical tab rows, a bottom Space switcher, the new-tab control, a URL toolbar, and the split-view menu. Its File menu exposed the command bar, Little Arc, profile creation, Easel creation, and capture actions.

The user's installed Arc uses a light green theme. The extension retains its existing dark themes and compact sidebar styling. This is an Arc-inspired implementation, not a pixel-identical reproduction of that theme. The private Arc screenshot was not copied into this repository.

Arc failed to establish a Playwright connection when launched with an isolated test profile and debugging pipe. No personal Arc profile was copied or reconfigured. Native macOS browser chrome is also outside Playwright's DOM locator interface. Consequently the automated runs compare the extension in Chrome and Chrome for Testing, **not native Arc against Chrome**. This remains an unmet part of the original request.

## Running the comparison

```sh
npm install
npx playwright install chromium
npm run check
npm test
npm run test:e2e
```

Google Chrome must also be installed for the second default run. Set `E2E_BROWSERS=chromium` for the bundled browser alone, or `HEADED=1` to inspect test windows. Both default targets use Chromium; this is not a two-engine portability test.

`npm run test:e2e:arc` attempts the Arc executable, with `ARC_EXECUTABLE` available as an override. It is expected to fail on the installed Arc version. It does not mark native parity as passing or silently substitute another browser.

Each scenario creates a disposable browser profile, installs the actual built extension through the browser's extension-debugging interface, uses a local HTTP fixture, and closes its profile. This does not install into the user's everyday browser. Reports and screenshots are written under `artifacts/e2e/`; failures also save a Playwright trace. `comparison.json` requires the same named scenarios in both runs and records their individual pass/fail results. Assertions check each workflow's actual outcome. Screenshots are review artifacts, not pixel-diff assertions.

Some setup and state assertions use the real extension messaging API. These are not all exclusively mouse-driven tests. User-facing creation, rename, clear, archive restore/search, settings, command-bar, and Peek actions go through their rendered controls.

## Native comparison still required

For exact native parity, run matching scenarios against a dedicated Arc test profile using a native macOS automation driver. Compare behavior separately from visual geometry. Do not reuse a personal profile or infer a pass from documentation. Additional work is needed for profiles, routing, nesting, Boosts, Easels, sync, app previews, native frame controls, and the differences listed above.
