# Branch Mode Repo Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Branch mode's Unified layout the Working Copy / History repo tab strip (with an All repos tab and a status mark per repo) as the way into and out of one repo, and make the scope bar read like the toolbar.

**Architecture:** Two pure functions carry the wording and the marks: `scopeLine` (rangeText.ts) says what the scope bar shows for a repo, and `repoTabMark` (branchContainment.ts) turns a repo's range and commit-table group into one glyph. `ScopeBar.svelte` renders `scopeLine`; `RepoTabs.svelte` gains optional props (All tab, marks, reordering off) and `+page.svelte` renders it in Branch mode wired to the existing `enterFocus` / `exitFocus`. Focus itself does not change.

**Tech Stack:** SvelteKit + Svelte 5 runes, TypeScript, Vitest, Tauri 2 (no Rust changes).

**Spec:** `docs/superpowers/specs/2026-10-06-branch-repo-tabs-design.md`

## Global Constraints

- The strip shows only when `appState.appMode === "compare"`, `appState.workspaceLayout === "unified"` and `appState.repos.length > 1`.
- Focus semantics do not change: the strip calls `enterFocus(idx)` / `exitFocus()` from `src/lib/focus.ts` as they are.
- The Tabs layout's `TabBar.svelte` and the `Ctrl+Tab` / `Ctrl+1…9` keybindings do not change.
- `rangeLabel`, `rangeTooltip`, `sideNames` and `paneLabels` (the `pinned by …` / `(master's pin)` wording) do not change.
- Working Copy and History keep `RepoTabs` exactly as now: every new prop is optional and its default keeps today's behavior (dragging stays on).
- Refs and SHAs in any new string go through `shortRef`.
- Possessive rule: a name ending in `s` takes a bare apostrophe (`Plugins' own branches`); any other name takes `'s` (`sandbox's master`).
- UI copy is English, verbatim from this plan. README text is Korean, matching the surrounding sections.
- Focused test runs: `node node_modules/vitest/vitest.mjs run <file>`. Full gates: `npm test` (all pass) and `npm run check` (0 errors; the one existing warning about the `node` type definition in tsconfig.json is expected).
- Commits: Conventional Commits subject, a short prose body saying why, and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Keep destructive-looking git command literals out of commit bodies (a local guard blocks them).

## Review Focus

1. **A repo whose own branches miss a side** (Pick its own branches… on an added submodule leaves base empty): its tab tooltip and scope text must not send the user to the toolbar. `scopeLine` says `pick base and compare first` for `no-refs` (Task 1 test "says why a repo has nothing to compare").
2. **A super repo whose name ends in `s`** (e.g. `assets`): the explanation reads `assets' main`, not `assets's main` (Task 1 test "applies the possessive rule to the super repo's name").
3. **A toolbar pair holding full SHAs** (a history drill-in sets refs like `<sha>^`): the scope bar's explanation shows `5e1c0aa^`, not 40 hex characters (Task 1 test "shortens the toolbar refs it explains").
4. **A group that failed without a message**: the `!` tooltip reads `couldn't read commits: unknown error`, not `…: null` (Task 2 test "flags a group that couldn't be read").
5. **Clicking the tab that is already active, or All repos while everything is shown**: nothing reloads. `enterFocus` / `exitFocus` already return early in that case; there is no component test setup, so Task 3's manual check covers it (item 2).

---

### Task 1: The scope bar reads like the toolbar

**Files:**
- Modify: `src/lib/rangeText.ts` (add `possessive`, `ScopeLine`, `scopeLine`; remove `scopeText`)
- Modify: `src/lib/rangeText.test.ts` (replace the `scopeText` tests)
- Modify: `src/lib/ui/ScopeBar.svelte`

**Interfaces:**
- Consumes: `RepoRange` (`src/lib/types.ts`), `shortRef`, `ToolbarPair` (`src/lib/rangeText.ts`).
- Produces:
  - `export function possessive(name: string): string`
  - `export type ScopeLine = { kind: "sides"; base: string; compare: string; why: string } | { kind: "note"; text: string }`
  - `export function scopeLine(range: RepoRange, repoName: string, superName: string, pair: ToolbarPair): ScopeLine` — for a `RangeGap` it always returns `{ kind: "note" }`. Task 2 uses the note text as a tab tooltip.

