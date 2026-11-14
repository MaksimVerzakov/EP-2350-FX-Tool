# Agent Rules

1. **Worktree Isolation (One Chat = One Worktree)**:
   - Worktrees are managed on a **chat basis**: maintain **one worktree per chat/session** under `.worktrees/<branch-name>` (or a subagent workspace). All tasks, adjustments, and branch work within the same chat conversation take place in this single worktree rather than spawning multiple parallel worktrees.
   - **Always copy `.env` / `.env.local`** from the repository root into any newly created worktree so credentials, environment variables, and `GITHUB_TOKEN`/`GH_TOKEN` are always available.
   - **Clean up unused worktrees**: When a branch/PR is merged or a worktree is no longer needed, remove it (`git worktree remove --force .worktrees/<name>` and `git worktree prune`) to keep the repository clean.

2. **Branch & Pull Request Workflow (Never Push to `main`)**:
   - **NEVER commit or push directly to `main`**.
   - Always create a descriptive branch using prefixes:
     - `feat/<short-name>` for new features (triggers a **minor** version bump `x.Y.0` on merge)
     - `fix/<short-name>` for bug fixes or DSP/UI adjustments (triggers a **patch** version bump `x.y.Z` on merge)
     - `chore/<short-name>` or `docs/<short-name>` for maintenance/tooling
   - Push the branch to `origin` (`git push -u origin <branch-name>`).
   - **Always open the Pull Request yourself** using `gh pr create` (or the GitHub API with `GITHUB_TOKEN`/`GH_TOKEN` from `.env.local`). Write a detailed, complete markdown description of changes and output the PR link.
   - **UI PRs require Before/After screenshots**: Whenever a PR includes UI changes, capture Before (`main`) and After (branch) screenshots, host them on the dedicated `pr-assets` branch (e.g., `pr-<number>/before.png` and `pr-<number>/after.png`) so `main` stays free of binary assets, and embed a Before/After comparison table in the PR description.

3. **Conventional Commits & Tag-Driven Semantic Versioning (SemVer)**:
   - Use Conventional Commit messages (`feat: ...`, `fix: ...`, `feat!: ...` / `BREAKING CHANGE: ...`, `chore: ...`).
   - Do **not** hardcode version strings in UI components or manually bump `package.json` in feature branches (which avoids merge conflicts across parallel PRs).
   - When a PR is merged into `main`, `.github/workflows/deploy.yml` automatically reads the latest `vX.Y.Z` Git tag, computes the next version (`major`, `minor`, or `patch`), pushes the new `vX.Y.Z` tag, injects `__APP_VERSION__` at build time, and deploys the updated build to GitHub Pages.

4. **Incremental, Quota-Conscious Delivery (Small Contained PRs, One Milestone at a Time)**:
   - The user is on a quota-limited plan where token/turn limits can end mid-session.
   - **Never build multiple milestones in one giant batch or one monolithic PR.**
   - Break work into small, self-contained milestones where **each milestone is its own small, complete, tested, and mergeable PR**.
   - Complete, test, push, and open the PR for **one milestone at a time**, then pause and state the exact **Next Step** clearly so that if quota limits are reached, completed work is already safely in a mergeable PR and the next session can pick up seamlessly.
