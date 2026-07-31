# Multi-select Stash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select several working-tree files in the Changes list with Ctrl/Shift+click and stash (or move) them together, leaving unselected changes alone.

**Architecture:** All the git plumbing already exists — `stash_save` takes a pathspec end to end, and `doStashSave(message?, paths?)` already forwards an array. The only missing piece is a selection model in the UI. A new pure module (`changesSelect.ts`) holds the click algebra and is unit-tested; `ChangesList.svelte` folds pointer events through it, reading the on-screen row order straight from the DOM so range fills always match what is rendered. One store field (`changesSelectedPaths`) exposes the selection to the global `Esc` handler. **`src-tauri` is not touched.**

**Tech Stack:** SvelteKit + Svelte 5 runes (`$state`, `$derived`) + TypeScript + Vitest. (Tauri 2 / Rust untouched.)

**Spec:** `docs/superpowers/specs/2026-07-30-multi-select-stash-design.md`

## Global Constraints

- **EMPTY set means single-selection mode.** `appState.changesSelectedPaths` is populated **only** by Ctrl/Shift+click. A plain click clears it. This invariant is load-bearing: it is why `selectedFile` keeps its meaning (it drives the diff pane) and why adding `Esc → clear selection` cannot shadow the existing `Esc → drill-in pop / exit Focus`.
- **Never read the raw store set for an action.** Every read goes through the pruned `sel` derived in `ChangesList.svelte`, so a path that is no longer changed can never reach a git call.
- **On-screen order comes from the DOM**, via `[data-path]` in document order. Do not build a second ordering pass alongside the render logic — it will drift from collapsed changelists / collapsed directories / flat-vs-tree.
- **Conflict rows must never carry `data-path`.** `git stash` fails on unmerged paths; the missing attribute is what keeps conflicted files out of every selection.
- **Single-file behavior must not change.** Plain click, `↑`/`↓`, the single-file context menu, the single-file stash form (including empty-message-defaults-to-path), single-file drag, the sidebar `＋` whole-tree stash, and the palette "Stash: save changes" all behave exactly as before.
- **Mouse only.** Do not add `Shift+↑/↓` or `Ctrl+A`; do not touch `moveSelection` in `+page.svelte`. `Esc` is the only new key.
- **Never use native `window.confirm()`** — use `confirmAction` from `$lib/dialogs` (no confirm is needed in this feature).
- **Gates that must stay green:** `npm test` and `npm run check` (0 errors; the one pre-existing benign `@types/node` warning is allowed).
- Out of scope, must not appear: multi-file **discard**, hunk-level stash, a dedicated changelist-level stash button, row checkboxes, multi-select in any other view.
- **CHANGELOG.md is not touched by this plan.** This repo writes CHANGELOG entries in the `release: vX.Y.Z` commit (see `d1074c7`), not in feature commits.

---

## File Structure

**New (`src/lib/ui/`)**
- `changesSelect.ts` — pure selection algebra. No Svelte, no DOM, no store imports. Owns `ClickKind`, `SelectState`, `applyClick`, `defaultStashMessage`.
- `changesSelect.test.ts` — vitest for the above.

**Modified**
- `src/lib/store.svelte.ts` — one field, `changesSelectedPaths`.
- `src/lib/sourceControl.ts` — reset the selection in `setChangesRepo`.
- `src/routes/+page.svelte` — `Esc` clears the selection.
- `src/lib/changelists.ts` — `moveFilesToChangelist(paths, targetId)`; `moveFileToChangelist` delegates to it.
- `src/lib/ui/ChangesList.svelte` — the bulk of the work: click wiring, `data-path`, row highlight, selection action bar, selection-aware context menu, N-file stash form, multi-drag.
- `src/lib/shortcuts.ts` — one cheat-sheet line.
- `README.md` — two bullets in §3 (Changes 모드).

**Task order:** 1 → 2 → 3 → 4 → 5 → 6. Strictly sequential: Task 2 imports Task 1's module, Task 3 calls Task 2's `sel`/`anchor`, Task 4 reuses Task 3's `moveFilesToChangelist`, Task 6 gates the lot. Run in numeric order.

**Why `ChangesList.svelte` is not split up:** it is one component owning one list; the selection, its menu, its form and its drag all mutate the same local state. The spec's split is by *deliverable* (select → act → drag), not by file.

---

## Task 1: Pure selection module (`changesSelect.ts`)

**Files:**
- Create: `src/lib/ui/changesSelect.ts`
- Test: `src/lib/ui/changesSelect.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ClickKind = "plain" | "toggle" | "range"`
  - `interface SelectState { selected: Set<string>; anchor: string | null }`
  - `applyClick(kind: ClickKind, state: SelectState, current: string | null, path: string, order: string[]): SelectState`
  - `defaultStashMessage(paths: string[]): string`

  Task 2 calls `applyClick`; Task 3 calls `defaultStashMessage`.

**Context the implementer needs:**
- Vitest here runs in a plain `node` environment with **no** SvelteKit plugin (`vitest.config.js`). Keep this module free of `$lib/…` imports, Svelte runes, and DOM APIs — that is the whole reason it exists as a separate file.
- `order` is the list of paths **currently rendered**, in screen order. Anything not on screen (a collapsed changelist, a collapsed directory, a conflicted file) is simply absent from it, so range fills can never reach those rows. That is by design, not an oversight.
- `current` is the singly-selected path (`appState.selectedFile?.path`). It exists so the first Ctrl/Shift+click can promote the existing single selection into a multi-selection instead of discarding it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ui/changesSelect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyClick, defaultStashMessage } from "./changesSelect";

