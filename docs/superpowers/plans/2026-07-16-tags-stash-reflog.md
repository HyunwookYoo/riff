# Tags · Stash · Reflog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close riff's remaining ref-management gaps — name a stash, delete/push a tag, and recover HEAD from the reflog.

**Architecture:** Three mostly-independent features sharing riff's existing five-layer path (Svelte UI → lib helper → `git.ts` invoke binding → `lib.rs` tauri command → `cli.rs` `GitCli` → git). Only **three new backend commands** are needed (`delete_tag`, `push_tag`, `reflog`); named stash is frontend-only because `stash_save` already accepts a message, and reflog recovery reuses the existing `reset` and `createBranch` commands. The reflog panel is a modal that reuses the `ShortcutsOverlay` / `CommandPalette` idiom shipped in the discoverability pass.

**Tech Stack:** Tauri 2 (Rust) + SvelteKit + Svelte 5 runes (`$state` / `$derived` / `$effect`) + TypeScript; vitest for pure TS, `cargo test` for Rust parsers.

**Spec:** `docs/superpowers/specs/2026-07-16-tags-stash-reflog-design.md`
**Visual guide:** `docs/superpowers/specs/2026-07-16-tags-stash-reflog-visual-guide.md`

## Global Constraints

- **Never use native `window.confirm()`** — it returns immediately in the WebView2 shell, silently cancelling the action. Always use `confirmAction(message, opts)` from `$lib/dialogs` (async, returns `Promise<boolean>`; `kind` already defaults to `"warning"`).
- **Backend mutation convention** (`cli.rs`): every mutating `GitLayer` method starts with `let _w = self.write_lock.lock().unwrap();`, calls `validate_ref` on each ref-name argument, and runs via `self.run` (local) or `self.run_network` (talks to a remote). Read-only methods take **no** write lock (see `stash_list`).
- **Remote is `origin`** — the existing `push` hardcodes it; `push_tag` matches.
- **Serde field names pass through unchanged** — riff does not rename to camelCase (see `PersistedState.recent_repos` in `src/lib/types.ts`). Rust field names must equal the TS interface field names.
- **Timestamps are UNIX seconds** (`i64` in Rust, `number` in TS), matching `Commit.author_time`.
- **`GitLayer` has exactly one implementor (`GitCli`)** — there is no mock to update when adding a trait method.
- **Do not reintroduce a stage/unstage list.** riff deliberately replaces git's index with a changelists model; nothing in this plan touches it.
- **Gates that must stay green:** `npm test`, `npm run check` (0 errors; one pre-existing benign `@types/node` warning is allowed), and `cargo check` (run from `src-tauri/`).
- Do not add annotated tags, remote-tag deletion, `push --tags`, non-`origin` remotes, stash previews, partial stash, or non-HEAD reflogs — all explicitly out of scope.

---

## File Structure

**Backend (`src-tauri/src/`)**
- `git/mod.rs` — modify: add `ReflogEntry` struct next to `Stash`; add `delete_tag`, `push_tag`, `reflog` signatures to the `GitLayer` trait.
- `git/cli.rs` — modify: add the three `GitCli` impls, the `parse_reflog` helper next to `parse_stash_list`, and a `parse_reflog_basic` unit test next to `parse_stash_list_basic`.
- `lib.rs` — modify: add three `#[tauri::command]` wrappers and register them in `generate_handler!`.

**Frontend (`src/lib/`)**
- `types.ts` — modify: add the `ReflogEntry` interface mirroring the Rust struct.
- `git.ts` — modify: add `deleteTag`, `pushTag`, `reflog` invoke bindings.
- `store.svelte.ts` — modify: add the `reflogOpen` session flag.
- `reflog.ts` — **create**: `loadReflog()` + `resetToReflog()`. Owns the reflog read and the confirmed destructive restore; nothing else.
- `commands.ts` — modify: add the "Reflog / Undo history" palette entry.
- `shortcuts.ts` — modify: document the new palette entry in the cheat sheet.
- `ui/RefsSidebar.svelte` — modify: stash message inline input; tag Push/Delete context-menu items + handlers.
- `ui/ReflogOverlay.svelte` — **create**: the modal panel. Renders entries, triggers restore, hosts the inline "branch here" input.
- `../routes/+page.svelte` — modify: render the overlay and add `reflogOpen` to the modal-suppression guard.

**Task order:** 1 → 2 (2 needs 1's bindings), 3 (independent), 4 → 5 (5 needs 4's command), 6 (human gate). Run them in numeric order.

---

## Task 1: Backend — `delete_tag` + `push_tag`