- [ ] **Step 1: Write the failing tests**

In `src/lib/rangeText.test.ts`, change the import list: remove `scopeText` and add `possessive` and `scopeLine`, keeping the list alphabetical:

```ts
import {
  diffModeLabel,
  diffModeName,
  diffRangeText,
  pairLabel,
  paneLabels,
  possessive,
  rangeLabel,
  rangeTooltip,
  scopeLine,
  shortRef,
  sideNames,
} from "./rangeText";
```

Replace the whole `describe("rangeTooltip / scopeText", …)` block with:

```ts
describe("rangeTooltip", () => {
  it("explains which ref pins which commit", () => {
    expect(rangeTooltip(gitlink, pair)).toBe("main pins 5e1c0aa · feature/x pins b93f7d2");
    expect(rangeTooltip(toolbar, pair)).toBeUndefined();
  });
});

describe("possessive / scopeLine", () => {
  it("adds 's, or a bare apostrophe after an s", () => {
    expect(possessive("sandbox")).toBe("sandbox's");
    expect(possessive("Plugins")).toBe("Plugins'");
    expect(possessive("ASSETS")).toBe("ASSETS'");
  });

  it("names a repo's two sides and where they come from", () => {
    expect(scopeLine(gitlink, "Plugins", "sandbox", pair)).toEqual({
      kind: "sides",
      base: "5e1c0aa",
      compare: "b93f7d2",
      why: "the commits sandbox's main and feature/x point to",
    });
    expect(scopeLine(sameName, "tools", "sandbox", pair)).toEqual({
      kind: "sides",
      base: "main",
      compare: "feature/x",
      why: "same branch names as sandbox",
    });
    expect(scopeLine(override, "Plugins", "sandbox", pair)).toEqual({
      kind: "sides",
      base: "develop",
      compare: "feature/y",
      why: "Plugins' own branches",
    });
    expect(scopeLine(override, "engine", "sandbox", pair)).toMatchObject({
      why: "engine's own branches",
    });
    expect(scopeLine(toolbar, "sandbox", "sandbox", pair)).toMatchObject({
      why: "the toolbar's base and compare",
    });
  });

  it("says why a repo has nothing to compare", () => {
    const note = (reason: string, extra: object = {}) =>
      scopeLine({ ok: false, reason, ...extra } as RepoRange, "Plugins", "sandbox", pair);
    // Review focus: the same sentence is the tooltip of a repo whose own
    // branches miss a side, so it must not point at the toolbar.
    expect(note("no-refs")).toEqual({ kind: "note", text: "pick base and compare first" });
    expect(note("unchanged", { pin: SHA_A })).toEqual({
      kind: "note",
      text: "unchanged: sandbox's main and feature/x point to the same commit 5e1c0aa",
    });
    expect(note("added", { pin: SHA_B })).toEqual({
      kind: "note",
      text: "only in feature/x: sandbox's main doesn't have Plugins",
    });
    expect(note("removed", { pin: SHA_A })).toEqual({
      kind: "note",
      text: "removed in feature/x: only sandbox's main has Plugins",
    });
    expect(note("absent")).toEqual({ kind: "note", text: "not in sandbox's main or feature/x" });
    expect(note("error", { message: "boom" })).toEqual({ kind: "note", text: "couldn't resolve: boom" });
    expect(note("error")).toEqual({ kind: "note", text: "couldn't resolve: unknown error" });
  });

  it("applies the possessive rule to the super repo's name", () => {
    // Review focus: a super repo named like "assets".
    expect(scopeLine(gitlink, "Plugins", "assets", pair)).toMatchObject({
      why: "the commits assets' main and feature/x point to",
    });
  });

  it("shortens the toolbar refs it explains", () => {
    // Review focus: a history drill-in puts full SHAs (with a ^) in the toolbar.
    const drilled = { base: `${SHA_A}^`, compare: SHA_A };
    expect(scopeLine(gitlink, "Plugins", "sandbox", drilled)).toMatchObject({
      why: "the commits sandbox's 5e1c0aa^ and 5e1c0aa point to",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/lib/rangeText.test.ts`
Expected: FAIL in the `possessive / scopeLine` tests (`possessive is not a function` / `scopeLine is not a function`); the other tests in the file pass.

- [ ] **Step 3: Implement `possessive` and `scopeLine`, and remove `scopeText`**

