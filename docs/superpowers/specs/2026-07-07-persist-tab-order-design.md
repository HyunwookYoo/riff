# Persist repo tab order — design

## Problem
Repo tabs (main + submodules + manual repos) can be reordered by drag in the
shared `RepoTabs` strip (Changes / History). `reorderRepo()` is **session-only**:
the new order lives only in `appState.repos` and is discarded when the repo is
reopened (`buildWorkspace` rebuilds the default order) or the app restarts. Users
want their adjusted order remembered.

## Scope
One saved order **per main repo**, applied everywhere the tabs appear (Changes +
History share `appState.repos`), persisted across restarts. Not per-mode.

## Storage
Reuse the existing per-main persistence pattern (`manual_repos_by_main` in
`state.json`). New field:

```rust
tab_order_by_main: HashMap<String, Vec<String>>  // main path -> ordered non-main repo paths
```

Main (index 0) is always pinned, so only non-main paths are stored.

## Data flow
1. **Save** — in `reorderRepo()`, after computing the reordered `next`, persist
   `next.slice(1).map(r => r.path)` to `appState.tabOrderByMain[main]` and call
   `setTabOrder(main, order)` (fire-and-forget). An empty list removes the entry
   backend-side (tidy).
2. **Restore** — `buildWorkspace(mainPath, manualPaths, savedOrder)` gains a 3rd
   arg. It builds the default order (main → submodules in `.gitmodules` order →
   manuals in saved order), then stable-sorts the non-main entries by their index
   in `savedOrder`. Paths not in `savedOrder` (newly discovered submodule / newly
   added manual) sort to the end, preserving default relative order.
3. **Startup mirror** — `+page.svelte onMount`:
   `appState.tabOrderByMain = s.tab_order_by_main ?? {}`.

## Selection-index integrity
The applied order preserves the relative order of already-displayed repos, so
existing tab indices (`changesRepoIdx` / `historyRepoIdx` / `activeRepoIdx`) stay
as stable as they are today across add/remove. `reorderRepo` already remaps
selections by path. No new remap needed in add/remove paths. The pre-existing
index shift on manual-repo removal is unrelated and left untouched.

## Changed files
- `src-tauri/src/store/mod.rs` — field + `set_tab_order()` (empty list ⇒ remove key)
- `src-tauri/src/lib.rs` — `#[tauri::command] set_tab_order` + invoke_handler registration
- `src/lib/types.ts` — `PersistedState.tab_order_by_main?`
- `src/lib/store.svelte.ts` — `tabOrderByMain` state mirror
- `src/lib/git.ts` — `setTabOrder(mainRepo, order)`
- `src/lib/workspace.ts` — `buildWorkspace` 3rd arg + `applyTabOrder` helper +
  `reorderRepo` persistence + 3 call sites pass saved order

## Out of scope (YAGNI)
- Pruning stale paths (removed manual repo) from the order map — harmless; ignored
  on apply, and re-adding restores the remembered position.
- Per-mode order separation.