**Files:**
- Modify: `src-tauri/src/git/mod.rs` (trait signatures, after the `create_tag` signature)
- Modify: `src-tauri/src/git/cli.rs` (impls, after the `create_tag` impl)
- Modify: `src-tauri/src/lib.rs` (command wrappers after the `create_tag` wrapper; registration after `create_tag,`)
- Modify: `src/lib/git.ts` (bindings after `createTag`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `deleteTag(path: string, name: string): Promise<void>` and `pushTag(path: string, name: string): Promise<void>` exported from `src/lib/git.ts` — Task 2 calls both.

- [ ] **Step 1: Add the trait signatures**

In `src-tauri/src/git/mod.rs`, immediately after the `create_tag` signature (the line `fn create_tag(&self, path: &Path, name: &str, target: &str) -> Result<(), GitError>;` and its doc comment), insert:

```rust
    /// Delete the local tag `name` (`git tag -d`). Does not touch any remote.
    fn delete_tag(&self, path: &Path, name: &str) -> Result<(), GitError>;
    /// Publish tag `name` to `origin` (`git push origin refs/tags/<name>`).
    /// The explicit `refs/tags/` refspec stops a same-named branch from
    /// winning the ambiguity.
    fn push_tag(&self, path: &Path, name: &str) -> Result<(), GitError>;
```

- [ ] **Step 2: Add the `GitCli` implementations**

In `src-tauri/src/git/cli.rs`, immediately after the `create_tag` impl (which ends with `self.run(path, &["tag", name, target])?; Ok(()) }`), insert:

```rust
    fn delete_tag(&self, path: &Path, name: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(name)?;
        self.run(path, &["tag", "-d", name])?;
        Ok(())
    }

    fn push_tag(&self, path: &Path, name: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(name)?;
        // Explicit refspec: `origin <name>` alone is ambiguous when a branch
        // shares the tag's name. `origin` matches the remote `push` hardcodes.
        let refspec = format!("refs/tags/{name}");
        self.run_network(path, &["push", "origin", &refspec])?;
        Ok(())
    }
```

- [ ] **Step 3: Add the tauri command wrappers**

In `src-tauri/src/lib.rs`, immediately after the `create_tag` wrapper, insert:

```rust
#[tauri::command]
async fn delete_tag(
    state: tauri::State<'_, GitCli>,
    path: String,
    name: String,
) -> Result<(), GitError> {
    state.delete_tag(Path::new(&path), &name)
}

#[tauri::command]
async fn push_tag(
    state: tauri::State<'_, GitCli>,
    path: String,
    name: String,
) -> Result<(), GitError> {
    state.push_tag(Path::new(&path), &name)
}
```

- [ ] **Step 4: Register both commands**

In the same file's `tauri::generate_handler![...]` list, change the line `create_tag,` so it reads:

```rust
            create_tag,
            delete_tag,
            push_tag,
```

- [ ] **Step 5: Verify the backend compiles**

Run: `cd src-tauri && cargo check`
Expected: finishes with no errors (warnings unrelated to these files are acceptable).

- [ ] **Step 6: Add the JS bindings**

In `src/lib/git.ts`, immediately after the `createTag` function, insert:

```ts
/** Delete a local tag (`git tag -d`). Does not affect the remote. */
export function deleteTag(path: string, name: string): Promise<void> {
  return invoke("delete_tag", { path, name });
}

/** Publish a tag to `origin` (`git push origin refs/tags/<name>`). */
export function pushTag(path: string, name: string): Promise<void> {
  return invoke("push_tag", { path, name });
}
```

- [ ] **Step 7: Verify the frontend typechecks**

Run: `npm run check`
Expected: `0 errors`. One pre-existing `@types/node` warning is allowed.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/git/mod.rs src-tauri/src/git/cli.rs src-tauri/src/lib.rs src/lib/git.ts
git commit -m "feat(tags): backend delete_tag and push_tag commands"
```

---

## Task 2: Tag Delete + Push in the refs sidebar

**Files:**
- Modify: `src/lib/ui/RefsSidebar.svelte` (import list; handlers next to `doDelete`; context-menu items)

**Interfaces:**
- Consumes: `deleteTag(path, name)` and `pushTag(path, name)` from `src/lib/git.ts` (Task 1).
- Produces: nothing later tasks depend on.

**Context the implementer needs:**
- The context menu already renders Checkout / Merge into current / New branch from here for **every** ref kind, and Rename / Set upstream / Delete only when `ref.kind === "local"`. Tags therefore have no Delete and no Push today.
- `run(op: Promise<void>)` (defined near the top of the component) already wraps an operation with a `busy` guard, routes errors to `appState.error`, and in its `finally` calls `await load()` + `void loadCurrentBranch()` — `load()` re-lists refs, which is exactly the refresh the Tags section needs. **Reuse `run`; do not hand-roll try/catch.**
- The menu closes itself: `<svelte:window onclick={() => (menu = null)} />` is already wired, so a menu item's click bubbles up and dismisses it. **Do not set `menu = null` in these handlers** — the existing `doDelete` / `doCheckout` do not either.

- [ ] **Step 1: Import the two new bindings**

In `src/lib/ui/RefsSidebar.svelte`, change the `$lib/git` import block so it reads (entries stay alphabetical):

```ts
  import {
    createBranch,
    deleteBranch,
    deleteTag,
    listRefs,
    pushTag,
    renameBranch,
    setUpstream,
    status,
  } from "$lib/git";
```

- [ ] **Step 2: Add the two handlers**

In the same file, immediately after the `doDelete` function (it ends with the `finally { busy = false; await load(); void loadCurrentBranch(); }` block and its closing brace), insert:

```ts
  // Tags get Delete + Push; both reuse `run` for the busy guard, error
  // surfacing, and the ref re-list that follows.
  async function doDeleteTag(b: Branch) {
    const ok = await confirmAction(`Delete tag '${b.name}'?`, {
      title: "Delete tag",
    });
    if (!ok) return;
    await run(deleteTag(repoPath, b.name));
  }

  function doPushTag(b: Branch) {
    void run(pushTag(repoPath, b.name));
  }
```

- [ ] **Step 3: Add the context-menu items**

In the same file's context menu (the `{#if menu}` block), immediately after the closing `{/if}` of the `{#if ref.kind === "local"}` block and before the menu's closing `</div>`, insert:

```svelte
    {#if ref.kind === "tag"}
      <button type="button" role="menuitem" onclick={() => doPushTag(ref)}>
        Push
      </button>
      <button
        type="button"
        role="menuitem"
        class="danger"
        onclick={() => void doDeleteTag(ref)}
      >
        Delete
      </button>
    {/if}
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run check`
Expected: `0 errors`.

- [ ] **Step 5: Verify the existing suite still passes**

Run: `npm test`
Expected: all tests pass (this task adds no tests — it is UI wiring, which riff does not unit-test).

- [ ] **Step 6: Commit**

```bash
git add src/lib/ui/RefsSidebar.svelte
git commit -m "feat(tags): Push and Delete actions in the tag context menu"
```

---

## Task 3: Named stash

**Files:**
- Modify: `src/lib/ui/RefsSidebar.svelte` (stash editor state; Stashes section markup; one CSS rule)

**Interfaces:**
- Consumes: `doStashSave(message?: string)` from `$lib/sourceControl` — **already imported** in this component.
- Produces: nothing later tasks depend on.

**Context the implementer needs:**
- The backend already supports this end to end: `stash_save` appends `-m <message>` whenever the message is non-empty, and `doStashSave(message?)` already forwards it. The only gap is that the `＋` button calls `doStashSave()` with no argument, so every stash is unnamed.
- Submitting an **empty** message must still save an unnamed stash — that preserves today's one-click behavior.
- The command-palette entry `stash.save` stays a quick unnamed save; do **not** change `commands.ts` in this task.

- [ ] **Step 1: Add the stash editor state**

In `src/lib/ui/RefsSidebar.svelte`, immediately after the `doPushTag` function added in Task 2, insert:

```ts
  // ── Stash message entry ─────────────────────────────────────────────────
  // The ＋ opens an inline field so a stash can carry a name. Submitting it
  // empty still saves an unnamed stash — the old one-click behavior.
  let stashEditing = $state(false);
  let stashMsg = $state("");
  let stashInputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (stashEditing) stashInputEl?.focus();
  });

  function openStashEditor() {
    stashMsg = "";
    stashEditing = true;
  }

  function submitStash(e: Event) {
    e.preventDefault();
    const m = stashMsg.trim();
    stashEditing = false;
    stashMsg = "";
    void doStashSave(m || undefined);
  }
```

- [ ] **Step 2: Point the `＋` button at the editor and render the input**

In the same file, replace the Stashes section header block — currently:

```svelte
      <div class="sec-head">
        <span>Stashes</span>
        <button
          type="button"
          class="new"
          title="Stash working-tree changes"
          aria-label="Stash changes"
          onclick={() => void doStashSave()}
        >
          ＋
        </button>
      </div>
```

with:

```svelte
      <div class="sec-head">
        <span>Stashes</span>
        <button
          type="button"
          class="new"
          title="Stash working-tree changes"
          aria-label="Stash changes"
          onclick={openStashEditor}
        >
          ＋
        </button>
      </div>
      {#if stashEditing}
        <form class="stash-editor" onsubmit={submitStash}>
          <input
            bind:this={stashInputEl}
            bind:value={stashMsg}
            placeholder="Stash message (optional)"
            onkeydown={(e) => e.key === "Escape" && (stashEditing = false)}
          />
        </form>
      {/if}
```

- [ ] **Step 3: Add the input's styling**

In the same file's `<style>` block, immediately before the `.stash {` rule, insert:

```css
  .stash-editor {
    padding: 4px 8px 6px;
  }
  .stash-editor input {
    width: 100%;
    box-sizing: border-box;
    padding: 3px 6px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    font-size: 0.82em;
  }
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run check`
Expected: `0 errors`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/RefsSidebar.svelte
git commit -m "feat(stash): name a stash from an inline message field"
```

---

## Task 4: Backend — `reflog` command + parser

**Files:**
- Modify: `src-tauri/src/git/mod.rs` (`ReflogEntry` struct after `Stash`; trait signature after `reset`)
- Modify: `src-tauri/src/git/cli.rs` (`parse_reflog` after `parse_stash_list`; `reflog` impl after the `reset` impl; unit test after `parse_stash_list_basic`)
- Modify: `src-tauri/src/lib.rs` (command wrapper after the `reset` wrapper; registration after `reset,`)
- Modify: `src/lib/types.ts` (`ReflogEntry` interface after `Stash`)
- Modify: `src/lib/git.ts` (`reflog` binding after `reset`; add `ReflogEntry` to the type import)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: TS `interface ReflogEntry { sha: string; selector: string; subject: string; time: number }` in `src/lib/types.ts`, and `reflog(path: string): Promise<ReflogEntry[]>` in `src/lib/git.ts`. Task 5 consumes both.

**Context the implementer needs:**
- `time` is UNIX seconds (git's `%ct`), matching `Commit.author_time`; the panel formats it in the frontend.
- There is deliberately **no `short_sha` field** — the frontend derives it with `sha.slice(0, 7)`.
- `reflog` is **read-only**: no `write_lock`, no `drop_session` (mirror `stash_list`, not `reset`).

- [ ] **Step 1: Write the failing parser test**

In `src-tauri/src/git/cli.rs`, inside the existing `#[cfg(test)] mod` block, immediately after the `parse_stash_list_basic` test, insert:

```rust
    #[test]
    fn parse_reflog_basic() {
        let input = "a1b2c3d\u{1f}HEAD@{0}\u{1f}reset: moving to HEAD~3\u{1f}1752624000\n\
                     f6a1b2c\u{1f}HEAD@{1}\u{1f}commit: fix login\u{1f}1752623400\n";
        let r = parse_reflog(input);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].sha, "a1b2c3d");
        assert_eq!(r[0].selector, "HEAD@{0}");
        assert_eq!(r[0].subject, "reset: moving to HEAD~3");
        assert_eq!(r[0].time, 1752624000);
        assert_eq!(r[1].sha, "f6a1b2c");
        assert_eq!(r[1].subject, "commit: fix login");
        // A trailing/blank line must not produce a bogus entry.
        assert!(parse_reflog("").is_empty());
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test parse_reflog_basic`
Expected: FAIL — compilation errors `cannot find function 'parse_reflog'` and `cannot find type 'ReflogEntry'`.

- [ ] **Step 3: Add the `ReflogEntry` struct**

In `src-tauri/src/git/mod.rs`, immediately after the `Stash` struct (which ends `pub message: String, }`), insert:

```rust
/// One entry from HEAD's reflog. `selector` is the `HEAD@{N}` form; `subject`
/// is git's reflog message (e.g. `commit: fix login`, `reset: moving to
/// HEAD~3`); `time` is the committer date in UNIX seconds. The reflog is the
/// only record of commits no ref points at any more, so these entries can
/// reference commits the graph cannot show.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReflogEntry {
    pub sha: String,
    pub selector: String,
    pub subject: String,
    pub time: i64,
}
```

- [ ] **Step 4: Add the parser**

In `src-tauri/src/git/cli.rs`, immediately after the `parse_stash_list` function, insert:

```rust
/// Parse `git reflog show --format=%H%x1f%gD%x1f%gs%x1f%ct` output: one entry
/// per line — full SHA, `HEAD@{N}` selector, reflog subject, and committer
/// UNIX time, separated by \x1f. Lines without a SHA are skipped so a trailing
/// newline cannot yield a bogus entry.
fn parse_reflog(text: &str) -> Vec<ReflogEntry> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\x1f');
            let sha = parts.next()?;
            if sha.is_empty() {
                return None;
            }
            let selector = parts.next()?.to_string();
            let subject = parts.next().unwrap_or("").to_string();
            let time = parts.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
            Some(ReflogEntry {
                sha: sha.to_string(),
                selector,
                subject,
                time,
            })
        })
        .collect()
}
```

Add `ReflogEntry` to the `use super::{...}` import at the top of `cli.rs` — the same import that already brings in `Stash`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd src-tauri && cargo test parse_reflog_basic`
Expected: PASS (`test result: ok. 1 passed`).

