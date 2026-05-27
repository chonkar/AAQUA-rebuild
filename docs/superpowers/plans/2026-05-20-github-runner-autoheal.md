# GitHub-driven Automation Runs + Auto-Healing

Status: **Plan only — not started.** Drafted 2026-05-20.

**Why:** The codebase already has the building blocks — `Project.git_url` column, `detectFramework → findProjectRoot → runCommand` pipeline, and `/api/apply-heal` writing to a generic `projectRoot`. Cloning from GitHub just produces another project root, so most of the runner pipeline is reusable. The goal: (a) trigger runs from a GitHub repo and (b) have auto-heal work on those runs, optionally pushing patches back as PRs.

**How to apply:** Follow the phase order below. Phases 1–4 deliver the core "run my GitHub suite, heal locally" capability; Phase 5 is the enterprise PR-creation tier — don't build it until 1–4 are stable.

## Architectural decisions (settle BEFORE any code)

| Decision | Recommendation | Reason |
|---|---|---|
| Clone strategy | Native `git` via `child_process.spawn` | No new deps; `nodegit` has painful Windows binary install |
| Auth model | Public + optional per-project PAT (encrypted column) | Start simple; GitHub App is Phase 3+ |
| Branch/ref | Store `git_default_ref` on Project; per-run override | CI parity |
| Workspace lifecycle | Clone once, `git fetch && reset --hard` per run | Faster iteration; bare-clone+worktree later if concurrency needed |
| Heal write-back | Patch local clone by default; opt-in commit-and-push as a separate "Propose PR" action | Never auto-push to default branch |
| Secret storage | Per-project encrypted column (AES-256-GCM) | Multi-tenant friendly |

## Phase plan

**Phase 1 (1–2 days) — Project model + UI for git URL/auth**
- `server/models/Project.js` — add `git_default_ref` (default `'main'`), `git_auth_type` ENUM `'none'|'pat'`, `git_token_encrypted` TEXT.
- `server/utils/crypto.js` *(new)* — AES-256-GCM helpers keyed off `process.env.PROJECT_SECRET_KEY`.
- `server/routes/projectRoutes.js` — accept new fields; encrypt token before save; return only `has_git_token` boolean.
- `src/components/common/Header.jsx` — add git fields to the "Create New Project" modal.
- `src/pages/ReleaseReadiness.jsx:232` — already displays `git_url`; show default ref too.

**Phase 2 (2–3 days) — Backend clone + run pipeline**
- `server/services/gitService.js` *(new)* — `ensureWorkspace(project, ref, runId, log)`. First call: shallow clone into `temp_runner/git/<projectId>/<ref>`. Subsequent: `git fetch && git reset --hard FETCH_HEAD && git clean -fdx`. Inject PAT as `https://x-access-token:<pat>@github.com/...` via stdin or env (never argv — leaks in `ps`). Stream output through the provided `log()` callback (same pattern as scan logs).
- `server/index.js` — `POST /api/run-tests-github` accepts `{ projectId, ref?, isHeadless?, headed? }`. Calls `ensureWorkspace`, then reuses existing framework pipeline. **Refactor first:** extract `runFrameworkPipeline(run, isHeadless)` so local-path, zip-upload, and github paths all share the Maven/Playwright/Cypress completion handlers (no duplication).
- `persistRunToReadiness` already takes `projectId` → AutomationResult + readiness recompute work automatically.

**Phase 3 (1 day) — Frontend GitHub source tab**
- `src/services/testRunnerService.js` — `runTestsGithub(projectId, ref, isHeadless)`.
- `src/pages/TestRunner.jsx` — top-level radio/tab: `Local path | Upload ZIP | GitHub`. When GitHub picked, show read-only `git_url` from `useProject()`, editable `ref` prefilled with `git_default_ref`, warning if `has_git_token === false` for private-looking URL. Polling/logs/heal panel all key off `runId` — reuse unchanged.

**Phase 4 (0.5 day) — Auto-heal works on GitHub runs (verification only)**
- No code changes needed — `/api/apply-heal` at `server/index.js:2987` writes to `projectRoot`, which is now the cloned workspace.
- Add UI notice in heal banner: *"Patches are applied to the local clone. Use 'Propose PR' below to push back to GitHub."*

**Phase 5 (2–3 days, opt-in) — Push heals as PRs**
- `server/services/gitService.js` — `commitAndPushHeal(workspacePath, branchName, message, token)` and `openPullRequest(repoFullName, head, base, title, body, token)` (GitHub REST `POST /repos/:owner/:repo/pulls`).
- `server/index.js` — `POST /api/auto-heal/propose-pr` given a runId: derive workspace, detect patched files via `git status --porcelain`, decrypt project PAT, branch `aaqua/auto-heal/<runId>`, commit + push, open PR with AI heal reasoning in body. Return PR URL.
- `src/pages/TestRunner.jsx` — "Propose PR" button on heal results panel; disabled unless `project.git_url && has_git_token`.

## Risks / gotchas

1. **Windows + credentials in URL** — never log the token-bearing URL. Use `git -c credential.helper=` to suppress Windows credential manager popups.
2. **`git clean -fdx` is destructive** — entire `temp_runner/git/` tree must be treated as ephemeral. Document in CLAUDE.md.
3. **PAT scopes** — minimum `repo`; add `workflow` if any healed file is under `.github/`. Surface in UI tooltip.
4. **Concurrency** — two simultaneous runs on same `<projectId>/<ref>` race on the working tree. Either per-workspace mutex in `gitService`, or move to bare-clone+worktree-per-run.
5. **Disk pressure** — schedule prune (e.g. `find temp_runner/git -maxdepth 3 -type d -atime +7 -exec rm -rf {} +`) alongside existing scan retention sweep.
6. **Heal UX gotcha** — re-running from GitHub while a heal proposal is open triggers `git reset --hard`, throwing away unpushed patches. Block re-runs while dirty, or warn the user.

## Related context

- Project CRUD lives at `/api/projects` (not `/api/security/projects`).
- Test Runner persists `AutomationResult` → triggers `calculateAndSaveReadiness` for the selected project. GitHub runs inherit this for free as long as `projectId` is in the run record.
- Auto-heal write-back currently overwrites `sourceFile` after backing it up to `sourceFile.bak` at `server/index.js:2987` — Phase 5 PR creation reads from these patched files via `git status --porcelain`.
- Shares the encrypted per-project credential store with the 2026-05-21 API/BPMN test-gen plan.
