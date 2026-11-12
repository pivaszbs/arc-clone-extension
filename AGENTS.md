# AGENTS.md

## Pull requests

- Unfinished work goes on a feature branch (`codex/<feature>`) and gets a **draft** PR: `gh pr create --draft --base main`.
- Always open PRs as drafts, even when the work looks finished. The user marks them ready for review.
- Draft PR body: what changed, what is unfinished or untested, how to try it.
- Don't push unfinished features straight to `main`.

## Commits

- Commit as `Anton Krylov <zhychek1@yandex.ru>` (already set in the repo's git config).
- Bump `version` in `package.json` and `public/manifest.json` for user-visible extension releases, and put it in the commit title as `(v1.x.y)`.
- Bump `version` in `tv/samsung/config.xml` when updating the Samsung TV app, then run `npm run build:tv`.
- Bump `THEME_DETECTOR_VERSION` in `src/japanese/video-themes.ts` whenever OP/ED/Recap detector logic changes so the app prompts to reprocess existing series.

## Checks before pushing

- `npm run build`
- `npm test`