- [ ] **Step 6: Add the trait signature**

In `src-tauri/src/git/mod.rs`, immediately after the `reset` signature (`fn reset(&self, path: &Path, target: &str, mode: &str) -> Result<(), GitError>;` and its doc comment), insert:

```rust
    /// The most recent HEAD reflog entries (`git reflog show`), newest first.
    /// Read-only. Feeds the recovery panel, which resets HEAD back to one of
    /// them — including commits that are no longer reachable from any ref.
    fn reflog(&self, path: &Path) -> Result<Vec<ReflogEntry>, GitError>;
```

- [ ] **Step 7: Add the `GitCli` implementation**

In `src-tauri/src/git/cli.rs`, immediately after the `reset` impl (which ends `self.drop_session(); Ok(()) }`), insert:

```rust
    fn reflog(&self, path: &Path) -> Result<Vec<ReflogEntry>, GitError> {
        // Read-only: no write_lock and no drop_session (mirrors `stash_list`).
        // Bounded to the 200 most recent moves — this is a recovery list, not
        // an audit log.
        let out = self.run(
            path,
            &[
                "reflog",
                "show",
                "--format=%H%x1f%gD%x1f%gs%x1f%ct",
                "-n",
                "200",
            ],
        )?;
        Ok(parse_reflog(&String::from_utf8_lossy(&out)))
    }
```

