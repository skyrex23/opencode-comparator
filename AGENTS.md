# Project Agent Rules

Project-specific guidance for AI agents.

## Commit Workflow

This project uses Conventional Commits (enforced by CI per `README.md`). Use the right type for the dominant change:

| Type       | Use for                                                                  | Examples in this repo                                              |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `feat`     | New or improved user-facing functionality                                | New column, new filter, renamed label with new semantics, tooltips |
| `fix`      | Correction of incorrect user-facing behaviour                            | Broken sort, inconsistent number formatting, wrong translation     |
| `perf`     | Performance improvement                                                  | Reduce snapshot fetch time, speed up initial page render           |
| `refactor` | Code restructuring with NO user-visible change                           | Extract helper, rename internal function only                      |
| `style`    | Code-style only — formatting, whitespace, prettier. NEVER for UI changes | Prettier reformat, indent fix                                      |
| `test`     | Tests only                                                               | New test, fix flaky test                                           |
| `docs`     | Documentation only                                                       | README, in-code doc comments                                       |
| `chore`    | Internal housekeeping, tooling, snapshot refresh                         | `npm run refresh`                                                  |
| `build`    | Build system or external dependencies                                    | Dependency bumps, changes to `package.json` scripts                |
| `ci`       | CI/CD configuration changes                                              | `.github/workflows/*` changes                                      |
| `revert`   | Reverts a previous commit                                                | `git revert` of a bad commit                                       |

### Critical distinctions

- **User-facing changes are NEVER `refactor` or `style`.** If the user sees something different — new label, new
  tooltip, layout change, renamed button — use `feat` (new/improved) or `fix` (bug).
- **`style` is reserved for non-UI code-style.** Prettier reformatting, indent fixes. Renaming a CSS class for clarity
  is `refactor`. Renaming a UI label is `feat`.
- **Renames that change user-facing text are `feat`.** Example: renaming the "Value" column to "Score" was `feat`
  because the column label changed and the semantics shifted (no longer implied model quality).
- **`fix` requires a real bug.** A user-visible inconsistency (same `.` meaning thousands in one place and decimals in
  another) is a `fix`, not a `refactor`.

### Important notes

- **Gather context and draft, then present before committing.** Pull the current diff, draft a Conventional Commits
  message and present both the message and the file list. Wait for explicit OK before running `git commit`.
- **When the user requests changes to a proposal, re-show the updated version.** Never commit a modified proposal
  without a fresh confirmation.
- **Keep commits focused.** One logical concern per commit. If multiple unrelated concerns, propose a split.
