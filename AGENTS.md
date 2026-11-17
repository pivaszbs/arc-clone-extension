# AGENTS.md

## Branches

- Work directly on `main`. Don't create feature branches or worktrees, and don't open PRs.
- Commit finished, working changes to `main` with a clear message. Run the checks below first.

## Commits

- Commit as `Anton Krylov <zhychek1@yandex.ru>` (already set in the repo's git config).
- Bump `version` in `package.json` and `public/manifest.json` for user-visible extension releases, and put it in the commit title as `(v1.x.y)`.
- Bump `version` in `tv/samsung/config.xml` when updating the Samsung TV app, then run `npm run build:tv`.
- Bump `THEME_DETECTOR_VERSION` in `src/japanese/video-themes.ts` whenever OP/ED/Recap detector logic changes so the app prompts to reprocess existing series.

## Checks before pushing

- `npm run build`
- `npm test`