- [ ] **Step 8: Add the tauri command wrapper and register it**

In `src-tauri/src/lib.rs`, immediately after the `reset` wrapper, insert:

```rust
#[tauri::command]
async fn reflog(
    state: tauri::State<'_, GitCli>,
    path: String,
) -> Result<Vec<ReflogEntry>, GitError> {
    state.reflog(Path::new(&path))
}
```

Add `ReflogEntry` to the same `use` statement in `lib.rs` that already imports `Stash`. Then in `tauri::generate_handler![...]`, change the line `reset,` so it reads:

```rust
            reset,
            reflog,
```

- [ ] **Step 9: Verify the backend compiles and all Rust tests pass**

Run: `cd src-tauri && cargo check && cargo test`
Expected: `cargo check` finishes with no errors; `cargo test` reports all tests passing, including `parse_reflog_basic`.

- [ ] **Step 10: Add the TS interface**

In `src/lib/types.ts`, immediately after the `Stash` interface, insert:

```ts
/// One HEAD reflog entry. Mirrors Rust `ReflogEntry`. `selector` is the
/// `HEAD@{N}` form; `subject` is git's reflog message (e.g. `commit: …`,
/// `reset: moving to …`); `time` is the committer date in UNIX seconds.
/// The short SHA is derived in the UI via `sha.slice(0, 7)`.
export interface ReflogEntry {
  sha: string;
  selector: string;
  subject: string;
  time: number;
}
```

