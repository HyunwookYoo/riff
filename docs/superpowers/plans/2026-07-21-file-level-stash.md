# File-level Stash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stash a single file's working-tree changes from the Changes list, without disturbing other files.

**Architecture:** Give the existing `stash_save` backend method an optional pathspec argument (mirroring how `stage` takes a nullable file list), thread it through the `git.ts` binding and the `doStashSave` helper, and add a "Stash this file…" item plus an inline message field to the Changes-list context menu. No new backend command, no new frontend module. The pathspec form `git stash push -u -m <msg> -- <path>` was verified empirically to capture exactly the named file (including an untracked one) and leave every other change in the working tree.

**Tech Stack:** Tauri 2 (Rust) + SvelteKit + Svelte 5 runes (`$state`) + TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-21-file-level-stash-design.md`

## Global Constraints

- **`stash_save`'s new `paths` argument follows `stage`'s exact convention:** `None`/`null` runs the whole-tree form (today's behavior, byte-for-byte); a list validates each entry with `validate_path`, then runs `git stash push … -- <paths>`.
- **Backend mutation convention** (`cli.rs`): the method already holds `let _w = self.write_lock.lock().unwrap();` and calls `self.drop_session()` after the run — keep both; add nothing that takes the lock twice.
- **`include_untracked` stays `true`** for the file-level path (as the sidebar `＋` already passes), so an untracked file can be stashed; the pathspec scopes the untracked sweep to that file.
- **Empty inline message defaults to the file path** as the stash subject, so the entry is identifiable in the sidebar Stashes list.
- **Never use native `window.confirm()`** — not needed here (no confirm in this feature), but if one is ever added use `confirmAction` from `$lib/dialogs`.
- **Do not reintroduce a stage/unstage list** or touch the changelists model beyond reading a file path.
- **Gates that must stay green:** `npm test`, `npm run check` (0 errors; the one pre-existing benign `@types/node` warning is allowed), and `cargo check` (from `src-tauri/`).
- Out of scope, must not appear: hunk-level/partial-within-file stash, changelist-level stash, multi-file-selection stash.

---

## File Structure

**Backend (`src-tauri/src/`)**
- `git/mod.rs` — modify: add `paths: Option<&[String]>` to the `stash_save` trait signature (and its doc comment).
- `git/cli.rs` — modify: add the pathspec block to the `stash_save` impl.
- `lib.rs` — modify: the `stash_save` `#[tauri::command]` gains `paths: Option<Vec<String>>` and passes `paths.as_deref()`.

**Frontend (`src/lib/`)**
- `git.ts` — modify: `stashSave` binding gains a `paths: string[] | null` argument.
- `sourceControl.ts` — modify: in Task 1, keep the sole caller compiling by passing `null`; in Task 2, `doStashSave` gains an optional `paths?` argument.
- `ui/ChangesList.svelte` — modify: import `doStashSave`; add the stash state + handlers; add the context-menu item; render the inline message form; add CSS.

