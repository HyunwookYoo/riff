# Stashes Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a stash list from the command palette, with per-row Pop/Apply/Drop and an inline save, so stashes are reachable regardless of how many branches fill the sidebar.

**Architecture:** Frontend-only. A new `StashesOverlay.svelte` modal — structurally a copy of the just-shipped `ReflogOverlay.svelte` — reads the already-loaded `appState.stashes` and calls the existing `doStashApply` / `doStashDrop` / `doStashSave` helpers. A "View stashes" palette command opens it and replaces the scattered per-stash pop/drop palette entries. No backend change; the sidebar Stashes section is left untouched.

**Tech Stack:** SvelteKit + Svelte 5 runes (`$state` / `$effect`) + TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-22-stashes-panel-design.md`

## Global Constraints

- **No new backend.** Everything reuses existing state and helpers; do not add or touch any `src-tauri` file.
- **The sidebar Stashes section (`RefsSidebar.svelte`) is not touched** — the panel is an additional access route, by decision.
- **`StashesOverlay` mirrors the `ReflogOverlay` modal idiom exactly:** fixed `.backdrop` at `z-index: 2100` whose click closes; inner `role="dialog"` with `aria-modal`, `tabindex="-1"`, `bind:this`, focused on open via `queueMicrotask` guarded by a non-reactive `wasOpen`; `onkeydown` that `preventDefault` + `stopPropagation` on Escape; `onclick={(e) => e.stopPropagation()}` on the dialog.
- **On open, call `loadStashes()`** so the list is fresh; render rows from the reactive `appState.stashes` so Pop/Drop update the list live and the panel stays open.
- **The inline save uses `doStashSave(msg.trim() || undefined)`** — a whole-tree stash, named if a message was typed, unnamed (git default) if empty.
- **Actions are fire-and-forget** (`void doStash…()`); each helper routes its own errors to `appState.error` — do not wrap them again.
- **Palette:** add one "View stashes" command, remove the per-stash pop/drop loop, keep `stash.save`.
- **`shortcuts.ts` edits must keep every group a non-empty list of valid `{ keys, desc }` objects** (`shortcuts.test.ts` asserts this).
- **Gates that must stay green:** `npm test`, `npm run check` (0 errors; the one pre-existing benign `@types/node` warning is allowed).
- Out of scope, must not appear: stash-content preview (`git stash show`), stash→branch, removing the sidebar section, a dedicated toolbar button.

---

## File Structure

- `src/lib/store.svelte.ts` — add the `stashesOpen` session flag.
- `src/lib/ui/StashesOverlay.svelte` — **create**: the modal. Owns the list rendering, the three row actions, and the inline save.
- `src/lib/commands.ts` — add "View stashes"; remove the per-stash pop/drop loop; keep `stash.save`.
- `src/routes/+page.svelte` — render the overlay and add `stashesOpen` to the modal-suppression guard.
- `src/lib/shortcuts.ts` — one cheat-sheet line in the Commit group.

**Task order:** 1 (store flag — the overlay and page both read it) → 2 (overlay) → 3 (palette + page + shortcuts wiring) → 4 (human E2E). The store flag lands first so Tasks 2 and 3 compile against it. Run in numeric order.

---

## Task 1: Store flag

**Files:**
- Modify: `src/lib/store.svelte.ts` (after `reflogOpen`, around line 174)

**Interfaces:**
- Consumes: nothing.
- Produces: `appState.stashesOpen: boolean` (session flag, default false) — read/written by Tasks 2 and 3.

- [ ] **Step 1: Add the flag**

In `src/lib/store.svelte.ts`, immediately after the line `reflogOpen = $state(false);` (and its preceding comment), insert:

```ts
  // Stashes panel visibility. Session-only.
  stashesOpen = $state(false);
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run check`
Expected: `0 errors` (one pre-existing `@types/node` warning is allowed).

- [ ] **Step 3: Commit**

```bash
git add src/lib/store.svelte.ts
git commit -m "feat(stash): add stashesOpen panel flag"
```

---

## Task 2: `StashesOverlay.svelte`

**Files:**
- Create: `src/lib/ui/StashesOverlay.svelte`

**Interfaces:**
- Consumes: `appState.stashesOpen` (Task 1); `appState.stashes` (`Stash[]`, `{ index: number; message: string }`); `loadStashes()`, `doStashApply(index: number, pop: boolean)`, `doStashDrop(index: number)`, `doStashSave(message?: string, paths?: string[])` — all from `$lib/sourceControl`.
- Produces: the `<StashesOverlay />` component, rendered by Task 3.

**Context the implementer needs:**
- `src/lib/ui/ReflogOverlay.svelte` is the template — same backdrop/dialog/focus/Escape structure and the same CSS approach (class-prefixed, `z-index: 2100`). This component uses the `sp-` prefix for its classes.
- `appState.stashes` is reactive; the three helpers each call `loadStashes()` internally, which reassigns `appState.stashes`, so the `{#each}` re-renders after any action with no extra work.
- Do not import or call any `git.ts` function directly; go through the `doStash…` helpers.

- [ ] **Step 1: Create the component**

Create `src/lib/ui/StashesOverlay.svelte`:

```svelte
<!-- src/lib/ui/StashesOverlay.svelte -->
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    loadStashes,
    doStashApply,
    doStashDrop,
    doStashSave,
  } from "$lib/sourceControl";

  let dialogEl = $state<HTMLDivElement>();

  // Inline "save new stash" field.
  let saving = $state(false);
  let saveMsg = $state("");
  let saveInputEl = $state<HTMLInputElement | null>(null);

  let wasOpen = false;
  $effect(() => {
    if (appState.stashesOpen && !wasOpen) {
      queueMicrotask(() => dialogEl?.focus());
      void loadStashes();
    }
    if (!appState.stashesOpen) {
      saving = false;
      saveMsg = "";
    }
    wasOpen = appState.stashesOpen;
  });

  $effect(() => {
    if (saving) saveInputEl?.focus();
  });

  function close() {
    appState.stashesOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // Escape backs out of the inline save field first, then the panel.
    if (saving) {
      saving = false;
      saveMsg = "";
      return;
    }
    close();
  }

  function submitSave(e: Event) {
    e.preventDefault();
    const msg = saveMsg.trim();
    saving = false;
    saveMsg = "";
    void doStashSave(msg || undefined);
  }
</script>

{#if appState.stashesOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="sp-backdrop" onclick={close} role="presentation">
    <div
      class="sp"
      role="dialog"
      aria-modal="true"
      aria-label="Stashes"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="sp-head">
        <span>Stashes</span>
        <button type="button" class="sp-x" aria-label="Close" onclick={close}
          >×</button
        >
      </div>
      <div class="sp-body">
        {#if appState.stashes.length === 0}
          <div class="sp-empty">No stashes</div>
        {:else}
          {#each appState.stashes as s (s.index)}
            <div class="sp-row">
              <span class="sp-msg" title={s.message}>{s.message}</span>
              <div class="sp-actions">
                <button type="button" onclick={() => void doStashApply(s.index, true)}
                  >Pop</button
                >
                <button type="button" onclick={() => void doStashApply(s.index, false)}
                  >Apply</button
                >
                <button
                  type="button"
                  class="sp-drop"
                  onclick={() => void doStashDrop(s.index)}>Drop</button
                >
              </div>
            </div>
          {/each}
        {/if}
      </div>
      <div class="sp-foot">
        {#if saving}
          <form class="sp-save" onsubmit={submitSave}>
            <input
              bind:this={saveInputEl}
              bind:value={saveMsg}
              placeholder="Stash message (optional)"
              aria-label="Stash message"
            />
          </form>
        {:else}
          <button type="button" class="sp-new" onclick={() => (saving = true)}>
            ＋ Save new stash
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .sp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .sp {
    width: 520px;
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
  .sp-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  .sp-x {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
  }
  .sp-x:hover {
    color: var(--accent);
  }
  .sp-body {
    overflow-y: auto;
    padding: 6px 8px;
  }
  .sp-empty {
    padding: 12px;
    color: var(--muted);
    font-size: 0.88em;
  }
  .sp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 4px;
  }
  .sp-row:hover {
    background: var(--hover);
  }
  .sp-msg {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.86em;
    font-family: var(--mono);
  }
  .sp-actions {
    flex: 0 0 auto;
    display: inline-flex;
    gap: 4px;
    opacity: 0;
  }
  .sp-row:hover .sp-actions,
  .sp-actions:focus-within {
    opacity: 1;
  }
  .sp-actions button {
    border: 1px solid var(--border);
    border-radius: 3px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 1px 8px;
    font-size: 0.78em;
    line-height: 1.4;
  }
  .sp-actions button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sp-actions .sp-drop:hover {
    border-color: var(--error-fg, #f85149);
    color: var(--error-fg, #f85149);
  }
  .sp-foot {
    border-top: 1px solid var(--border);
    padding: 6px 8px;
  }
  .sp-new {
    width: 100%;
    padding: 5px 8px;
    border: 1px dashed var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.82em;
    text-align: left;
  }
  .sp-new:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sp-save input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    font-size: 0.82em;
  }
</style>
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run check`
Expected: `0 errors`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ui/StashesOverlay.svelte
git commit -m "feat(stash): StashesOverlay panel component"
```

---

## Task 3: Wire it up — palette command, render, guard, cheat sheet

**Files:**
- Modify: `src/lib/commands.ts` (Stash block)
- Modify: `src/routes/+page.svelte` (import, render, modal guard)
- Modify: `src/lib/shortcuts.ts` (Commit group)

**Interfaces:**
- Consumes: `appState.stashesOpen` (Task 1); `<StashesOverlay />` (Task 2).
- Produces: nothing later tasks depend on.

**Context the implementer needs:**
- The reflog panel wired the same three spots; match it. In `+page.svelte`, `<ReflogOverlay />` is rendered right after `<ShortcutsOverlay />`, its import sits right after the `ShortcutsOverlay` import, and `appState.reflogOpen` is the last term in the modal-suppression guard.

- [ ] **Step 1: Replace the palette Stash block**

In `src/lib/commands.ts`, replace the whole Stash block — currently:

```ts
  // Stash — save plus pop/drop for each existing stash
  cmds.push({ id: "stash.save", title: "Stash: save changes", category: "Stash", run: () => void doStashSave() });
  for (const s of appState.stashes) {
    cmds.push(
      { id: `stash.pop.${s.index}`, title: `Stash: pop — ${s.message}`, category: "Stash", run: () => void doStashApply(s.index, true) },
      { id: `stash.drop.${s.index}`, title: `Stash: drop — ${s.message}`, category: "Stash", run: () => void doStashDrop(s.index) },
    );
  }
```

with:

```ts
  // Stash — quick whole-tree save, plus the panel that lists/manages stashes.
  cmds.push(
    { id: "stash.save", title: "Stash: save changes", category: "Stash", run: () => void doStashSave() },
    { id: "stash.view", title: "View stashes", category: "Stash", run: () => { appState.stashesOpen = true; } },
  );
```

- [ ] **Step 2: Drop the now-unused imports**

In `src/lib/commands.ts`, the `doStashApply` and `doStashDrop` imports were only used by the loop just removed. Remove them from the `./sourceControl` import block so it reads (keep `doStashSave` — `stash.save` still uses it):

```ts
import {
  enterChangesMode,
  changesRepoPath,
  doFetch,
  doPull,
  doPush,
  doStashSave,
  undoLastCommit,
} from "./sourceControl";
```

- [ ] **Step 3: Verify the palette typechecks (catches any missed reference)**

Run: `npm run check`
Expected: `0 errors`. (If it reports `doStashApply`/`doStashDrop` is unused or undefined, reconcile Steps 1–2.)

- [ ] **Step 4: Render the overlay and extend the modal guard**

In `src/routes/+page.svelte`, add the import immediately after the `ShortcutsOverlay` import:

```ts
  import StashesOverlay from "$lib/ui/StashesOverlay.svelte";
```

Render it immediately after `<ReflogOverlay />`:

```svelte
  <StashesOverlay />
```

Then extend the modal-suppression guard — replace:

```ts
      appState.checkoutPrompt ||
      appState.paletteOpen ||
      appState.shortcutsOpen ||
      appState.reflogOpen
    )
      return;