- [ ] **Step 11: Add the JS binding**

In `src/lib/git.ts`, add `ReflogEntry` to the existing `import type { ... } from "./types";` list (keep it alphabetical), then immediately after the `reset` function insert:

```ts
/** The 200 most recent HEAD reflog entries, newest first (`git reflog show`). */
export function reflog(path: string): Promise<ReflogEntry[]> {
  return invoke("reflog", { path });
}
```

- [ ] **Step 12: Verify the frontend typechecks**

Run: `npm run check`
Expected: `0 errors`.

- [ ] **Step 13: Commit**

```bash
git add src-tauri/src/git/mod.rs src-tauri/src/git/cli.rs src-tauri/src/lib.rs src/lib/types.ts src/lib/git.ts
git commit -m "feat(reflog): backend reflog command with parser and tests"
```

---

## Task 5: Reflog recovery panel

**Files:**
- Create: `src/lib/reflog.ts`
- Create: `src/lib/ui/ReflogOverlay.svelte`
- Modify: `src/lib/store.svelte.ts` (add `reflogOpen` after `shortcutsOpen`)
- Modify: `src/routes/+page.svelte` (render the overlay; extend the modal guard)
- Modify: `src/lib/commands.ts` (palette entry)
- Modify: `src/lib/shortcuts.ts` (cheat-sheet line)

**Interfaces:**
- Consumes: `reflog(path)` and `ReflogEntry` (Task 4); the pre-existing `reset(path, target, mode)`, `createBranch(path, name, startPoint, checkout)`, `changesRepoPath()`, `loadStatus()`, `invalidateGraph()`, and `confirmAction(message, opts)`.
- Produces: nothing later tasks depend on.

**Context the implementer needs:**
- `ShortcutsOverlay.svelte` is the template for this modal: a `.backdrop` fixed overlay at `z-index: 2100` whose click closes, an inner `role="dialog"` with `tabindex="-1"` + `bind:this` that is focused on open via `queueMicrotask`, an `onkeydown` that `preventDefault` + `stopPropagation` on Escape, and `onclick={(e) => e.stopPropagation()}` on the dialog so inner clicks do not close it. Follow that structure.
- The panel must be reachable, so the palette entry ships in **this** task — without it there is no way to open the overlay.
- `appState.refsRefresh++` is the established way to nudge the refs sidebar to re-list (see `sourceControl.ts`).
- `resetToReflog` returns `true` only when the user confirmed and the reset was attempted, so the overlay knows whether to close.

- [ ] **Step 1: Add the store flag**

In `src/lib/store.svelte.ts`, immediately after the line `shortcutsOpen = $state(false);`, insert:

```ts
  // Reflog recovery panel visibility. Session-only.
  reflogOpen = $state(false);
```

- [ ] **Step 2: Create the reflog helper module**

Create `src/lib/reflog.ts`:

