# Discoverability Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface capabilities riff already has but that users cannot find — a visible command-palette entry point, an Amend toggle, an in-app keyboard cheat-sheet, and two new palette commands.

**Architecture:** Frontend-only. No new git capability; this exposes existing backend/lib functions through UI. Four mostly-independent changes plus a pure data module. Spec: `docs/superpowers/specs/2026-07-15-discoverability-pass-design.md`.

**Tech Stack:** SvelteKit, Svelte 5 runes (`$state`/`$derived`/`$effect`), TypeScript, Vitest. Tauri shell (WebView2). CodeMirror is untouched here.

## Global Constraints

- **No `src-tauri` (backend) changes.** Frontend (`src/`) only.
- **Svelte 5 runes**; match existing idioms and CSS tokens (`--bg`, `--fg`, `--border`, `--muted`, `--accent`, `--accent-soft`, `--input-bg`, `--bar-bg`, `--hover`, `--mono`). Model modals on `CommandPalette.svelte`.
- **Preserve the changelists model** — do NOT add a stage/unstage list.
- **Confirmation dialogs use `confirmAction` from `$lib/dialogs`**, never native `window.confirm()` (it returns immediately / silently cancels in WebView2 — documented in `dialogs.ts`).
- **Existing context menus (`RefsSidebar.svelte`, `CommitList.svelte`) stay untouched** (Lean tier).
- **Amend semantics** exactly per spec §2: Amend folds the active changelist's content into HEAD and replaces its message; an empty changelist is a message-only reword; other changelists are untouched.
- **Gates:** `npm test` stays green; `npm run check` stays at 0 errors (1 known benign `@types/node` warning is allowed).

## File Structure

- Create `src/lib/shortcuts.ts` — static shortcut catalog (pure data, single source of truth for the overlay).
- Create `src/lib/shortcuts.test.ts` — Vitest for the catalog.
- Create `src/lib/ui/ShortcutsOverlay.svelte` — cheat-sheet modal.
- Modify `src/lib/store.svelte.ts` — add `shortcutsOpen` flag.
- Modify `src/routes/+page.svelte` — render overlay, `?` key handler, modal-suppression guard.
- Modify `src/lib/ui/InputBar.svelte` — command-palette + `?` buttons.
- Modify `src/lib/ui/CommitBox.svelte` — Amend toggle.
- Modify `src/lib/changelists.ts` — amend path in `commitChangelist`.
- Modify `src/lib/sourceControl.ts` — `undoLastCommit()` + `reset` import.
- Modify `src/lib/commands.ts` — two palette entries.

---

### Task 1: Keyboard shortcut catalog (pure data + test)

**Files:**
- Create: `src/lib/shortcuts.ts`
- Test: `src/lib/shortcuts.test.ts`

**Interfaces:**
- Produces: `interface Shortcut { keys: string; desc: string }`, `interface ShortcutGroup { title: string; items: Shortcut[] }`, `const SHORTCUTS: ShortcutGroup[]`. Consumed by `ShortcutsOverlay.svelte` (Task 2).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/shortcuts.test.ts
import { describe, it, expect } from "vitest";
import { SHORTCUTS } from "./shortcuts";