// Four files rendered in one changelist, in this on-screen order.
const ORDER = ["a.ts", "b.ts", "c.ts", "d.ts"];
// Ordinary single-selection mode: nothing multi-selected, no anchor yet.
const empty = { selected: new Set<string>(), anchor: null };

describe("applyClick", () => {
  it("a plain click drops back to single selection", () => {
    const r = applyClick(
      "plain",
      { selected: new Set(["a.ts", "b.ts"]), anchor: "a.ts" },
      "b.ts",
      "c.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual([]);
    expect(r.anchor).toBe("c.ts");
  });

  it("the first Ctrl+click seeds the set from the single selection", () => {
    const r = applyClick("toggle", empty, "a.ts", "c.ts", ORDER);
    expect([...r.selected].sort()).toEqual(["a.ts", "c.ts"]);
    expect(r.anchor).toBe("c.ts");
  });

  it("Ctrl+click with no single selection starts from the clicked file", () => {
    const r = applyClick("toggle", empty, null, "b.ts", ORDER);
    expect([...r.selected]).toEqual(["b.ts"]);
  });

  it("Ctrl+click removes an already-selected file", () => {
    const r = applyClick(
      "toggle",
      { selected: new Set(["a.ts", "b.ts"]), anchor: "b.ts" },
      "b.ts",
      "a.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual(["b.ts"]);
  });

  it("Ctrl+click on the only selected file empties the set", () => {
    const r = applyClick("toggle", empty, "a.ts", "a.ts", ORDER);
    expect(r.selected.size).toBe(0);
  });

  it("Shift+click fills the range forward, inclusive", () => {
    const r = applyClick(
      "range",
      { selected: new Set(["a.ts"]), anchor: "a.ts" },
      "a.ts",
      "c.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(r.anchor).toBe("a.ts");
  });

  it("Shift+click fills the range backward too", () => {
    const r = applyClick(
      "range",
      { selected: new Set(["d.ts"]), anchor: "d.ts" },
      "d.ts",
      "b.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(r.anchor).toBe("d.ts");
  });

  it("Shift+click with no anchor pivots on the single selection", () => {
    const r = applyClick("range", empty, "b.ts", "d.ts", ORDER);
    expect([...r.selected]).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(r.anchor).toBe("b.ts");
  });

  it("Shift+click with neither anchor nor single selection takes one file", () => {
    const r = applyClick("range", empty, null, "c.ts", ORDER);
    expect([...r.selected]).toEqual(["c.ts"]);
    expect(r.anchor).toBe("c.ts");
  });

  it("falls back to one file when the anchor is no longer on screen", () => {
    // "gone.ts" was the anchor before its changelist got collapsed.
    const r = applyClick(
      "range",
      { selected: new Set(["gone.ts"]), anchor: "gone.ts" },
      "gone.ts",
      "c.ts",
      ORDER,
    );
    expect([...r.selected]).toEqual(["c.ts"]);
    expect(r.anchor).toBe("c.ts");
  });

  it("a range only spans rows that are on screen", () => {
    // Conflicted and collapsed rows never enter `order`, so a range cannot
    // select them even when they sit between the two ends visually.
    const r = applyClick(
      "range",
      { selected: new Set<string>(), anchor: "a.ts" },
      "a.ts",
      "d.ts",
      ["a.ts", "d.ts"],
    );
    expect([...r.selected]).toEqual(["a.ts", "d.ts"]);
  });
});

describe("defaultStashMessage", () => {
  it("uses the path itself for one file", () => {
    expect(defaultStashMessage(["src/lib/git.ts"])).toBe("src/lib/git.ts");
  });

  it("summarises several files by basename", () => {
    expect(defaultStashMessage(["src/lib/git.ts", "src/lib/store.ts"])).toBe(
      "2 files: git.ts, store.ts",
    );
  });

  it("caps the name list at three", () => {
    expect(
      defaultStashMessage(["a/1.ts", "a/2.ts", "a/3.ts", "a/4.ts", "a/5.ts"]),
    ).toBe("5 files: 1.ts, 2.ts, 3.ts, +2 more");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/ui/changesSelect.test.ts`
Expected: FAIL — the run errors out because `./changesSelect` cannot be resolved.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ui/changesSelect.ts`:

```ts
/// Pure selection algebra for the Changes list's Ctrl/Shift+click multi-select.
/// Deliberately free of Svelte, DOM and store imports: the component supplies
/// the on-screen row order and folds each click through `applyClick`, which
/// keeps the fiddly parts (range direction, anchor fallback, seeding from the
/// single selection) unit-testable.

/** Which modifier the user held: plain click, Ctrl/Cmd+click, Shift+click. */
export type ClickKind = "plain" | "toggle" | "range";

export interface SelectState {
  /** Selected paths. EMPTY means ordinary single-selection mode. */
  selected: Set<string>;
  /** Pivot for a range fill; null until a click sets one. */
  anchor: string | null;
}

/**
 * Fold one click into the multi-selection.
 *
 * `current` is the singly-selected path (the file the diff pane shows); it
 * seeds the set when the first Ctrl/Shift+click promotes single-selection into
 * a multi-selection. `order` is the on-screen row order — rows missing from it
 * (collapsed groups, conflicts) can never end up selected.
 */
export function applyClick(
  kind: ClickKind,
  state: SelectState,
  current: string | null,
  path: string,
  order: string[],
): SelectState {
  // A plain click is the way back to single selection.
  if (kind === "plain") return { selected: new Set(), anchor: path };

  if (kind === "toggle") {
    const base =
      state.selected.size > 0
        ? new Set(state.selected)
        : new Set(current ? [current] : []);
    if (base.has(path)) base.delete(path);
    else base.add(path);
    return { selected: base, anchor: path };
  }

  // range: fill from the pivot to the clicked row, in either direction. If
  // either end is off screen (its group was collapsed since the anchor was
  // set), select just the clicked row rather than guessing at a span.
  const pivot = state.anchor ?? current ?? path;
  const from = order.indexOf(pivot);
  const to = order.indexOf(path);
  if (from < 0 || to < 0) return { selected: new Set([path]), anchor: path };
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { selected: new Set(order.slice(lo, hi + 1)), anchor: pivot };
}

/**
 * Default stash subject when the message field is submitted empty: the path
 * itself for one file (so a single-file stash reads exactly as it did before),
 * a basename summary for several.
 */
export function defaultStashMessage(paths: string[]): string {
  if (paths.length === 1) return paths[0];
  const names = paths.slice(0, 3).map((p) => {
    const i = p.lastIndexOf("/");
    return i < 0 ? p : p.slice(i + 1);
  });
  const more = paths.length > 3 ? `, +${paths.length - 3} more` : "";
  return `${paths.length} files: ${names.join(", ")}${more}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/ui/changesSelect.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Run the full gates**

Run: `npm test`
Expected: every suite passes.

Run: `npm run check`
Expected: `0 errors`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ui/changesSelect.ts src/lib/ui/changesSelect.test.ts
git commit -m "feat(changes): pure selection algebra for multi-select"
```

---

## Task 2: Selection state and click wiring

**Files:**
- Modify: `src/lib/store.svelte.ts` (add a field after `changesRepoIdx`, around line 239)
- Modify: `src/lib/sourceControl.ts` (`setChangesRepo`, around line 66)
- Modify: `src/routes/+page.svelte` (the `Escape` branch, around line 325)
- Modify: `src/lib/ui/ChangesList.svelte` (import, `sel` derived, click handlers, `data-path`, `.multi` class + CSS, drag guard)

**Interfaces:**
- Consumes: `applyClick`, `type ClickKind` from Task 1.
- Produces, for Tasks 3–4 (all inside `ChangesList.svelte` unless noted):
  - `appState.changesSelectedPaths: Set<string>` (store) — the raw selection.
  - `const sel: Set<string>` — the pruned derived every action must read.
  - `let anchor: string | null` — the range pivot.
  - `function rowOrder(): string[]` — on-screen paths in document order.

**Context the implementer needs:**
- `byPath` (`ChangesList.svelte:26`) is the existing `path → StatusEntry` map. `sel` filters through it, which is what makes a stashed path drop out of the selection with no `$effect`.
- `pick(path)` (`ChangesList.svelte:50`) is the existing "select this file for the diff pane" helper. Every click still calls it, so the diff always follows the last-clicked row.
- The `<script>` block declares `$state` with e.g. `let graphRowEl = $state<HTMLDivElement | null>(null);` (see `+page.svelte:87`) and binds it with `bind:this` — follow that shape for `rootEl`.
- The `Escape` handler in `+page.svelte` sits **after** the form-control yield (`+page.svelte:278`), so Escape typed inside the stash message input never reaches it — that input keeps its own `onkeydown`.
- After this task the user can multi-select and see it, but cannot act on the selection yet. That is the intended increment; Task 3 adds the actions.

- [ ] **Step 1: Add the store field**

In `src/lib/store.svelte.ts`, immediately after the `changesRepoIdx = $state(0);` line (and its comment block), insert:

```ts
  // Ad-hoc multi-selection in the Changes list, for bulk stash / move. EMPTY is
  // the normal single-selection mode — only Ctrl/Shift+click populates it. That
  // invariant keeps `selectedFile` (which drives the diff pane) unchanged, and
  // keeps Esc from swallowing a drill-in pop when nothing is multi-selected.
  // Session-only.
  changesSelectedPaths = $state(new Set<string>());
```

- [ ] **Step 2: Reset the selection on a repo switch**

In `src/lib/sourceControl.ts`, inside `setChangesRepo`, immediately after the line `appState.selectedFile = null;`, insert:

```ts
  appState.changesSelectedPaths = new Set();
```

- [ ] **Step 3: Let Escape clear the selection**

In `src/routes/+page.svelte`, the `Escape` branch currently opens like this:

```js
    if (e.key === "Escape" && !e.defaultPrevented) {
      if (appState.history.length > 0) {
```

Replace those two lines with:

```js
    if (e.key === "Escape" && !e.defaultPrevented) {
      // A multi-selection in the Changes list is the innermost thing Esc backs
      // out of. `changesSelectedPaths` is empty in ordinary single-selection,
      // so this never shadows the drill-in / Focus behavior below.
      if (
        appState.appMode === "changes" &&
        appState.changesSelectedPaths.size > 0
      ) {
        appState.changesSelectedPaths = new Set();
        e.preventDefault();
        return;
      }
      if (appState.history.length > 0) {
```

- [ ] **Step 4: Import the selection module into ChangesList**

In `src/lib/ui/ChangesList.svelte`, immediately after the line

```ts
  import { buildPathTree, type TreePathNode } from "./pathTree";
```

insert:

```ts
  import { applyClick, type ClickKind } from "./changesSelect";
```

- [ ] **Step 5: Add the pruned `sel` derived**

In the same file, immediately after the `byPath` derived block (the one that ends `return m;\n  });`), insert:

```ts
  // The multi-selection, pruned to files that are still changed. Every read
  // goes through this — never the raw store set — so a path that has just been
  // stashed or committed cannot reach a git call, and no $effect is needed to
  // clean up after a refresh.
  const sel = $derived(
    new Set([...appState.changesSelectedPaths].filter((p) => byPath.has(p))),
  );
```

- [ ] **Step 6: Add the row-order reader and the click handler**

In the same file, immediately after the `pick` function (the three-line one that ends `if (e) selectChange(entryToChangedFile(e, "unstaged"), "unstaged");\n  }`), insert:

```ts
  // On-screen row order, read straight from the DOM so a range fill always
  // matches what the user sees — collapsed changelists, collapsed directories
  // and flat-vs-tree all fall out for free. Conflict rows carry no data-path,
  // so they can never be selected (git stash fails on unmerged paths).
  let rootEl = $state<HTMLElement | null>(null);
  function rowOrder(): string[] {
    if (!rootEl) return [];
    return [...rootEl.querySelectorAll<HTMLElement>("[data-path]")].map(
      (el) => el.dataset.path ?? "",
    );
  }

  // Ctrl/Cmd+click toggles a file, Shift+click fills the range from the anchor,
  // a plain click drops back to single selection. The diff pane always follows
  // the clicked row.
  let anchor = $state<string | null>(null);
  function onRowClick(e: MouseEvent, path: string) {
    const kind: ClickKind = e.shiftKey
      ? "range"
      : e.ctrlKey || e.metaKey
        ? "toggle"
        : "plain";
    const next = applyClick(
      kind,
      { selected: appState.changesSelectedPaths, anchor },
      appState.selectedFile?.path ?? null,
      path,
      rowOrder(),
    );
    appState.changesSelectedPaths = next.selected;
    anchor = next.anchor;
    pick(path);
  }
```

- [ ] **Step 7: Do not start a drag while selecting**

In the same file, replace the first line of `onFilePointerDown`:

```ts
    if (e.button !== 0) return;
```

with:

```ts
    // A modifier-click is a selection gesture, not the start of a drag.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
```

- [ ] **Step 8: Mark and tag the file rows**

In the same file's `fileRow` snippet, replace:

```svelte
    <div class="cl-file" class:active={isSel(path)}>
```

with:

```svelte
    <div
      class="cl-file"
      class:active={isSel(path)}
      class:multi={sel.has(path)}
      data-path={path}
    >
```

Then, in the same snippet, replace the row button's click handler:

```svelte
        onclick={() => pick(path)}
```

with:

```svelte
        onclick={(ev) => onRowClick(ev, path)}
```

**Do not** add `data-path` to the Conflicts group's rows (the separate `<div class="cl-file" class:active={isSel(e.path)}>` inside the `{#if conflicts.length > 0}` block) — leave that block untouched.

- [ ] **Step 9: Bind the root element**

In the same file, replace:

```svelte
<div class="cl-root">
```

with:

```svelte
<div class="cl-root" bind:this={rootEl}>
```

- [ ] **Step 10: Style the selected rows**

In the same file's `<style>` block, immediately **before** the `.cl-file.active { … }` rule, insert:

```css
  .cl-file.multi {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }
```

- [ ] **Step 11: Verify it typechecks and the suite passes**

Run: `npm run check`
Expected: `0 errors`.

Run: `npm test`
Expected: all tests pass (Task 1's suite included; this task adds none — it is UI wiring, which riff does not unit-test).

- [ ] **Step 12: Commit**

```bash
git add src/lib/store.svelte.ts src/lib/sourceControl.ts src/routes/+page.svelte src/lib/ui/ChangesList.svelte
git commit -m "feat(changes): Ctrl/Shift+click multi-select in the Changes list"
```

---

## Task 3: Act on the selection — bulk move helper, menu, action bar, N-file stash

**Files:**
- Modify: `src/lib/changelists.ts` (`moveFileToChangelist`, around line 190)
- Modify: `src/lib/ui/ChangesList.svelte` (imports, menu state + handlers, stash state + handlers, action bar markup, menu markup, form markup, CSS)

**Interfaces:**
- Consumes: `sel`, `anchor`, `pick`, `currentListOf` (existing), `defaultStashMessage` (Task 1), `doStashSave(message?, paths?)` (existing, already variadic).
- Produces:
  - `moveFilesToChangelist(filePaths: string[], targetId: string): void` in `src/lib/changelists.ts` — Task 4's drag drop calls it.
  - `let dragPath` keeps its current single-path shape here; Task 4 widens it.

**Context the implementer needs:**
- `moveFileToChangelist` calls `persist()` (a backend write) once per invocation, so looping it over N files would issue N writes. That is why the plural function exists.
- The existing `moveMenu` handlers read `moveMenu` **inside** the handler behind an `if (moveMenu)` guard rather than capturing it in the click closure — keep that shape, it is what avoids a "possibly null" typecheck error.
- The stash field deliberately has **no `onblur` submit** (unlike the changelist-create form): blur-to-stash would set files aside on an accidental focus loss. Enter submits, Escape cancels.
- `openMove` is wired to `oncontextmenu` on the row button and already calls `e.preventDefault()`. Keep that.
- After this task, `sel.size > 0` shows the action bar and both the bar and the context menu act on the whole selection. Drag still moves one file — Task 4 finishes that.

- [ ] **Step 1: Add the bulk move helper**

In `src/lib/changelists.ts`, replace the whole `moveFileToChangelist` function with:

```ts
/// Move several files into `targetId` in one pass. One map + one persist, so a
/// bulk move costs a single backend write instead of one per file. A path can
/// only live in one list, so every other list drops the moved paths.
export function moveFilesToChangelist(
  filePaths: string[],
  targetId: string,
): void {
  const moving = new Set(filePaths);
  appState.changelists = appState.changelists.map((l) => ({
    ...l,
    files:
      l.id === targetId
        ? [...l.files, ...filePaths.filter((p) => !l.files.includes(p))]
        : l.files.filter((f) => !moving.has(f)),
  }));
  void persist();
}
```

The singular `moveFileToChangelist` is **replaced, not kept**: its only two
call sites are both in `ChangesList.svelte` and both move to the plural form in
Tasks 3–4, so leaving a delegating wrapper would ship a dead export. Delete the
old function and its doc comment entirely; carry over anything still accurate
from that comment into the one above.

- [ ] **Step 2: Update the ChangesList imports**

In `src/lib/ui/ChangesList.svelte`, replace `moveFileToChangelist,` in the `$lib/changelists` import block with:

```ts
    moveFilesToChangelist,
```

(The list is alphabetised — `moveFilesToChangelist` sorts into the same slot.)

Then replace the `./changesSelect` import line with:

```ts
  import {
    applyClick,
    defaultStashMessage,
    type ClickKind,
  } from "./changesSelect";
```

- [ ] **Step 3: Make the context menu selection-aware**

In the same file, replace the whole `moveMenu` block — the comment, the `let moveMenu`, `openMove` and `moveTo` — with:

```ts
  // Move / stash menu (HTML5 drag is intercepted by Tauri's file-drop; a menu
  // is reliable). `paths` is the whole multi-selection when the click landed
  // inside it, else just the clicked file.
  let moveMenu = $state<{ x: number; y: number; paths: string[] } | null>(null);
  function openMove(e: MouseEvent, path: string) {
    e.preventDefault();
    if (sel.has(path)) {
      moveMenu = { x: e.clientX, y: e.clientY, paths: [...sel] };
      return;
    }
    // Right-clicking outside the selection re-selects that one row, so the
    // menu can never act on files the user is no longer pointing at.
    appState.changesSelectedPaths = new Set();
    anchor = path;
    pick(path);
    moveMenu = { x: e.clientX, y: e.clientY, paths: [path] };
  }
  function moveTo(targetId: string) {
    // The selection survives a move — regrouping and then stashing is common.
    if (moveMenu) moveFilesToChangelist(moveMenu.paths, targetId);
    moveMenu = null;
  }
```

- [ ] **Step 4: Widen the stash state to N files**

In the same file, replace the whole single-file stash block — the comment, `let stashingPath`, `let stashMsg`, `openStash` and `submitStash` — with:

```ts
  // Stash the selection (or one file): open an inline message field, then stash
  // just those paths. An empty message falls back to a generated subject so the
  // entry is identifiable in the stash list.
  let stashTargets = $state<string[] | null>(null);
  let stashMsg = $state("");
  function openStash() {
    if (!moveMenu) return;
    stashTargets = moveMenu.paths;
    stashMsg = "";
    moveMenu = null;
  }
  function stashSelection() {
    stashTargets = [...sel];
    stashMsg = "";
  }
  function cancelStash() {
    stashTargets = null;
    stashMsg = "";
  }
  function submitStash() {
    const paths = stashTargets;
    stashTargets = null;
    if (!paths || paths.length === 0) return;
    const m = stashMsg.trim() || defaultStashMessage(paths);
    stashMsg = "";
    appState.changesSelectedPaths = new Set();
    anchor = null;
    void doStashSave(m, paths);
  }
```

- [ ] **Step 5: Keep the drag drop compiling against the plural helper**

In the same file, inside `onWinPointerUp`, replace:

```ts
      if (target) moveFileToChangelist(dragPath, target);
```

with:

```ts
      if (target) moveFilesToChangelist([dragPath], target);
```

(Behavior is identical; Task 4 replaces `[dragPath]` with the whole selection.)

- [ ] **Step 6: Render the N-file stash form and the action bar**

In the same file, replace the whole `{#if stashingPath} … {/if}` block at the top of `.cl-root` with:

```svelte
  {#if stashTargets}
    {@const n = stashTargets.length}
    <form class="cl-stash" onsubmit={(e) => (e.preventDefault(), submitStash())}>
      <span class="cl-stash-label" title={stashTargets.join("\n")}>
        {n > 1 ? `Stash ${n} files:` : `Stash ${stashTargets[0]}:`}
      </span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        bind:value={stashMsg}
        placeholder="message (optional)"
        aria-label="Stash message"
        onkeydown={(e) => e.key === "Escape" && cancelStash()}
      />
    </form>
  {/if}
  {#if sel.size > 0}
    <div class="cl-selbar">
      <span class="cl-selcount">{sel.size} selected</span>
      <button type="button" class="cl-selact" onclick={stashSelection}>
        Stash…
      </button>
      <button
        type="button"
        class="cl-selact"
        onclick={() => (appState.changesSelectedPaths = new Set())}
      >
        Clear
      </button>
    </div>
  {/if}
```

- [ ] **Step 7: Make the menu markup count-aware**

In the same file, replace the whole `{#if moveMenu} … {/if}` block near the bottom with:

Note the `{@const paths = moveMenu.paths}` hoist: the original code bound
`{@const cur = …}` at the `{#if}` level for the same reason — reading
`moveMenu.…` from inside the nested `{#each}` can lose the null-narrowing that
the `{#if}` established, which svelte-check reports as "possibly null".

```svelte
{#if moveMenu}
  {@const paths = moveMenu.paths}
  {@const n = paths.length}
  <div class="cl-menu" style="left: {moveMenu.x}px; top: {moveMenu.y}px" role="menu">
    <div class="cl-menu-head">
      {n > 1 ? `Move ${n} files to` : "Move to changelist"}
    </div>
    {#each appState.changelists as l (l.id)}
      {@const here = paths.every((p) => currentListOf(p) === l.id)}
      <button
        type="button"
        role="menuitem"
        disabled={here}
        onclick={() => moveTo(l.id)}
      >
        {here ? "● " : ""}{l.name}
      </button>
    {/each}
    <div class="cl-menu-sep"></div>
    <button type="button" role="menuitem" onclick={openStash}>
      {n > 1 ? `Stash ${n} files…` : "Stash this file…"}
    </button>
  </div>
{/if}
```

- [ ] **Step 8: Add the action-bar CSS**

In the same file's `<style>` block, immediately after the `.cl-stash input { … }` rule, insert:

```css
  .cl-selbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
  }
  .cl-selcount {
    flex: 1;
    min-width: 0;
    font-size: 0.8em;
    color: var(--accent);
  }
  .cl-selact {
    flex: 0 0 auto;
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.78em;
  }
  .cl-selact:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
```

- [ ] **Step 9: Verify it typechecks and the suite passes**

Run: `npm run check`
Expected: `0 errors`. If it reports an unused `currentListOf`, that means Step 7's `{@const here = …}` was not applied — fix that rather than deleting the function.

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/lib/changelists.ts src/lib/ui/ChangesList.svelte
git commit -m "feat(stash): stash and move the whole Changes selection"
```

---

## Task 4: Drag the whole selection

**Files:**
- Modify: `src/lib/ui/ChangesList.svelte` (`dragPath` → `dragPaths`, ghost label, drop)

**Interfaces:**
- Consumes: `sel` (Task 2), `moveFilesToChangelist` (Task 3), the existing `groupUnder`, `basename`, `pending`, `DRAG_THRESHOLD`.
- Produces: nothing new for later tasks.

**Context the implementer needs:**
- `dragPath` is referenced only inside the `<script>` block (`onWinPointerMove`, `onWinPointerUp`); the template reads `ghost` and `dropList`, not `dragPath`. So renaming it does not touch the markup.
- Dragging an **unselected** row must drag that row alone and leave the selection untouched. Unlike the context menu, a drag shows no list of targets, so silently dropping the user's selection mid-drag would be the surprising choice.

- [ ] **Step 1: Widen the drag state**

In `src/lib/ui/ChangesList.svelte`, replace:

```ts
  let dragPath = $state<string | null>(null);
```

with:

```ts
  let dragPaths = $state<string[] | null>(null);
```

- [ ] **Step 2: Add the ghost label helper**

In the same file, immediately after the `basename` function (the last function in the `<script>` block), insert:

```ts
  function dragLabel(paths: string[]): string {
    return paths.length > 1 ? `${paths.length} files` : basename(paths[0]);
  }
```

- [ ] **Step 3: Start a multi-drag**

In the same file, replace the whole `onWinPointerMove` function with:

```ts
  function onWinPointerMove(e: PointerEvent) {
    if (dragPaths) {
      ghost = { x: e.clientX, y: e.clientY, label: dragLabel(dragPaths) };
      dropList = groupUnder(e.clientX, e.clientY);
      return;
    }
    if (!pending) return;
    const dx = e.clientX - pending.x;
    const dy = e.clientY - pending.y;
    if (dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
      // Dragging a selected row drags the whole selection; an unselected row
      // drags alone and leaves the selection untouched.
      dragPaths = sel.has(pending.path) ? [...sel] : [pending.path];
      ghost = { x: e.clientX, y: e.clientY, label: dragLabel(dragPaths) };
      pending = null;
    }
  }
```

- [ ] **Step 4: Drop the whole selection**

In the same file, replace the whole `onWinPointerUp` function with:

```ts
  function onWinPointerUp(e: PointerEvent) {
    if (dragPaths) {
      const target = groupUnder(e.clientX, e.clientY);
      if (target) moveFilesToChangelist(dragPaths, target);
      dragPaths = null;
      ghost = null;
      dropList = null;
    }
    pending = null;
  }
```

- [ ] **Step 5: Verify it typechecks and the suite passes**

Run: `npm run check`
Expected: `0 errors`.

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ui/ChangesList.svelte
git commit -m "feat(changes): drag the whole selection onto a changelist"
```

---

## Task 5: Documentation

**Files:**
- Modify: `src/lib/shortcuts.ts` (the `Mouse` group)
- Modify: `README.md` (§3 Changes 모드 bullet list)

**Interfaces:**
- Consumes: the finished behavior from Tasks 2–4.
- Produces: nothing code-facing.

**Context the implementer needs:**
- `src/lib/shortcuts.ts` only **documents** bindings for the `?` cheat-sheet overlay; the handlers live in the components. `shortcuts.test.ts` asserts every entry has a non-empty `keys` and `desc`, so a malformed addition fails the suite.
- README is a Korean user manual. Match its voice: bold the UI nouns, keep bullets to one or two sentences.
- **Do not touch `CHANGELOG.md`** — this repo writes it in the `release: vX.Y.Z` commit.

- [ ] **Step 1: Add the cheat-sheet line**

In `src/lib/shortcuts.ts`, replace the `Mouse` group:

```ts
  {
    title: "Mouse",
    items: [{ keys: "Back / Forward", desc: "Drill back / forward" }],
  },
```

with:

```ts
  {
    title: "Mouse",
    items: [
      { keys: "Back / Forward", desc: "Drill back / forward" },
      { keys: "Ctrl / Shift + Click", desc: "Multi-select files (Changes)" },
    ],
  },
```

- [ ] **Step 2: Document the feature in the README**

In `README.md`, in the §3 "Changes 모드 — 소스 컨트롤" bullet list, immediately after the bullet that begins `- **Changelist**: `+ New changelist` 로 버킷을 만들고…`, insert these two bullets:

```markdown
- **멀티 셀렉트**: **`Ctrl`+클릭**으로 파일을 하나씩 더하고 **`Shift`+클릭**으로 범위를 선택합니다. 선택 중에는 상단에 `N selected` 바가 뜨고, **우클릭 메뉴**와 **드래그**가 선택 전체에 적용됩니다. **`Esc`** 또는 **Clear** 로 해제.
- **Stash**: 우클릭 → **Stash this file…** / **Stash N files…** 로 고른 파일만 따로 빼둡니다. 메시지를 비우면 파일 경로(여러 개면 `3 files: a.ts, b.ts, c.ts`)가 제목이 됩니다. **선택하지 않은 변경은 작업 트리에 그대로** 남습니다.
```

- [ ] **Step 3: Verify the cheat-sheet test still passes**

Run: `npm test`
Expected: all tests pass, including `shortcuts.test.ts`.

Run: `npm run check`
Expected: `0 errors`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shortcuts.ts README.md
git commit -m "docs(changes): document multi-select and multi-file stash"
```

---

## Task 6: Manual E2E verification (human merge gate)

**Files:** none — a human verification pass against a running app.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: the go/no-go decision for merging.

This exists because riff does not unit-test git operations or Svelte UI, so the end-to-end git result and the pointer interactions are only provable by running the app. Use the dogfood repo `C:\workspace\sandbox` (a nested-submodule project) or any repo with 5+ changed files across at least two changelists.

- [ ] **Step 1: Confirm the automated gates are green**

Run: `npm test && npm run check`
Expected: all tests pass; `0 errors`.

- [ ] **Step 2: Start the app**

Run: `npm run tauri dev`
Expected: the riff window opens; switch to the Changes screen.

- [ ] **Step 3: Verify Ctrl+click and the action bar**

1. Click file A (single selection; diff shows A).
2. Ctrl+click B, then Ctrl+click C.
3. Expected: A, B and C are highlighted with the accent left rail; the bar reads `3 selected`; the diff pane shows C.
4. Ctrl+click C again → the bar reads `2 selected` and C loses its highlight.

- [ ] **Step 4: Verify Shift+click ranges, flat and tree**

1. In **flat** view, click the first file, then Shift+click the fourth → exactly those four are selected.
2. Shift+click the second → the range shrinks to the first two (the anchor stayed on the first file).
3. Switch to **tree** view, collapse a directory, and Shift+click across it → only visible rows are selected.
4. With two changelists and a conflicted file present, Shift+click a range spanning both groups → the conflicted row is **not** selected.

- [ ] **Step 5: Verify the multi-file stash**

1. Select three files (mixing a modified tracked file and an **untracked** one).
2. Click **Stash…** in the bar → type `wip trio` → Enter.
3. Expected: exactly those three leave the Changes list; **every other change stays**; the sidebar's Stashes section shows `wip trio`.
4. **Pop** that stash → all three come back, including the untracked file.

- [ ] **Step 6: Verify the empty-message default**

1. Select three files → **Stash…** → press Enter with the field **empty**.
2. Expected: the stash subject reads `3 files: <name>, <name>, <name>` (basenames). With five selected, it ends `, +2 more`.

- [ ] **Step 7: Verify the selection-aware context menu**

1. Select three files → right-click **one of them**.
2. Expected: the menu head reads `Move 3 files to` and the last item reads `Stash 3 files…`.
3. Pick another changelist → all three move together, and they stay selected.
4. Right-click a file that is **not** selected → the selection clears, that row becomes the only selection target, and the menu reads `Move to changelist` / `Stash this file…`.

- [ ] **Step 8: Verify multi-drag**

1. Select three files, then press and drag one of them onto another changelist group.
2. Expected: the drag ghost reads `3 files`; the target group shows the dashed drop outline; on release all three move.
3. Drag a file that is **not** selected → only that file moves, and the existing selection is untouched.

- [ ] **Step 9: Verify Escape**

1. With a selection active, press `Esc` → the highlights and the bar disappear.
2. Press `Esc` again → the pre-existing behavior happens (drill-in pop / exit Focus), not a no-op.
3. Open the stash form, press `Esc` → the form closes and **nothing is stashed**; the selection survives.

- [ ] **Step 10: Verify no regressions**

1. Plain click still selects one file and shows its diff; `↑`/`↓` still move the selection.
2. Right-click a single file with **no** selection → **Stash this file…** → empty message → the stash subject is that file's path.
3. Drag a single file with no selection → it moves.
4. The sidebar Stashes `＋` still stashes the whole tree; the palette "Stash: save changes" still stashes everything.
5. Switch the Changes repo (main ↔ submodule) with a selection active → the selection resets and nothing is left highlighted.

- [ ] **Step 11: Record the result**

If every check passed, the work is ready to merge. If any failed, capture what happened and fix it before merging — do not merge on a partial pass.

---

## Self-Review

Checked after writing, against `docs/superpowers/specs/2026-07-30-multi-select-stash-design.md`:

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 `changesSelectedPaths` store field, empty-set invariant, component-local `anchor` | Task 2 (Steps 1, 6) |
| §2 click semantics table; cheat-sheet line | Task 1 (algebra) + Task 2 (Step 6 wiring) + Task 5 (Step 1) |
| §3 `data-path`, `rowOrder()` from the DOM, conflict rows excluded | Task 2 (Steps 6, 8, 9) |
| §4 pure reducer + `defaultStashMessage` + the 12 listed test cases | Task 1 |
| §5 `sel` derived, explicit resets after stash and on repo switch | Task 2 (Steps 2, 5) + Task 3 (Step 4, `submitStash`) |
| §6 action bar, `.multi` row style | Task 2 (Step 10) + Task 3 (Steps 6, 8) |
| §7 selection-aware menu, `moveFilesToChangelist`, one persist, selection survives a move | Task 3 (Steps 1, 3, 7) |
| §8 modifier guard on drag start, multi-drag, ghost label, unselected row drags alone | Task 2 (Step 7) + Task 4 |
| §9 `stashTargets`, N-file label, empty-submit fallback, unchanged single-file path | Task 3 (Steps 4, 6) |
| §10 `Esc` clears the selection first | Task 2 (Step 3) |
| Testing — unit + gates + manual E2E | Task 1 (unit), every task (gates), Task 6 (E2E) |

No spec requirement is unassigned.

**2. Deviations from the spec, and why**

- **`CHANGELOG.md` is dropped.** The spec's file table listed it, but this repo writes CHANGELOG entries in the `release: vX.Y.Z` commit (`d1074c7` changed only CHANGELOG + version files; the feature commits before it changed none). Following the spec literally would break that convention. README and the cheat sheet are still updated in Task 5.
- **The action bar ships in Task 3, not Task 2.** The spec describes selection and actions in separate sections; the plan introduces the bar complete (count + Stash… + Clear) rather than adding a count-only bar in one commit and a button in the next.
- **Task 3 Step 5 routes the existing single-file drag through `moveFilesToChangelist([dragPath], …)`** before Task 4 widens it. This keeps `moveFileToChangelist` out of `ChangesList.svelte` entirely from Task 3 onward, so no commit is left importing both names.
- **`moveFileToChangelist` is deleted, not kept as a wrapper.** Its only two call sites are in `ChangesList.svelte` and both move to the plural form in Tasks 3–4, so a delegating wrapper would be a dead export — which CLAUDE.md §3 ("remove functions that YOUR changes made unused") and §2 (simplicity) both rule against. Decided with the human partner during the pre-flight scan.

**3. Placeholder scan:** No "TBD", "TODO", "handle edge cases", "add validation", or "similar to Task N". Every code step carries literal code; every verification step names the exact command and its expected result; the manual steps name the exact expected strings (`3 selected`, `Move 3 files to`, `Stash 3 files…`, `3 files: …, +2 more`).

**4. Type consistency:** `ClickKind`, `SelectState`, `applyClick(kind, state, current, path, order)` and `defaultStashMessage(paths)` are declared once in Task 1 Step 3 and called with exactly those types in Task 2 Step 6 and Task 3 Step 4. `sel: Set<string>` (Task 2 Step 5) is read as `sel.has(…)`, `sel.size`, `[...sel]` in Tasks 3–4. `anchor: string | null` is written by Task 2 Step 6 and Task 3 Steps 3–4. `moveMenu` is `{ x: number; y: number; paths: string[] }` from Task 3 Step 3 onward and is read as `moveMenu.paths` in Steps 4 and 7. `moveFilesToChangelist(filePaths: string[], targetId: string)` (Task 3 Step 1) is called with `moveMenu.paths` (Step 3), `[dragPath]` (Step 5) and `dragPaths` (Task 4 Step 4) — all `string[]`. `stashTargets: string[] | null` (Task 3 Step 4) is guarded before every use. `dragPaths: string[] | null` (Task 4 Step 1) is non-null in both branches that read it.

---

## Amendments during implementation

Rulings made with the project owner while executing this plan. The spec was
updated to match; the task steps above are left as they were executed.

1. **Pre-flight (before Task 1) — the singular changelist move helper is deleted,
   not kept as a delegating wrapper.** Both its call sites move to the plural form
   in Tasks 3–4, so a wrapper would ship a dead export. Task 3 Step 1 above
   already reflects this. (Plan amended at `6065cfd`.)

2. **Task 3 fix round 1 — the context menu re-selects only when a selection is
   live.** As first written, `openMove`'s "outside the selection" branch ran on
   every right-click where the row was not in `sel`, including the ordinary case
   of no selection at all — so a plain right-click moved the diff pane and the
   Shift+click pivot, with no way back when the menu was dismissed. That
   contradicted the Global Constraint "the single-file context menu … behave
   exactly as before". Resolution: three branches, with the no-selection case
   restored to its historic pure peek. Spec §7 updated.

3. **Task 3 fix round 1 — the Shift+click pivot is scoped to a live selection.**
   `submitStash` reset `anchor`, but `Esc`, `Clear` and a repo switch did not, and
   two of those live outside the component. Resolution: `onRowClick` passes
   `anchor` to `applyClick` only while `changesSelectedPaths` is non-empty. No
   second store field. Spec §1 updated.

   Both Task 3 rulings landed in `637c565`.

4. **Task 5 fix round 1 — the README bullets this plan prescribed were inaccurate
   about what shipped.** Four corrections, all to text authored here: Ctrl+click
   *toggles* rather than only adding; the Shift+click range covers on-screen rows
   only (collapsed groups and conflicted files excluded); the right-click menu and
   drag act on the whole selection only when the row you clicked is itself
   selected; and the generated stash subject caps names at three with `, +N more`.
   The cheat-sheet chord was also reformatted to `Ctrl+Click / Shift+Click`, which
   is how the rest of `shortcuts.ts` writes alternatives. Landed in `17b8c78`.

5. **Final whole-branch review — the raw store field needed pruning at the
   source.** The design leaned on the pruned `sel` derived alone, but the global
   `Esc` handler reads the raw store field, which nothing ever pruned: after the
   working tree changed under a live selection, `Esc` cleared an invisible
   selection and swallowed the keypress instead of exiting Focus. Resolution: a
   prune in `loadStatus`, which also drops paths that have become conflicted.
   Folded into the same wave: two boundary tests that pin the `> 3` name cap and
   the anchor-over-`current` range precedence, and the removal of a dead
   `anchor = path` assignment in `openMove`. Landed in `dba944f`; spec §5 and the
   edge-case list updated.