```ts
/// Reflog recovery. The reflog is git's record of everywhere HEAD has been,
/// and the only place the SHAs of unreachable commits survive — after a hard
/// reset, a squashing rebase, an amend, or a deleted branch. The commit graph
/// only draws commits reachable from a ref, so it cannot show them; this
/// module is how riff gets back to one.
import { appState } from "./store.svelte";
import { reflog, reset } from "./git";
import { changesRepoPath, loadStatus } from "./sourceControl";
import { invalidateGraph } from "./commitHistory";
import { confirmAction } from "./dialogs";
import type { ReflogEntry } from "./types";

/// Read the recent HEAD reflog. Failures surface in the error banner and
/// yield an empty list rather than throwing into the overlay.
export async function loadReflog(): Promise<ReflogEntry[]> {
  try {
    return await reflog(changesRepoPath());
  } catch (e) {
    appState.error = String(e);
    return [];
  }
}

/// Restore HEAD to `sha` with a hard reset. Destructive — uncommitted changes
/// are lost — so it always confirms first. Returns true when the user
/// confirmed (i.e. the reset was attempted), false when they cancelled.
export async function resetToReflog(sha: string): Promise<boolean> {
  const ok = await confirmAction(
    "Reset to this point? Uncommitted changes will be lost.",
    { title: "Reset to reflog entry" },
  );
  if (!ok) return false;
  appState.error = null;
  try {
    await reset(changesRepoPath(), sha, "hard");
    invalidateGraph();
  } catch (e) {
    appState.error = String(e);
  } finally {
    await loadStatus();
  }
  return true;
}
```

- [ ] **Step 3: Create the overlay component**

Create `src/lib/ui/ReflogOverlay.svelte`:

```svelte
<!-- src/lib/ui/ReflogOverlay.svelte -->
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { loadReflog, resetToReflog } from "$lib/reflog";
  import { createBranch } from "$lib/git";
  import { changesRepoPath } from "$lib/sourceControl";
  import type { ReflogEntry } from "$lib/types";

  let entries = $state<ReflogEntry[]>([]);
  let loading = $state(false);
  let dialogEl = $state<HTMLDivElement>();

  // Inline "branch here" entry, holding the sha it will branch from.
  let branchFor = $state<string | null>(null);
  let branchName = $state("");
  let branchInputEl = $state<HTMLInputElement | null>(null);

  let wasOpen = false;
  $effect(() => {
    if (appState.reflogOpen && !wasOpen) {
      queueMicrotask(() => dialogEl?.focus());
      void refresh();
    }
    if (!appState.reflogOpen) {
      branchFor = null;
      branchName = "";
    }
    wasOpen = appState.reflogOpen;
  });

  $effect(() => {
    if (branchFor) branchInputEl?.focus();
  });

  async function refresh() {
    loading = true;
    entries = await loadReflog();
    loading = false;
  }

  function close() {
    appState.reflogOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // Escape backs out of the inline branch field first, then the panel.
    if (branchFor) {
      branchFor = null;
      branchName = "";
      return;
    }
    close();
  }

  async function onReset(entry: ReflogEntry) {
    if (await resetToReflog(entry.sha)) close();
  }

  function openBranchEditor(sha: string) {
    branchName = "";
    branchFor = sha;
  }

  async function submitBranch(e: Event) {
    e.preventDefault();
    const sha = branchFor;
    const name = branchName.trim();
    branchFor = null;
    branchName = "";
    if (!sha || !name) return;
    try {
      // `checkout: false` — branching off an entry must not move HEAD.
      await createBranch(changesRepoPath(), name, sha, false);
      appState.refsRefresh++;
    } catch (err) {
      appState.error = String(err);
    }
  }

  // Compact relative time, mirroring the graph's own formatter.
  function relTime(unixSec: number): string {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
    return `${Math.floor(d / 604800)}w ago`;
  }
</script>

{#if appState.reflogOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="rl-backdrop" onclick={close} role="presentation">
    <div
      class="rl"
      role="dialog"
      aria-modal="true"
      aria-label="Reflog"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="rl-head">
        <span>Reflog / Undo history</span>
        <button type="button" class="rl-x" aria-label="Close" onclick={close}
          >×</button
        >
      </div>
      <div class="rl-body">
        {#if loading}
          <div class="rl-empty">Loading…</div>
        {:else if entries.length === 0}
          <div class="rl-empty">No reflog entries</div>
        {:else}
          {#each entries as entry (entry.selector)}
            <div class="rl-row">
              <button
                type="button"
                class="rl-main"
                title="Reset HEAD to this point (uncommitted changes are lost)"
                onclick={() => void onReset(entry)}
              >
                <span class="rl-sel">{entry.selector}</span>
                <span class="rl-sha">{entry.sha.slice(0, 7)}</span>
                <span class="rl-subj">{entry.subject}</span>
                <span class="rl-time">{relTime(entry.time)}</span>
              </button>
              <button
                type="button"
                class="rl-branch"
                title="Create a branch here (does not move HEAD)"
                onclick={() => openBranchEditor(entry.sha)}
              >
                ＋ branch
              </button>
            </div>
            {#if branchFor === entry.sha}
              <form class="rl-editor" onsubmit={submitBranch}>
                <input
                  bind:this={branchInputEl}
                  bind:value={branchName}
                  placeholder="New branch name"
                />
              </form>
            {/if}
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .rl-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .rl {
    width: 640px;
    max-width: calc(100vw - 32px);
    max-height: 76vh;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    outline: none;
  }
  .rl-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  .rl-x {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
  }
  .rl-x:hover {
    color: var(--accent);
  }
  .rl-body {
    overflow-y: auto;
    padding: 6px 8px 12px;
  }
  .rl-empty {
    padding: 12px;
    color: var(--muted);
    font-size: 0.88em;
  }
  .rl-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .rl-row:hover {
    background: var(--hover);
  }
  .rl-main {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 4px 6px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-size: 0.88em;
  }
  .rl-sel {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--muted);
  }
  .rl-sha {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--accent);
  }
  .rl-subj {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rl-time {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 0.85em;
  }
  .rl-branch {
    flex: 0 0 auto;
    margin-right: 6px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.75em;
    opacity: 0;
  }
  .rl-row:hover .rl-branch {
    opacity: 1;
  }
  .rl-branch:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .rl-editor {
    padding: 2px 8px 6px 14px;
  }
  .rl-editor input {
    width: 100%;
    box-sizing: border-box;
    padding: 3px 6px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    font-size: 0.82em;
  }
</style>
```