**Task order:** 1 → 2 (2 needs Task 1's `paths` argument on `stashSave` and the backend command) → 3 (human gate). Run in numeric order.

**Note on the sole caller:** `stashSave` (the `git.ts` binding) is called in exactly one place — `sourceControl.ts:498`, inside `doStashSave`. The sidebar `＋` and the palette both call `doStashSave`, never `stashSave` directly. So Task 1 keeps the gate green by touching that one call site.

---

## Task 1: Backend — `stash_save` gains a pathspec

**Files:**
- Modify: `src-tauri/src/git/mod.rs` (trait signature + doc, the `fn stash_save` around line 489)
- Modify: `src-tauri/src/git/cli.rs` (impl, the `fn stash_save` around line 2065)
- Modify: `src-tauri/src/lib.rs` (command wrapper, around line 481)
- Modify: `src/lib/git.ts` (`stashSave` binding)
- Modify: `src/lib/sourceControl.ts` (the sole `stashSave` call, line 498 — pass `null` to keep the gate green)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `stashSave(path: string, message: string | null, includeUntracked: boolean, paths: string[] | null): Promise<void>` in `src/lib/git.ts`, backed by a `stash_save` tauri command that accepts `paths: Option<Vec<String>>`. Task 2 calls it with a real path list.

- [ ] **Step 1: Update the trait signature**

In `src-tauri/src/git/mod.rs`, replace the `stash_save` trait declaration (its doc comment and signature) with:

```rust
    /// Save the working tree to a new stash (`git stash push`). `message` sets a
    /// custom subject; `include_untracked` also stashes untracked files. `paths`
    /// limits the stash to those pathspecs (`… -- <paths>`); `None` stashes the
    /// whole working tree (mirrors `stage`).
    fn stash_save(
        &self,
        path: &Path,
        message: Option<&str>,
        include_untracked: bool,
        paths: Option<&[String]>,
    ) -> Result<(), GitError>;
```

- [ ] **Step 2: Update the `GitCli` implementation**

In `src-tauri/src/git/cli.rs`, replace the whole `fn stash_save` impl with:

```rust
    fn stash_save(
        &self,
        path: &Path,
        message: Option<&str>,
        include_untracked: bool,
        paths: Option<&[String]>,
    ) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        if let Some(m) = message {
            if !m.trim().is_empty() {
                args.push("-m");
                args.push(m);
            }
        }
        // A pathspec limits the stash to the named files (mirrors `stage`).
        // `None` keeps the whole-tree behavior; `--` guards paths that look
        // like options, and validate_path rejects the obviously-malformed.
        if let Some(ps) = paths {
            for p in ps {
                validate_path(p)?;
            }
            args.push("--");
            args.extend(ps.iter().map(String::as_str));
        }
        self.run(path, &args)?;
        self.drop_session();
        Ok(())
    }
```

- [ ] **Step 3: Update the tauri command wrapper**

In `src-tauri/src/lib.rs`, replace the `stash_save` command with:

```rust
#[tauri::command]
async fn stash_save(
    state: tauri::State<'_, GitCli>,
    path: String,
    message: Option<String>,
    include_untracked: bool,
    paths: Option<Vec<String>>,
) -> Result<(), GitError> {
    state.stash_save(
        Path::new(&path),
        message.as_deref(),
        include_untracked,
        paths.as_deref(),
    )
}
```

- [ ] **Step 4: Verify the backend compiles**

Run: `cd src-tauri && cargo check`
Expected: finishes with no errors (unrelated warnings are acceptable).

- [ ] **Step 5: Update the JS binding**

In `src/lib/git.ts`, replace the `stashSave` function with:

```ts
/**
 * Save the working tree to a new stash. `paths = null` stashes everything;
 * an array stashes just those pathspecs (`git stash push -- <paths>`).
 */
export function stashSave(
  path: string,
  message: string | null,
  includeUntracked: boolean,
  paths: string[] | null,
): Promise<void> {
  return invoke("stash_save", { path, message, includeUntracked, paths });
}
```

- [ ] **Step 6: Keep the sole caller compiling**

In `src/lib/sourceControl.ts`, the one call to `stashSave` (line 498) currently reads:

```ts
    await stashSave(changesRepoPath(), message ?? null, true);
```

Change it to pass the new argument (Task 2 replaces `null` with a real value):

```ts
    await stashSave(changesRepoPath(), message ?? null, true, null);
```

- [ ] **Step 7: Verify the frontend typechecks**

Run: `npm run check`
Expected: `0 errors`. One pre-existing `@types/node` warning is allowed.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/git/mod.rs src-tauri/src/git/cli.rs src-tauri/src/lib.rs src/lib/git.ts src/lib/sourceControl.ts
git commit -m "feat(stash): stash_save accepts a pathspec"
```

---

## Task 2: `doStashSave` pathspec + the Changes-list "Stash this file" UI

**Files:**
- Modify: `src/lib/sourceControl.ts` (`doStashSave` signature + call)
- Modify: `src/lib/ui/ChangesList.svelte` (import, state, handlers, context-menu item, inline form, CSS)

**Interfaces:**
- Consumes: `stashSave(path, message, includeUntracked, paths)` from Task 1; the pre-existing `changesRepoPath()`, `refreshActiveView()`, `loadStashes()`.
- Produces: `doStashSave(message?: string, paths?: string[]): Promise<void>` — Task 2's UI calls `doStashSave(m, [path])`; the existing sidebar/palette callers keep calling `doStashSave()` (whole tree).

**Context the implementer needs:**
- `doStashSave` is the only caller of `stashSave`; the sidebar `＋` and palette both call `doStashSave` with no args (whole tree). Adding an optional `paths?` argument leaves them untouched.
- ChangesList already has the exact inline-editor idiom to copy: `creating`/`createName` (new-changelist) and `editingId`/`editName` (rename) each use an autofocus `<input>` in a small form, Enter to submit, Escape to cancel.
- The per-file context menu is `moveMenu`, opened by `openMove`, and `moveTo` closes it by setting `moveMenu = null`. Follow `moveTo`'s pattern (read `moveMenu` inside the handler behind an `if (moveMenu)` guard) rather than capturing it in the click closure — that avoids a "possibly null" typecheck error.
- **No `onblur` submit on the stash field** (unlike the changelist-create form): a blur-to-stash would set aside a file on an accidental focus loss. Enter submits, Escape cancels; that is deliberate.

- [ ] **Step 1: Give `doStashSave` an optional `paths` argument**

In `src/lib/sourceControl.ts`, replace the `doStashSave` function (its signature line and the `stashSave` call) so it reads:

```ts
/// Stash the working tree (including untracked) under an optional message.
/// `paths` limits the stash to those files; omit it to stash everything.
export async function doStashSave(
  message?: string,
  paths?: string[],
): Promise<void> {
  appState.error = null;
  try {
    await stashSave(changesRepoPath(), message ?? null, true, paths ?? null);
  } catch (e) {
    appState.error = String(e);
  }
  const err = appState.error;
  await refreshActiveView();
  await loadStashes();
  if (err) appState.error = err;
}
```

- [ ] **Step 2: Import `doStashSave` into ChangesList**

In `src/lib/ui/ChangesList.svelte`, change the `$lib/sourceControl` import block so it reads:

```ts
  import {
    conflictedEntries,
    discardPath,
    doStashSave,
    entryToChangedFile,
    selectChange,
  } from "$lib/sourceControl";
```

- [ ] **Step 3: Add the stash state and handlers**

In the same file, immediately after the `moveTo` function (the `moveMenu` handler that ends with `moveMenu = null; }`), insert:

```ts
  // Stash a single file: open an inline message field, then stash just that
  // path. An empty message defaults to the path, so the entry is identifiable.
  let stashingPath = $state<string | null>(null);
  let stashMsg = $state("");
  function openStash() {
    if (!moveMenu) return;
    stashingPath = moveMenu.path;
    stashMsg = "";
    moveMenu = null;
  }
  function submitStash() {
    const path = stashingPath;
    stashingPath = null;
    if (!path) return;
    const m = stashMsg.trim() || path;
    stashMsg = "";
    void doStashSave(m, [path]);
  }