```

with:

```ts
      appState.checkoutPrompt ||
      appState.paletteOpen ||
      appState.shortcutsOpen ||
      appState.reflogOpen ||
      appState.stashesOpen
    )
      return;
```

- [ ] **Step 5: Add the cheat-sheet line**

In `src/lib/shortcuts.ts`, change the `Commit` group so it reads:

```ts
  {
    title: "Commit",
    items: [
      { keys: "Ctrl+Enter", desc: "Commit" },
      { keys: "Ctrl+Shift+P", desc: "Reflog / Undo history (via palette)" },
      { keys: "Ctrl+Shift+P", desc: "View stashes (via palette)" },
    ],
  },
```

- [ ] **Step 6: Verify it typechecks**

Run: `npm run check`
Expected: `0 errors`.

- [ ] **Step 7: Verify the existing suite still passes**

Run: `npm test`
Expected: all tests pass. `src/lib/shortcuts.test.ts` asserts each group is non-empty and well-formed, so the edited `Commit` group must keep valid `{ keys, desc }` entries.

- [ ] **Step 8: Commit**

```bash
git add src/lib/commands.ts src/routes/+page.svelte src/lib/shortcuts.ts
git commit -m "feat(stash): View stashes palette command + overlay wiring"
```

---

## Task 4: Manual E2E verification (human merge gate)

**Files:** none — a human verification pass against a running app.

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: the go/no-go decision for merging.

riff does not unit-test Svelte UI or git operations, so the end-to-end behavior is only provable by running the app.

- [ ] **Step 1: Confirm the automated gates are green**

Run: `npm test && npm run check`
Expected: all tests pass; `0 errors`.

- [ ] **Step 2: Start the app**

Run: `npm run tauri dev`
Expected: the riff window opens against a test repository that has at least two stashes (create some first if needed).

- [ ] **Step 3: Open the panel**

1. Open the command palette (`Ctrl+Shift+P`) and run **View stashes**.
2. Expected: a modal opens listing the current stashes by message. With no stashes it shows "No stashes".

- [ ] **Step 4: Verify the row actions and live update**

1. Click **Apply** on a stash → its changes land in the working tree and the stash **remains** in the list.
2. Click **Pop** on a stash → its changes land and the row **disappears** from the still-open panel.
3. Click **Drop** on a stash → the row disappears with no working-tree change.
4. Expected: after each action the list updates in place without closing the panel.

- [ ] **Step 5: Verify save-new**

1. Dirty the working tree, click **＋ Save new stash**, type `panel test`, press Enter.
2. Expected: a `panel test` stash appears in the list; the working tree is clean.
3. Repeat with an empty message → a stash appears with git's default `WIP on …` subject.

- [ ] **Step 6: Verify Escape and the guard**

1. Open the panel → press Escape → it closes.
2. Reopen → click **＋ Save new stash** → press Escape → the field closes but the panel stays open; press Escape again → the panel closes.

- [ ] **Step 7: Verify no regressions**

1. The sidebar Stashes section still lists stashes and its Pop/Apply/Drop still work.
2. In the command palette, per-stash `Stash: pop — …` / `Stash: drop — …` rows are **gone**; `Stash: save changes` still works.

- [ ] **Step 8: Record the result**

If every check passed, the branch is ready to merge. If any failed, capture what happened and fix it before merging — do not merge on a partial pass.

---

## Self-Review

Checked after writing, against `docs/superpowers/specs/2026-07-22-stashes-panel-design.md`:

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 `StashesOverlay` (modal idiom, load on open, rows Pop/Apply/Drop, empty state, inline save) | Task 2 |
| §2 `stashesOpen` store flag | Task 1 |
| §3 "View stashes" command + remove per-stash pop/drop loop + keep `stash.save` | Task 3 (Steps 1–3) |
| §4 render + modal guard + cheat-sheet line | Task 3 (Steps 4–5) |
| Testing — gates + manual E2E | Task 4 (gates also run in Tasks 1–3) |
| Out of scope (no preview, no stash→branch, sidebar untouched, no toolbar button) | Honored — no task adds them |

No spec requirement is unassigned.

**2. Placeholder scan:** No "TBD", "TODO", "handle edge cases", or "similar to Task N". Every code step carries literal code; every verification step names the exact command and expected result.

**3. Type consistency:** `appState.stashesOpen` is declared in Task 1 and read/written in Tasks 2–3. The overlay calls `doStashApply(s.index, true|false)`, `doStashDrop(s.index)`, `doStashSave(msg || undefined)` — matching the real signatures (`doStashApply(index: number, pop: boolean)`, `doStashDrop(index: number)`, `doStashSave(message?: string, paths?: string[])`). `appState.stashes` items are `{ index, message }`, used as `s.index` / `s.message`. Task 3 removes the `doStashApply`/`doStashDrop` imports from `commands.ts` because the loop that used them is deleted, while keeping `doStashSave` for `stash.save`. Class names in the overlay use a consistent `sp-` prefix throughout.

**Deviation note:** the cheat sheet lists `Ctrl+Shift+P` twice in the Commit group (once for reflog, once for stashes). This matches the pattern the reflog panel already established (both are "reachable via the palette", not literal distinct chords); it is intentional, not a copy error. A future polish could reword these as a single "Command palette" pointer, but that is out of scope here.