- [ ] **Step 4: Render the overlay and extend the modal guard**

In `src/routes/+page.svelte`, add the import immediately after the `ShortcutsOverlay` import:

```ts
  import ReflogOverlay from "$lib/ui/ReflogOverlay.svelte";
```

Render it immediately after `<ShortcutsOverlay />`:

```svelte
  <ReflogOverlay />
```

Then extend the modal-suppression guard — replace:

```ts
    if (appState.checkoutPrompt || appState.paletteOpen || appState.shortcutsOpen)
      return;
```

with:

```ts
    if (
      appState.checkoutPrompt ||
      appState.paletteOpen ||
      appState.shortcutsOpen ||
      appState.reflogOpen
    )
      return;
```

- [ ] **Step 5: Add the palette entry**

In `src/lib/commands.ts`, inside the `cmds.push(...)` call that already contains `commit.undo` and `help.shortcuts`, insert a new entry immediately after the `commit.undo` object:

```ts
    {
      id: "reflog.open",
      title: "Reflog / Undo history",
      category: "Commit",
      run: () => {
        appState.reflogOpen = true;
      },
    },
```

- [ ] **Step 6: Document it in the cheat sheet**

In `src/lib/shortcuts.ts`, change the `Commit` group so it reads:

```ts
  {
    title: "Commit",
    items: [
      { keys: "Ctrl+Enter", desc: "Commit" },
      { keys: "Ctrl+Shift+P", desc: "Reflog / Undo history (via palette)" },
    ],
  },
```

- [ ] **Step 7: Verify it typechecks**

Run: `npm run check`
Expected: `0 errors`.

- [ ] **Step 8: Verify the existing suite still passes**

Run: `npm test`
Expected: all tests pass. `src/lib/shortcuts.test.ts` asserts every group is non-empty and well-formed, so the edited `Commit` group must keep valid `{ keys, desc }` entries.

- [ ] **Step 9: Commit**

```bash
git add src/lib/reflog.ts src/lib/ui/ReflogOverlay.svelte src/lib/store.svelte.ts src/routes/+page.svelte src/lib/commands.ts src/lib/shortcuts.ts
git commit -m "feat(reflog): recovery panel with restore and branch-here"
```

---

## Task 6: Manual E2E verification (human merge gate)

**Files:** none — this is a human verification pass against a running app.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: the go/no-go decision for merging.

This task exists because riff does not unit-test git operations or Svelte UI, so the end-to-end git results are only provable by running the app.

- [ ] **Step 1: Confirm all automated gates are green**

Run: `npm test && npm run check`
Expected: all tests pass; `0 errors`.

Run: `cd src-tauri && cargo check && cargo test`
Expected: no errors; all Rust tests pass.

- [ ] **Step 2: Start the app**

Run: `npm run tauri dev`
Expected: the riff window opens against a test repository.

- [ ] **Step 3: Verify named stash**

1. Make an edit so the working tree is dirty.
2. In the refs sidebar, click `＋` on the **Stashes** section.
3. Type `login refactor wip` and press Enter.
4. Expected: a stash appears listed as `login refactor wip` (not `WIP on …`).
5. Dirty the tree again, click `＋`, and press Enter with the field **empty**.
6. Expected: a second stash is created with git's default `WIP on <branch>: …` message — the old behavior still works.

- [ ] **Step 4: Verify tag delete**