describe("SHORTCUTS", () => {
  it("has non-empty groups, each with a title and well-formed items", () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
    for (const g of SHORTCUTS) {
      expect(g.title.trim().length).toBeGreaterThan(0);
      expect(g.items.length).toBeGreaterThan(0);
      for (const s of g.items) {
        expect(s.keys.trim().length).toBeGreaterThan(0);
        expect(s.desc.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("documents the palette and shortcuts-overlay triggers", () => {
    const all = SHORTCUTS.flatMap((g) => g.items);
    expect(all.some((s) => s.keys.includes("Ctrl+Shift+P"))).toBe(true);
    expect(all.some((s) => s.keys === "?")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- shortcuts`
Expected: FAIL — cannot resolve `./shortcuts`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/shortcuts.ts
/// Static catalog of the app's keyboard shortcuts, grouped for the in-app
/// cheat-sheet overlay (ShortcutsOverlay.svelte). This only DOCUMENTS the
/// bindings; the handlers themselves live in +page.svelte. Keep in sync when a
/// shortcut is added or changed there.
export interface Shortcut {
  keys: string;
  desc: string;
}
export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "General",
    items: [
      { keys: "Ctrl+Shift+P", desc: "Command palette" },
      { keys: "?", desc: "Keyboard shortcuts" },
      { keys: "Ctrl+Shift+W", desc: "Cycle mode (Changes → Branch → Blame)" },
      { keys: "Ctrl+B", desc: "Toggle refs sidebar" },
      { keys: "F5 / Ctrl+R", desc: "Refresh changes" },
      { keys: "Esc", desc: "Back / exit focus" },
    ],
  },
  {
    title: "Tabs",
    items: [
      { keys: "Ctrl+Tab / Ctrl+Shift+Tab", desc: "Next / previous tab" },
      { keys: "Ctrl+1…9", desc: "Jump to tab" },
    ],
  },
  {
    title: "Diff & files",
    items: [
      { keys: "Ctrl+F", desc: "Search in diff" },
      { keys: "Ctrl+G", desc: "Go to line" },
      { keys: "↑ / ↓", desc: "Previous / next file" },
      { keys: "n / p", desc: "Next / previous change" },
      { keys: "Ctrl +/-/0", desc: "Diff font size" },
      { keys: "Delete", desc: "Discard selected file (Working view)" },
    ],
  },
  {
    title: "Commit",
    items: [{ keys: "Ctrl+Enter", desc: "Commit" }],
  },
  {
    title: "Mouse",
    items: [{ keys: "Back / Forward", desc: "Drill back / forward" }],
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- shortcuts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shortcuts.ts src/lib/shortcuts.test.ts
git commit -m "feat(shortcuts): keyboard shortcut catalog for the cheat-sheet"
```

---

### Task 2: Shortcuts overlay + store flag + key wiring

**Files:**
- Create: `src/lib/ui/ShortcutsOverlay.svelte`
- Modify: `src/lib/store.svelte.ts` (add `shortcutsOpen`, near `paletteOpen` at :171)
- Modify: `src/routes/+page.svelte` (import + render at :430 area; guard at :212; `?` handler after the form-control yield at :268)

**Interfaces:**
- Consumes: `SHORTCUTS` from `$lib/shortcuts` (Task 1); `appState.shortcutsOpen`.
- Produces: `appState.shortcutsOpen` boolean — set `true` by the `?` key/button (Task 3) and the "Keyboard shortcuts" palette command (Task 5).

- [ ] **Step 1: Add the store flag**

In `src/lib/store.svelte.ts`, immediately after `paletteOpen = $state(false);` (:171) add:

```ts
  shortcutsOpen = $state(false);
```

- [ ] **Step 2: Create the overlay component**

```svelte
<!-- src/lib/ui/ShortcutsOverlay.svelte -->
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { SHORTCUTS } from "$lib/shortcuts";

  // Focus the dialog on open so it owns Esc / ? to close (mirrors the palette,
  // which owns keys via its focused input).
  let dialogEl = $state<HTMLDivElement>();
  let wasOpen = false;
  $effect(() => {
    if (appState.shortcutsOpen && !wasOpen) {
      queueMicrotask(() => dialogEl?.focus());
    }
    wasOpen = appState.shortcutsOpen;
  });

  function close() {
    appState.shortcutsOpen = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
</script>

{#if appState.shortcutsOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="sc-backdrop" onclick={close} role="presentation">
    <div
      class="sc"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="sc-head">
        <span>Keyboard shortcuts</span>
        <button type="button" class="sc-x" aria-label="Close" onclick={close}
          >×</button
        >
      </div>
      <div class="sc-body">
        {#each SHORTCUTS as group (group.title)}
          <div class="sc-group">
            <div class="sc-group-title">{group.title}</div>
            {#each group.items as s (s.keys + s.desc)}
              <div class="sc-row">
                <span class="sc-desc">{s.desc}</span>
                <kbd class="sc-keys">{s.keys}</kbd>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .sc-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .sc {
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
  .sc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  .sc-x {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
  }
  .sc-x:hover {
    color: var(--accent);
  }
  .sc-body {
    overflow-y: auto;
    padding: 8px 14px 14px;
  }
  .sc-group {
    margin-top: 10px;
  }
  .sc-group-title {
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .sc-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 3px 0;
    font-size: 0.9em;
  }
  .sc-keys {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--fg);
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  .sc-desc {
    color: var(--fg);
  }
</style>
```

- [ ] **Step 3: Render the overlay in `+page.svelte`**

Add the import beside the existing `CommandPalette` import (:19):

```ts
  import ShortcutsOverlay from "$lib/ui/ShortcutsOverlay.svelte";
```

Add the element immediately after `<CommandPalette />` (:430):

```svelte
  <ShortcutsOverlay />
```

- [ ] **Step 4: Suppress global shortcuts while the overlay is open**

In `onKeyDown`, extend the modal guard (currently `if (appState.checkoutPrompt || appState.paletteOpen) return;` at :212):

```ts
    if (appState.checkoutPrompt || appState.paletteOpen || appState.shortcutsOpen)
      return;
```

- [ ] **Step 5: Add the `?` handler**

In `onKeyDown`, immediately AFTER the form-control yield line `if (tag === "input" || tag === "textarea" || tag === "select") return;` (:268), insert:

```ts
    // `?` (Shift+/) opens the keyboard cheat-sheet. Placed after the
    // form-control yield so typing `?` in an input is untouched.
    if (e.key === "?") {
      appState.shortcutsOpen = true;
      e.preventDefault();
      return;
    }
```

- [ ] **Step 6: Verify**

Run: `npm run check`
Expected: 0 errors (1 known `@types/node` warning allowed).
Manual (dev): pressing `?` opens the overlay listing all groups; `Esc`, `?`, backdrop click, and the × button close it; no app shortcut fires while it is open.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ui/ShortcutsOverlay.svelte src/lib/store.svelte.ts src/routes/+page.svelte
git commit -m "feat(shortcuts): in-app keyboard cheat-sheet overlay (? to open)"
```

---

### Task 3: Command-palette + shortcuts entry-point buttons

**Files:**
- Modify: `src/lib/ui/InputBar.svelte` (mode-bar, after `<SyncControls />` at :119)

**Interfaces:**
- Consumes: `appState.paletteOpen` (existing), `appState.shortcutsOpen` (Task 2). `appState` is already imported in InputBar (:4).

- [ ] **Step 1: Add the two buttons**

In the `<div class="mode-bar">`, immediately after `<SyncControls />` (:119) and before `<span class="mode-hint">` (:120), insert:

```svelte
    <button
      type="button"
      class="bar-btn"
      title="Command palette (Ctrl+Shift+P)"
      aria-label="Open command palette"
      onclick={() => (appState.paletteOpen = true)}
    >
      Commands
    </button>
    <button
      type="button"
      class="bar-btn"
      title="Keyboard shortcuts (?)"
      aria-label="Show keyboard shortcuts"
      onclick={() => (appState.shortcutsOpen = true)}
    >
      ?
    </button>
```

- [ ] **Step 2: Add hover styling**

In InputBar's `<style>` (after the generic `button { cursor: pointer; }` rule near :295), add:

```css
  .bar-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
```

(The buttons inherit base sizing from the component's generic `input, button` rule; only the accent hover is new.)

- [ ] **Step 3: Verify**

Run: `npm run check`
Expected: 0 errors.
Manual (dev): the "Commands" button opens the palette; the "?" button opens the cheat-sheet; tooltips show the chords.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ui/InputBar.svelte
git commit -m "feat(palette): visible command-palette and shortcuts buttons in the top bar"
```

---

### Task 4: Amend toggle in the commit box

**Files:**
- Modify: `src/lib/ui/CommitBox.svelte`
- Modify: `src/lib/changelists.ts` (`commitChangelist`, :243-301)

**Interfaces:**
- Consumes: `appState.commitAmend` (exists, :277 in store), `loadAmendMessage()` from `$lib/sourceControl` (:568), `commit`/`commitPaths`/`stage`/`unstage`/`applyHunks`/`fileHunks`/`fileHunksInList` (already imported in `changelists.ts`).

- [ ] **Step 1: Wire the amend path in `commitChangelist`**

Replace the entire `commitChangelist` function (`src/lib/changelists.ts:243-301`) with:

```ts
/// Commit one changelist with the current commit-box message. A whole-file
/// changelist uses the atomic path-scoped commit; a hunk-split one stages
/// exactly its content into a clean index, then commits it. When
/// `appState.commitAmend` is set, the changelist's content is folded into HEAD
/// and its message replaced (an empty changelist is a message-only reword);
/// other changelists are left untouched.
export async function commitChangelist(id: string): Promise<void> {
  const subject = appState.commitSubject.trim();
  const amend = appState.commitAmend;
  if (!subject || appState.committing) return;
  const files = filesInChangelist(id);
  if (files.length === 0 && !amend) return;
  const repo = changesRepoPath();
  const coauthors = appState.commitCoauthors
    .map((c) => c.trim())
    .filter(Boolean);
  const whole = files.filter((f) => !f.partial).map((f) => f.path);
  const partial = files.filter((f) => f.partial);

  // Stage exactly this changelist (whole files + selected hunks) into a clean
  // index. Shared by the amend and hunk-split paths.
  async function stageIntoIndex(): Promise<void> {
    await unstage(repo, null);
    if (whole.length > 0) await stage(repo, whole);
    for (const f of partial) {
      const sub = fileHunksInList(f.path, id);
      if (!sub || sub.ids.length === 0) continue;
      // Resolve hunk ids → current indices against the (index==HEAD) diff.
      const cur = await fileHunks(repo, f.path, false);
      const idx: number[] = [];
      cur.forEach((h, i) => {
        if (sub.ids.includes(h.id)) idx.push(i);
      });
      if (idx.length > 0) await applyHunks(repo, f.path, false, idx);
    }
  }

  appState.committing = true;
  appState.error = null;
  try {
    if (amend) {
      await stageIntoIndex();
      await commit(
        repo,
        subject,
        appState.commitBody,
        true,
        appState.commitSignoff,
        coauthors,
      );
    } else if (partial.length === 0) {
      await commitPaths(
        repo,
        whole,
        subject,
        appState.commitBody,
        appState.commitSignoff,
        coauthors,
      );
    } else {
      await stageIntoIndex();
      await commit(
        repo,
        subject,
        appState.commitBody,
        false,
        appState.commitSignoff,
        coauthors,
      );
    }
    appState.commitSubject = "";
    appState.commitBody = "";
    appState.commitCoauthors = [];
    appState.commitAmend = false;
    invalidateGraph();
  } catch (e) {
    appState.error = String(e);
  } finally {
    appState.committing = false;
    await loadStatus();
    reconcileChangelists();
  }
}
```

(The `stageIntoIndex` closure is the existing hunk-split staging block, factored out so the amend path reuses it verbatim rather than duplicating it.)

- [ ] **Step 2: Add the Amend toggle to the commit box**

In `src/lib/ui/CommitBox.svelte`, add the import after the existing changelists import (:3):

```ts
  import { loadAmendMessage } from "$lib/sourceControl";
```

Update `canCommit` (:16-18) to allow a message-only reword when amending:

```ts
  const canCommit = $derived(
    subjectLen > 0 &&
      (activeCount > 0 || appState.commitAmend) &&
      !appState.committing,
  );
```

Add the toggle handler in the `<script>` (e.g. after `commit()` at :20-22):

```ts
  // Toggling Amend ON pre-fills HEAD's message; OFF clears the box (that text
  // belonged to the amend, not a new commit).
  function onToggleAmend(e: Event) {
    const on = (e.currentTarget as HTMLInputElement).checked;
    appState.commitAmend = on;
    if (on) {
      void loadAmendMessage();
    } else {
      appState.commitSubject = "";
      appState.commitBody = "";
    }
  }
```

In the `.opts` row, add the checkbox after the Sign-off `<label>` (:79-82):

```svelte
    <label title="Replace the last commit with this content and message (--amend)">
      <input
        type="checkbox"
        checked={appState.commitAmend}
        onchange={onToggleAmend}
      />
      <span>Amend</span>
    </label>
```

Update the commit button label (:95-101) to reflect amend:

```svelte
    {#if appState.committing}
      {appState.commitAmend ? "Amending…" : "Committing…"}
    {:else if appState.commitAmend}
      Amend last commit
    {:else}
      Commit “{activeCl?.name ?? "Default"}” ({activeCount}){branch
        ? ` to ${branch}`
        : ""}
    {/if}
```

- [ ] **Step 3: Verify**

Run: `npm run check`
Expected: 0 errors.
Manual (dev), with a repo that has ≥2 commits:
1. Modify a file, toggle **Amend** → box pre-fills HEAD's message; button reads "Amend last commit".
2. Commit → HEAD is replaced (same parent), now including the change; message updated. `git log` shows no new commit added.
3. With an empty active changelist + Amend on, edit only the subject → commits a message-only reword.
4. Toggle Amend off → box clears; a normal commit still works and leaves other changelists untouched.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ui/CommitBox.svelte src/lib/changelists.ts
git commit -m "feat(commit): expose Amend toggle in the commit box"
```

---

### Task 5: Palette commands — Undo last commit & Keyboard shortcuts

**Files:**
- Modify: `src/lib/sourceControl.ts` (add `reset` to the `./git` import at :2-24; add `undoLastCommit()`)
- Modify: `src/lib/commands.ts` (import `undoLastCommit`; add two entries)

**Interfaces:**
- Consumes: `reset` from `$lib/git` (`reset(path, target, mode)`), `confirmAction` from `$lib/dialogs` (already imported in `sourceControl.ts` at :30), `changesRepoPath`/`invalidateGraph`/`loadStatus` (in scope), `appState.shortcutsOpen` (Task 2).
- Produces: `undoLastCommit()` exported from `sourceControl.ts`.

- [ ] **Step 1: Import `reset` in `sourceControl.ts`**

In the `from "./git"` block (:2-24), add `reset,` in alphabetical position (after `push as pushCmd,` at :14):

```ts
  push as pushCmd,
  reset,
  stage as stageCmd,
```

- [ ] **Step 2: Add `undoLastCommit()`**

Append after `loadAmendMessage()` (ends ~:582) in `sourceControl.ts`:

```ts
/// Undo the last commit, keeping its changes in the working tree
/// (`git reset --soft HEAD~1`). Confirms first via the Tauri dialog (native
/// confirm silently cancels in WebView2). HEAD moves, so the graph cache is
/// invalidated and status reloaded.
export async function undoLastCommit(): Promise<void> {
  const ok = await confirmAction(
    "Undo the last commit? Its changes stay in your working tree.",
    { title: "Undo last commit" },
  );
  if (!ok) return;
  appState.error = null;
  try {
    await reset(changesRepoPath(), "HEAD~1", "soft");
    invalidateGraph();
  } catch (e) {
    appState.error = String(e);
  } finally {
    await loadStatus();
  }
}
```

- [ ] **Step 3: Add the palette entries**

In `src/lib/commands.ts`, add `undoLastCommit` to the `./sourceControl` import (:2-11):

```ts
  doStashDrop,
  undoLastCommit,
} from "./sourceControl";
```

After the Stash block (`cmds.push({ id: "stash.save" ... })` and its loop, ending ~:104), and before the Checkout loop, add:

```ts
  // Commit history / help
  cmds.push(
    {
      id: "commit.undo",
      title: "Undo last commit",
      category: "Commit",
      run: () => void undoLastCommit(),
    },
    {
      id: "help.shortcuts",
      title: "Keyboard shortcuts",
      category: "Help",
      run: () => {
        appState.shortcutsOpen = true;
      },
    },
  );
```

- [ ] **Step 4: Verify**

Run: `npm run check`
Expected: 0 errors.
Manual (dev): open the palette → "Undo last commit" and "Keyboard shortcuts" appear. "Undo last commit" prompts (Tauri dialog); confirming soft-resets HEAD~1 with changes preserved in the working tree. "Keyboard shortcuts" opens the overlay.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sourceControl.ts src/lib/commands.ts
git commit -m "feat(palette): add Undo last commit and Keyboard shortcuts commands"
```

---

### Task 6: Manual E2E verification (merge gate)

**No code.** Human-run in `npm run tauri dev`; this is the merge gate (the component tasks have no headless coverage).

- [ ] Command palette opens from the **Commands** button (not just `Ctrl+Shift+P`).
- [ ] `?` key and the **?** button both open the shortcuts overlay; it lists every group; `Esc`/`?`/backdrop/× all close it; no app shortcut fires while open.
- [ ] Amend: toggle pre-fills HEAD's message; committing amends content **and** message (no new commit added); empty-changelist reword works; toggling off clears the box; a normal commit is unaffected and leaves other changelists intact.
- [ ] "Undo last commit" in the palette prompts, then soft-resets HEAD~1 leaving changes staged/in the working tree; the graph refreshes.
- [ ] `npm test` green; `npm run check` 0 errors.

---

## Self-Review

- **Spec coverage:** §1 palette entry point → Task 3; §2 amend → Task 4; §3 cheat-sheet → Tasks 1-2; §4 two palette commands → Task 5. Manual E2E gate → Task 6. All covered.
- **No placeholders:** every code step is complete.
- **Type consistency:** `SHORTCUTS`/`Shortcut`/`ShortcutGroup` used identically in Tasks 1-2; `appState.shortcutsOpen` introduced in Task 2 and consumed in Tasks 3 & 5; `undoLastCommit` produced in Task 5 Step 2, imported in Step 3; `reset(path, target, mode)` matches `git.ts:196`; `commit(path, subject, body, amend, signoff, coauthors)` matches `git.ts:467`; `confirmAction(message, opts)` matches `dialogs.ts:9`.