```

- [ ] **Step 4: Add the context-menu item**

In the same file's `{#if moveMenu}` block, immediately after the `{/each}` that renders the changelist buttons and before the menu's closing `</div>`, insert:

```svelte
    <div class="cl-menu-sep"></div>
    <button type="button" role="menuitem" onclick={openStash}>
      Stash this file…
    </button>
```

- [ ] **Step 5: Render the inline message form**

In the same file, immediately after the `<div class="cl-root">` opening tag (before `<div class="cl-toolbar">`), insert:

```svelte
  {#if stashingPath}
    <form class="cl-stash" onsubmit={(e) => (e.preventDefault(), submitStash())}>
      <span class="cl-stash-label" title={stashingPath}>Stash {stashingPath}:</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        bind:value={stashMsg}
        placeholder="message (optional)"
        aria-label="Stash message"
        onkeydown={(e) =>
          e.key === "Escape" && ((stashingPath = null), (stashMsg = ""))}
      />
    </form>
  {/if}
```

- [ ] **Step 6: Add the CSS**

In the same file's `<style>` block, immediately after the `.cl-menu button:disabled { … }` rule, insert:

```css
  .cl-menu-sep {
    height: 1px;
    background: var(--border);
    margin: 4px 0;
  }
  .cl-stash {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
  }
  .cl-stash-label {
    flex: 0 0 auto;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8em;
    color: var(--muted);
    font-family: var(--mono);
  }
  .cl-stash input {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    padding: 4px 8px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.85em;
  }
```

- [ ] **Step 7: Verify it typechecks**

Run: `npm run check`
Expected: `0 errors`.

- [ ] **Step 8: Verify the existing suite still passes**

Run: `npm test`
Expected: all tests pass (this task adds no tests — it is UI wiring, which riff does not unit-test).

- [ ] **Step 9: Commit**

```bash
git add src/lib/sourceControl.ts src/lib/ui/ChangesList.svelte
git commit -m "feat(stash): Stash this file from the Changes list"
```

---

## Task 3: Manual E2E verification (human merge gate)

**Files:** none — a human verification pass against a running app.

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: the go/no-go decision for merging.

This exists because riff does not unit-test git operations or Svelte UI, so the end-to-end git result is only provable by running the app.

- [ ] **Step 1: Confirm the automated gates are green**

Run: `npm test && npm run check`
Expected: all tests pass; `0 errors`.

Run: `cd src-tauri && cargo check`
Expected: no errors.

- [ ] **Step 2: Start the app**

Run: `npm run tauri dev`
Expected: the riff window opens against a test repository.

- [ ] **Step 3: Verify a named single-file stash**

1. Modify two tracked files, A and B.
2. Right-click file A in the Changes list → **Stash this file…**.
3. Type `just A` in the inline field and press Enter.
4. Expected: a stash named `just A` appears in the sidebar's Stashes section; file A's change leaves the Changes list; **file B's change remains**.

- [ ] **Step 4: Verify the empty-message default**

1. Modify a tracked file C.
2. Right-click C → Stash this file… → press Enter with the field **empty**.
3. Expected: a stash appears whose subject is C's path (e.g. `src/…/C.ext`), not git's generic `WIP on …`.

- [ ] **Step 5: Verify an untracked file stashes**

1. Create a new, untracked file D and confirm it shows in the Changes list.
2. Right-click D → Stash this file… → Enter.
3. Expected: D is stashed (it disappears from the Changes list); popping the stash from the sidebar brings D back.

- [ ] **Step 6: Verify Escape cancels**

1. Right-click any file → Stash this file… → press Escape.
2. Expected: the inline field closes and nothing is stashed.

- [ ] **Step 7: Verify no regression to whole-tree stash**

1. With several files changed, click the sidebar Stashes `＋`, enter a message, and submit.
2. Expected: the whole working tree is stashed (all changed files), exactly as before.
3. Also run the palette "Stash: save changes" and confirm it still stashes everything.

- [ ] **Step 8: Record the result**

If every check passed, the branch is ready to merge. If any failed, capture what happened and fix it before merging — do not merge on a partial pass.

---

## Self-Review

Checked after writing, against `docs/superpowers/specs/2026-07-21-file-level-stash-design.md`:

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 `stash_save` gains nullable `paths`, `--` + `validate_path`, `None` = whole tree | Task 1 |
| §2 `git.ts` binding + `doStashSave(message?, paths?)` | Task 1 (binding) + Task 2 (helper) |
| §3 "Stash this file…" context-menu item + inline message editor + empty→path + untracked | Task 2 |
| Testing — automated gates + manual E2E | Task 3 (gates also run in Tasks 1–2) |

No spec requirement is unassigned.

**2. Deviations from the spec, and why**

- The spec described the `stashSave` binding as matching `stage(path, files: string[] | null)`. The plan keeps `paths` a **required** fourth argument (exact mirror, no default) and updates the one call site to pass `null` in Task 1 — rather than adding a default value — so the binding stays a byte-for-byte convention match with `stage`.
- The inline stash form deliberately omits the `onblur` submit that the changelist-create form has, because blur-to-stash would set a file aside on accidental focus loss. Documented in Task 2's context and the code comment path (Enter submits, Escape cancels).
- The stash input carries an `aria-label` (the changelist-create input relies on its placeholder); this matches the accessibility convention the rest of the codebase follows and costs nothing.

**3. Placeholder scan:** No "TBD", "TODO", "handle edge cases", or "similar to Task N". Every code step carries literal code; every verification step names the exact command and expected result.

**4. Type consistency:** `stash_save` is declared once in the trait (`paths: Option<&[String]>`), implemented with the same signature, and wrapped in the command as `paths: Option<Vec<String>>` → `paths.as_deref()`. The TS `stashSave(path, message, includeUntracked, paths: string[] | null)` matches the command's field names (`path`, `message`, `includeUntracked`, `paths`). `doStashSave(message?: string, paths?: string[])` is declared in Task 2 Step 1 and called as `doStashSave(m, [path])` in Task 2 Step 3 with those exact types. `openStash`/`submitStash`/`stashingPath`/`stashMsg` are declared and used consistently within Task 2.