1. Right-click a commit in the graph → **Tag here…** → name it `e2e-delete-me` → Enter.
2. Expected: `e2e-delete-me` appears in the sidebar's **Tags** section.
3. Right-click that tag in the sidebar → **Delete** → confirm in the dialog.
4. Expected: the confirmation dialog actually appears (not silently dismissed), and after confirming the tag disappears from the Tags section.

- [ ] **Step 5: Verify tag push**

1. Create a tag `e2e-push-me` the same way.
2. Right-click it in the sidebar → **Push**.
3. Expected: no error banner; the tag now exists on the remote (verify with `git ls-remote --tags origin` in a terminal — `e2e-push-me` is listed).

- [ ] **Step 6: Verify the reflog panel lists entries**

1. Open the command palette (`Ctrl+Shift+P`) and run **Reflog / Undo history**.
2. Expected: the panel opens and lists recent HEAD moves, newest first, each showing a `HEAD@{N}` selector, a 7-character SHA, git's reflog subject, and a relative time.
3. Press Escape.
4. Expected: the panel closes.

- [ ] **Step 7: Verify branch-here is non-destructive**

1. Note the current branch and HEAD.
2. Open the reflog panel, hover an older entry, click **＋ branch**, type `e2e-reflog-branch`, press Enter.
3. Expected: the branch appears in the sidebar's Branches section pointing at that entry, **and HEAD has not moved** — the current branch is unchanged and the working tree is untouched.

- [ ] **Step 8: Verify reflog restore (the core recovery case)**

1. On a scratch branch, make and commit three throwaway commits. Note the subject of the newest.
2. In a terminal, run `git reset --hard HEAD~3` to simulate the accident, and confirm in riff's graph that the three commits are gone.
3. Open the reflog panel. Expected: an entry whose subject is `commit: <newest throwaway subject>` is listed — even though that commit is no longer in the graph.
4. Click that entry and confirm the dialog.
5. Expected: HEAD returns to that commit, the three commits reappear in the graph, the status refreshes, and the panel closes.

- [ ] **Step 9: Clean up the test refs**

Delete `e2e-reflog-branch` and any leftover `e2e-*` tags (locally and on the remote) so the test repository is left clean.

- [ ] **Step 10: Record the result**

If every check passed, the branch is ready to merge. If any failed, capture what happened and fix it before merging — do not merge on a partial pass.

---

## Self-Review

Checked after writing, against `docs/superpowers/specs/2026-07-16-tags-stash-reflog-design.md`:

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 Named stash (inline input, empty = unnamed, palette unchanged) | Task 3 |
| §2 `delete_tag` + `push_tag` backend (origin, `refs/tags/` refspec) | Task 1 |
| §2 Tag Delete/Push context-menu items + `confirmAction` + refresh | Task 2 |
| §3 `reflog` backend + `parse_reflog` + `ReflogEntry` + TS types | Task 4 |
| §3 `reflog.ts`, `ReflogOverlay`, `reflogOpen`, `+page` wiring, palette entry, cheat-sheet line | Task 5 |
| Testing — automated gates + manual E2E checklist | Task 6 (gates also run in every task) |

No spec requirement is unassigned.

**2. Deviations from the spec, and why**

- The spec said reflog parsing would be "covered by manual E2E rather than a JS test". Reading `cli.rs` showed an existing `#[cfg(test)]` module with `parse_stash_list_basic`, so `parse_reflog` gets a real Rust unit test (Task 4, Steps 1–5) in the same style. This is strictly more verification than the spec required and matches the codebase's own convention.
- The spec's `ReflogEntry` listed a `short_sha` field; the plan drops it and derives the short SHA in the UI (`sha.slice(0, 7)`, as `CommitList` already does). Fewer fields, no serde-casing risk, same result.
- The spec left `time` as an ISO date; the plan uses git's `%ct` (UNIX seconds, `i64`/`number`) because riff's existing relative-time formatters take UNIX seconds (`Commit.author_time`).
- The spec suggested the tag handlers "mirror `doDelete`'s structure (busy guard + error surfacing)". The plan instead reuses the component's existing `run()` helper, which already provides exactly that plus the `load()` re-list — less duplicated code, same behavior.

**3. Placeholder scan:** No "TBD", "TODO", "handle edge cases", or "similar to Task N". Every code step carries the literal code to write; every verification step carries the exact command and its expected output.

**4. Type consistency:** `ReflogEntry` is declared once in Rust (Task 4, Step 3) with fields `sha: String`, `selector: String`, `subject: String`, `time: i64`, and once in TS (Task 4, Step 10) with `sha: string`, `selector: string`, `subject: string`, `time: number` — field names match exactly, as riff's serde passes names through unchanged. `loadReflog(): Promise<ReflogEntry[]>` and `resetToReflog(sha: string): Promise<boolean>` are declared in Task 5 Step 2 and consumed with those exact signatures in Task 5 Step 3. `deleteTag(path, name)` / `pushTag(path, name)` are declared in Task 1 Step 6 and called with that shape in Task 2 Step 2. `createBranch(path, name, startPoint, checkout)` is used with the pre-existing four-argument signature.