In `src/lib/rangeText.ts`, replace the whole `scopeText` function and its doc comment:

```ts
/// What the scope bar says about a focused repo that is not on its own
/// branches: where its range comes from, or why it has none.
export function scopeText(
  range: RepoRange,
  superName: string,
  pair: ToolbarPair,
): string {
  if (range.ok && range.source === "gitlink") {
    return `following ${superName}: ${shortRef(pair.base)} pins ${shortRef(range.base)} ← ${shortRef(pair.compare)} pins ${shortRef(range.compare)}`;
  }
  if (range.ok && range.source === "same-name") {
    return `same branch names as ${superName}: ${pairLabel(range.base, range.compare)}`;
  }
  return rangeLabel(range, superName, pair);
}
```

with:

```ts
/// `name's`, or `name'` for a name ending in s.
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/// What the scope bar says about the repo on screen: its two sides and where
/// they come from, or why it has none.
export type ScopeLine =
  | { kind: "sides"; base: string; compare: string; why: string }
  | { kind: "note"; text: string };

/// The scope bar's line for `range`, the range of the repo named `repoName`.
/// A gap's sentence is also that repo's tab tooltip.
export function scopeLine(
  range: RepoRange,
  repoName: string,
  superName: string,
  pair: ToolbarPair,
): ScopeLine {
  const base = shortRef(pair.base);
  const compare = shortRef(pair.compare);
  const sup = possessive(superName);
  if (range.ok) {
    const sides = { base: shortRef(range.base), compare: shortRef(range.compare) };
    switch (range.source) {
      case "gitlink":
        return { kind: "sides", ...sides, why: `the commits ${sup} ${base} and ${compare} point to` };
      case "same-name":
        return { kind: "sides", ...sides, why: `same branch names as ${superName}` };
      case "override":
        return { kind: "sides", ...sides, why: `${possessive(repoName)} own branches` };
      case "toolbar":
        return { kind: "sides", ...sides, why: "the toolbar's base and compare" };
    }
  }
  switch (range.reason) {
    case "no-refs":
      return { kind: "note", text: "pick base and compare first" };
    case "unchanged":
      return {
        kind: "note",
        text: `unchanged: ${sup} ${base} and ${compare} point to the same commit ${shortRef(range.pin ?? "")}`,
      };
    case "added":
      return { kind: "note", text: `only in ${compare}: ${sup} ${base} doesn't have ${repoName}` };
    case "removed":
      return { kind: "note", text: `removed in ${compare}: only ${sup} ${base} has ${repoName}` };
    case "absent":
      return { kind: "note", text: `not in ${sup} ${base} or ${compare}` };
    case "error":
      return { kind: "note", text: `couldn't resolve: ${range.message ?? "unknown error"}` };
  }
}
```

`pairLabel` and `rangeLabel` are still used elsewhere in the file; do not remove them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run src/lib/rangeText.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Render the new line in the scope bar**

In `src/lib/ui/ScopeBar.svelte`:

(a) Replace the imports and the `idx` derivation:

```svelte
  import { appState } from "$lib/store.svelte";
  import { exitFocus } from "$lib/focus";
  import {
    clearRepoOverride,
    loadBranchesFor,
    setRepoOverride,
  } from "$lib/workspace";
  import { scopeText } from "$lib/rangeText";
  import BranchPicker from "./BranchPicker.svelte";

  // The repo the view is narrowed to: Focus in Unified, the active tab in Tabs.
  // Main's tab needs no bar — the toolbar already is main's pair.
  const isTabs = $derived(appState.workspaceLayout === "tabs");
  const idx = $derived.by(() => {
    const i = appState.activeRepoIdx;
    if (i === null || appState.repos.length < 2) return null;
    if (isTabs && i === 0) return null;
    return i;
  });
```

with:

```svelte
  import { appState } from "$lib/store.svelte";
  import {
    clearRepoOverride,
    loadBranchesFor,
    setRepoOverride,
  } from "$lib/workspace";
  import { possessive, scopeLine } from "$lib/rangeText";
  import BranchPicker from "./BranchPicker.svelte";

  // The repo the view is narrowed to: Focus in Unified, the active tab in Tabs.
  // The super repo needs no bar in either — the toolbar already is its pair.
  const idx = $derived.by(() => {
    const i = appState.activeRepoIdx;
    if (i === null || i === 0 || appState.repos.length < 2) return null;
    return i;
  });
