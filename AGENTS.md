# AGENTS.md

## Pull requests

- Unfinished work goes on a feature branch (`codex/<feature>`) and gets a **draft** PR: `gh pr create --draft --base main`.
- Always open PRs as drafts, even when the work looks finished. The user marks them ready for review.
- Draft PR body: what changed, what is unfinished or untested, how to try it.
- Don't push unfinished features straight to `main`.

## Commits

- Commit as `Anton Krylov <zhychek1@yandex.ru>` (already set in the repo's git config).
- Bump `version` in `package.json` and `public/manifest.json` for user-visible releases, and put it in the commit title as `(v1.x.y)`.

## Checks before pushing

- `npm run build`
- `npm test`