```

(b) Right after the existing `pair` derivation (`const pair = $derived({ … });`), add:

```svelte
  const line = $derived(
    repo && range ? scopeLine(range, repo.displayName, superName, pair) : null,
  );
```

(c) Replace the whole markup block, from `{#if repo}` through its closing `{/if}`, with:

```svelte
{#if repo}
  <div class="scope" role="group" aria-label="Scope">
    <span class="name">{repo.displayName}</span>
    <span class="kind" data-kind={repo.kind}>{repo.kind}</span>
    {#if repo.override}
      <BranchPicker
        label="base"
        value={repo.override.startBranch}
        options={branches}
        placeholder="pick a ref"
        onchange={(v) => setOwn("base", v)}
        title="This repo's own base"
      />
      <span class="sep">←</span>
      <BranchPicker
        label="compare"
        value={repo.override.targetBranch}
        options={branches}
        placeholder="pick a ref"
        onchange={(v) => setOwn("compare", v)}
        title="This repo's own compare"
      />
      <span class="why">{possessive(repo.displayName)} own branches</span>
      <button type="button" onclick={followDefault}>
        {repo.kind === "submodule"
          ? `Back to ${possessive(superName)} commits`
          : "Back to same names"}
      </button>
    {:else}
      {#if line && line.kind === "sides"}
        <span class="side">base <code>{line.base}</code></span>
        <span class="sep">←</span>
        <span class="side">compare <code>{line.compare}</code></span>
        <span class="why">{line.why}</span>
      {:else}
        <span class="why">{line && line.kind === "note" ? line.text : "…"}</span>
      {/if}
      <button type="button" onclick={compareOwnBranches}>
        Pick its own branches…
      </button>
    {/if}
  </div>
{/if}
```

(d) In `<style>`, replace the `.what` rule:

```css
  .what {
    font-family: var(--mono);
    color: var(--muted);
  }
```

with:

```css
  .side {
    color: var(--muted);
  }
  .side code {
    font-family: var(--mono);
    color: var(--fg);
  }
  .why {
    color: var(--muted);
  }
```

and delete the `.exit` rule (`.exit { margin-left: auto; }`), whose button is gone.

`compareOwnBranches`, `setOwn`, `followDefault`, `branches` and the `$effect` stay as they are.

- [ ] **Step 6: Run the full gates**

Run: `npm test`
Expected: all test files pass.

Run: `npm run check`
Expected: 0 errors (1 existing warning about the `node` type definition).

Run: `git grep -n "scopeText\|exitFocus" -- src/lib/ui/ScopeBar.svelte src/lib/rangeText.ts src/lib/rangeText.test.ts`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/lib/rangeText.ts src/lib/rangeText.test.ts src/lib/ui/ScopeBar.svelte
git commit -F - <<'EOF'
feat(branch): make the scope bar read like the toolbar

The scope bar said "following sandbox: master pins 5e1c0aa ← feature/x
pins b93f7d2", which names two commits without saying they are this
repo's base and compare. It now leads with "base 5e1c0aa ← compare
b93f7d2" and then says where they came from, its buttons say what they
do (Pick its own branches…, Back to sandbox's commits), and it no longer
shows for the super repo, whose pair is the toolbar's.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: A status mark for each repo tab

**Files:**
- Modify: `src/lib/types.ts` (add `TabMark`)
- Modify: `src/lib/branchContainment.ts` (add `repoTabMark`)
- Test: `src/lib/branchContainment.test.ts`

**Interfaces:**
- Consumes: `scopeLine` from Task 1 (`src/lib/rangeText.ts`); `groupCounts` (already in `branchContainment.ts`; it folds a detected squash or content match into `out = 0`).
- Produces:
  - `export interface TabMark { text: string; tone: "out" | "in" | "muted" | "error"; title?: string }` in `src/lib/types.ts`
  - `export function repoTabMark(range: RepoRange | undefined, group: BcGroup | undefined, repoName: string, superName: string, pair: ToolbarPair): TabMark | null` in `src/lib/branchContainment.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/branchContainment.test.ts`, add `repoTabMark` to the import from `./branchContainment` (between `loadMoreGroup` and `rowMark`, keeping the list alphabetical):

```ts
  loadMoreGroup,
  repoTabMark,
  rowMark,
```

Add this block right after the `describe("pure helpers", …)` block:

```ts
describe("repoTabMark", () => {
  const pair = { base: "main", compare: "feature" };
  const ok = range("/main/sub", "a1", "b2");
  const mark = (r: RepoRange | undefined, g: BcGroup | undefined) =>
    repoTabMark(r, g, "sub", "sandbox", pair);
  const waiting = { text: "…", tone: "muted", title: "reading commits…" };

  it("has no mark before the repo's range resolves", () => {
    expect(mark(undefined, undefined)).toBeNull();
  });

  it("marks a repo with nothing to compare and says why", () => {
    expect(mark({ ok: false, reason: "unchanged", pin: "1a2b3c4d5e6f7a8b9c0d" }, undefined)).toEqual({
      text: "—",
      tone: "muted",
      title: "unchanged: sandbox's main and feature point to the same commit 1a2b3c4",
    });
    expect(mark({ ok: false, reason: "no-refs" }, undefined)).toEqual({
      text: "—",
      tone: "muted",
      title: "pick base and compare first",
    });
  });

  it("waits while the group loads, or before it exists", () => {
    expect(mark(ok, undefined)).toEqual(waiting);
    expect(mark(ok, group({ status: "loading", marks: null }))).toEqual(waiting);
  });

  it("flags a group that couldn't be read", () => {
    expect(mark(ok, group({ status: "error", error: "boom", marks: null }))).toEqual({
      text: "!",
      tone: "error",
      title: "couldn't read commits: boom",
    });
    // Review focus: a failure without a message must not print "null".
    expect(mark(ok, group({ status: "error", error: null, marks: null }))).toEqual({
      text: "!",
      tone: "error",
      title: "couldn't read commits: unknown error",
    });
  });

  it("counts the commits not in base", () => {
    expect(mark(ok, group({ marks: marks({ ahead: 5, equivalent: ["x", "y"] }) }))).toEqual({
      text: "● 3",
      tone: "out",
    });
  });

  it("shows ✓ once nothing is left to merge, a squash included", () => {
    expect(mark(ok, group({ marks: marks({ ahead: 2, equivalent: ["x", "y"] }) }))).toEqual({
      text: "✓",
      tone: "in",
    });
    expect(
      mark(ok, group({ marks: marks({ ahead: 3 }), squash: { verdict: "squash", squash_commit: commit("s1") } })),
    ).toEqual({ text: "✓", tone: "in" });
  });

  it("keeps the ● count of a branch with no net change, as its group header does", () => {
    expect(
      mark(ok, group({ marks: marks({ ahead: 2 }), squash: { verdict: "no-net-change", squash_commit: null } })),
    ).toEqual({ text: "● 2", tone: "out" });
  });
});
```

(`range`, `group`, `marks` and `commit` are the helpers already defined at the top of this test file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/lib/branchContainment.test.ts`
Expected: FAIL in the `repoTabMark` tests (`repoTabMark is not a function`); the other tests pass.

- [ ] **Step 3: Add the `TabMark` type**

In `src/lib/types.ts`, right after the `SquashCheck` interface, add:

```ts

/// A Branch-mode repo tab's status mark (see branchContainment.repoTabMark).
export interface TabMark {
  text: string;
  tone: "out" | "in" | "muted" | "error";
  title?: string;
}
```

- [ ] **Step 4: Implement `repoTabMark`**

In `src/lib/branchContainment.ts`, change the two import lines:

```ts
import { shortRef, type ToolbarPair } from "./rangeText";
```
```ts
import type { BcGroup, Commit, Containment, RepoRange, SquashCheck } from "./types";
```

to:

```ts
import { scopeLine, shortRef, type ToolbarPair } from "./rangeText";
```
```ts
import type { BcGroup, Commit, Containment, RepoRange, SquashCheck, TabMark } from "./types";
```

Then add this function between the end of `summarize` and `type OkRange = …`:

```ts
/// A Branch-mode repo tab's mark: what the commit table knows about the repo,
/// in one glyph. `repoName`, `superName` and `pair` word a gap's tooltip.
export function repoTabMark(
  range: RepoRange | undefined,
  group: BcGroup | undefined,
  repoName: string,
  superName: string,
  pair: ToolbarPair,
): TabMark | null {
  if (!range) return null;
  if (!range.ok) {
    const line = scopeLine(range, repoName, superName, pair);
    return { text: "—", tone: "muted", title: line.kind === "note" ? line.text : undefined };
  }
  if (!group || group.status === "loading") {
    return { text: "…", tone: "muted", title: "reading commits…" };
  }
  if (group.status === "error") {
    return { text: "!", tone: "error", title: `couldn't read commits: ${group.error ?? "unknown error"}` };
  }
  const out = groupCounts(group).out;
  return out > 0 ? { text: `● ${out}`, tone: "out" } : { text: "✓", tone: "in" };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node node_modules/vitest/vitest.mjs run src/lib/branchContainment.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Run the full gates**

Run: `npm test`
Expected: all test files pass.

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/branchContainment.ts src/lib/branchContainment.test.ts
git commit -F - <<'EOF'
feat(branch): sum up each repo's commits in one tab mark

The repo tabs Branch mode is getting need to say, before you open a repo,
whether it has anything to merge. repoTabMark reads the commit table's
group for the repo: "● N" for commits not in base, "✓" once nothing is
left (a squash included), "…" while it loads, "!" when it failed, and
"—" with the scope bar's sentence as tooltip when there is nothing to
compare.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: The repo tab strip in Branch mode

**Files:**
- Modify: `src/lib/ui/RepoTabs.svelte`
- Modify: `src/routes/+page.svelte`
- Modify: `README.md`

**Interfaces:**
- Consumes: `repoTabMark` (Task 2, `src/lib/branchContainment.ts`); `TabMark` (Task 2, `src/lib/types.ts`); `enterFocus(repoIdx: number): void` and `exitFocus(): void` (`src/lib/focus.ts`, unchanged).
- Produces: `RepoTabs` props `value: number | null`, `onselect: (idx: number) => void`, `allLabel?: string`, `onall?: () => void`, `mark?: (idx: number) => TabMark | null`, `reorderable?: boolean` (default `true`).

- [ ] **Step 1: Give `RepoTabs` the optional All tab, marks and a reordering switch**

In `src/lib/ui/RepoTabs.svelte`:

(a) Replace:

```svelte
  import type { RepoEntry } from "$lib/types";

  // A repo selector tab strip, shared by History and Changes. The caller owns
  // the selected index (historyRepoIdx / changesRepoIdx) and the select action.
  let { value, onselect }: { value: number; onselect: (idx: number) => void } =
    $props();
```

with:

```svelte
  import type { RepoEntry, TabMark } from "$lib/types";

  // A repo selector tab strip, shared by History, Changes and Branch mode. The
  // caller owns the selected index and the select action. Branch mode adds a
  // first tab for every repo (`allLabel`, active while `value` is null), a
  // status mark per repo, and turns reordering off.
  let {
    value,
    onselect,
    allLabel,
    onall,
    mark,
    reorderable = true,
  }: {
    value: number | null;
    onselect: (idx: number) => void;
    allLabel?: string;
    onall?: () => void;
    mark?: (idx: number) => TabMark | null;
    reorderable?: boolean;
  } = $props();
```

(b) Replace:

```svelte
    if (e.button !== 0 || idx === 0) return; // main is not draggable
```

with:

```svelte
    if (!reorderable || e.button !== 0 || idx === 0) return; // main is not draggable
```

(c) Replace the markup:

```svelte
<div class="repo-tabs" role="tablist" aria-label="Repository">
  {#each appState.repos as r, idx (r.path)}
    <button
      type="button"
      class="tab"
      class:active={idx === value}
      class:dragging={idx === dragIdx}
      class:droptarget={idx === dropIdx && dragIdx !== null}
      data-tabidx={idx}
      role="tab"
      aria-selected={idx === value}
      title={idx === 0 ? r.path : `${r.path} · drag to reorder`}
      onpointerdown={(e) => onDown(e, idx)}
      onclick={() => onClick(idx)}
    >
      <span class="name">{label(r, idx)}</span>
      {#if r.kind !== "main"}
        <span class="kind" data-kind={r.kind}>{r.kind}</span>
      {/if}
    </button>
  {/each}
</div>
```

with:

```svelte
<div class="repo-tabs" role="tablist" aria-label="Repository">
  {#if allLabel}
    <button
      type="button"
      class="tab"
      class:active={value === null}
      role="tab"
      aria-selected={value === null}
      title="Every repo in the workspace"
      onclick={() => onall?.()}
    >
      <span class="name all">{allLabel}</span>
    </button>
  {/if}
  {#each appState.repos as r, idx (r.path)}
    {@const m = mark?.(idx) ?? null}
    <button
      type="button"
      class="tab"
      class:active={idx === value}
      class:dragging={idx === dragIdx}
      class:droptarget={idx === dropIdx && dragIdx !== null}
      data-tabidx={idx}
      role="tab"
      aria-selected={idx === value}
      title={idx === 0 || !reorderable ? r.path : `${r.path} · drag to reorder`}
      onpointerdown={(e) => onDown(e, idx)}
      onclick={() => onClick(idx)}
    >
      <span class="name">{label(r, idx)}</span>
      {#if r.kind !== "main"}
        <span class="kind" data-kind={r.kind}>{r.kind}</span>
      {/if}
      {#if m}
        <span class="mark" data-tone={m.tone} title={m.title}>{m.text}</span>
      {/if}
    </button>
  {/each}
</div>
```

(d) At the end of `<style>` (before `</style>`), add:

```css
  .tab .name.all {
    font-family: inherit;
  }
  .tab .mark {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--muted);
  }
  .tab .mark[data-tone="out"] {
    color: var(--error-fg, #f85149);
  }
  .tab .mark[data-tone="in"] {
    color: var(--ok-fg, #3fb950);
  }
  .tab .mark[data-tone="error"] {
    color: var(--info-fg);
  }
```

(The ● and ✓ colors are the commit table's: `src/lib/ui/CommitTable.svelte` `.mark.out` / `.mark.in`.)

- [ ] **Step 2: Render the strip in Branch mode**

In `src/routes/+page.svelte`:

(a) Change the focus import:

```ts
  import { exitFocus } from "$lib/focus";
```

to:

```ts
  import { enterFocus, exitFocus } from "$lib/focus";
```

and add, right after the `import { diffRangeText } from "$lib/rangeText";` line:

```ts
  import { repoTabMark } from "$lib/branchContainment";
```

(b) Right after the `headerRange` derivation (the `$derived.by` block that ends with `});` after `diffRangeText(…)`), add:

```ts
  // Branch mode's repo tabs (Unified): each repo's mark from the commit
  // table's data.
  function branchTabMark(idx: number) {
    return repoTabMark(
      appState.repoRanges[idx],
      appState.bcGroups[idx],
      appState.repos[idx]?.displayName ?? "",
      appState.repos[0]?.displayName ?? "",
      { base: appState.startBranch, compare: appState.targetBranch },
    );
  }
```

(c) Right after the Tabs layout's tab bar block:

```svelte
  {#if appState.appMode === "compare" && appState.workspaceLayout === "tabs" && appState.repos.length > 0}
    <TabBar />
  {/if}
```

add:

```svelte
  {#if appState.appMode === "compare" && appState.workspaceLayout === "unified" && appState.repos.length > 1}
    <!-- Unified's way into one repo: the strip Working Copy and History use,
         plus All repos. Reordering is off: Branch mode keys its per-repo state
         by index. -->
    <RepoTabs
      value={appState.activeRepoIdx}
      onselect={enterFocus}
      allLabel="All repos"
      onall={exitFocus}
      mark={branchTabMark}
      reorderable={false}
    />
  {/if}
```

- [ ] **Step 3: Run the gates**

Run: `npm test`
Expected: all test files pass.

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 4: Update the README**

In `README.md`, replace:

```markdown
파일 리스트와 blame 피커는 모두 **repo별 collapsible 그룹 헤더**로 묶여 표시됩니다. 그룹 헤더의:
- **caret(▾/▸)** 클릭 → 그 그룹만 접고 펴기 (`↑`/`↓` 이동에서 접힌 그룹은 건너뜀)
- **이름 부분** 클릭 → **Focus 모드** 진입. 그 repo만 보이게 되고, `Esc` 또는 같은 헤더 재클릭으로 해제.
```

with:

```markdown
파일 리스트와 blame 피커는 모두 **repo별 collapsible 그룹 헤더**로 묶여 표시됩니다. 그룹 헤더의:
- **caret(▾/▸)이나 이름** 클릭 → 그 그룹만 접고 펴기 (`↑`/`↓` 이동에서 접힌 그룹은 건너뜀)
- 오른쪽 끝 **`→`** 클릭 → **Focus 모드** 진입. 그 repo만 보이게 되고, 같은 자리의 `←` 또는 `Esc`로 해제.

Branch 모드에서는 툴바 아래 **repo 탭 줄**이 같은 일을 합니다. 맨 앞 **All repos** 탭이 전체 보기이고, repo 탭을 누르면 그 repo에 Focus합니다. 탭마다 커밋 표의 상태가 붙습니다: `● N` base에 없는 커밋 N개 · `✓` 전부 들어감 · `…` 읽는 중 · `—` 비교할 범위 없음(툴팁에 이유) · `!` 읽지 못함. 이 탭은 드래그로 순서를 바꿀 수 없습니다.
```

Replace:

```markdown
- 툴바의 base / compare는 **항상 main의 쌍**입니다. submodule·manual 탭이 active면 툴바 아래 **scope 줄**이 그 repo가 무엇을 따라가는지 보여주고, **Compare own branches…** 로 그 repo만의 base / compare를 고를 수 있습니다.
```

with:

```markdown
- 툴바의 base / compare는 **항상 main의 쌍**입니다. submodule·manual 탭이 active면 툴바 아래 **scope 줄**이 그 repo의 `base … ← compare …`와 그 두 값이 어디서 왔는지 보여주고, **Pick its own branches…** 로 그 repo만의 base / compare를 고를 수 있습니다 (**Back to <main>'s commits** 로 복귀).
```

Replace:

```markdown
툴바의 두 피커는 항상 **super(main) repo의 쌍**입니다. 멀티 루트에서 한 repo에 Focus해도 피커의 의미는 바뀌지 않고, 툴바 아래 scope 줄에 그 repo의 범위가 표시됩니다.
```

with:

```markdown
툴바의 두 피커는 항상 **super(main) repo의 쌍**입니다. 멀티 루트에서는 툴바 아래 **repo 탭 줄**로 한 repo에 들어가고 **All repos** 탭으로 전체 보기로 돌아옵니다. 들어가도 피커의 의미는 바뀌지 않습니다. submodule이나 manual repo에 들어가면 탭 줄 아래 scope 줄이 그 repo의 `base … ← compare …`와 출처(예: `the commits sandbox's master and feature/x point to`)를 보여줍니다.
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/RepoTabs.svelte src/routes/+page.svelte README.md
git commit -F - <<'EOF'
feat(branch): enter and leave a repo from a tab strip

In Branch mode's Unified layout the only way into one repo was a small
arrow at the end of its Files header. The strip Working Copy and History
already use now sits under the toolbar with an All repos tab first: a
repo's tab focuses it, All repos shows every repo again, and each tab
carries its commit-table mark. Reordering is off there because Branch
mode keys its per-repo state by index. The README describes the strip
and corrects the old line that said clicking a header's name focuses.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 6: Manual check with the user (controller)**

Run `npm run tauri dev` (the user runs it), open `C:\workspace\sandbox`, enter Branch mode with base `origin/master` and a compare that bumps a submodule (e.g. `origin/feature/all-ui` or `origin/ovdr-14754-bt`), and walk:

1. The strip shows in Branch mode only with Unified layout and two or more repos; not in the Tabs layout.
2. A repo tab enters that repo (Files and the commit table narrow; the tab is highlighted). Clicking the same tab again, or All repos while everything is shown, reloads nothing. All repos and `Esc` come back to every repo.
3. Marks show `…` while loading, then `● N` / `✓` / `—`; the `—` tooltip explains the gap.
4. Dragging a tab does nothing in Branch mode, and still reorders in Working Copy and History.
5. The scope bar on a gitlink submodule reads `base … ← compare …` plus `the commits sandbox's master and feature/x point to`. After **Pick its own branches…** it shows the pickers and `<repo>' own branches` / `<repo>'s own branches` with **Back to sandbox's commits**. It is hidden on the sandbox tab and has no `× All repos`.
6. The Tabs layout looks and behaves as before apart from the scope bar wording.

Record anything that differs from the spec and fix it in the task that owns the behavior.
