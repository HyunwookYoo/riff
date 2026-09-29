# Branch Mode Clarity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Branch mode say which repo, which two refs and which direction every panel is about: one base/compare model for the diff and the commit list, the toolbar fixed on the super repo's pair, each repo's range and its provenance shown where it is used, a full-width commit table that lists unmerged commits first, and squash-merge detection.

**Architecture:** A single resolver (`repoRange.ts`) decides every repo's base/compare range once per input set and publishes it to `appState.repoRanges`; compare(), the commit table, DiffView and all labels read that one answer. Pure text helpers (`rangeText.ts`, `commitTableText.ts`) produce every UI string so they can be unit-tested. The commit table's data layer (`branchContainment.ts`) keeps one group per repo, asks `containment` with compare as the source and base as the target, and in the background asks a new read-only Rust command, `squash_check`, whether unmerged commits landed as a squash.

**Tech Stack:** SvelteKit + Svelte 5 runes, TypeScript, vitest (node environment); Tauri 2 + Rust (`std::process::Command` over the git CLI).

**Spec:** `docs/superpowers/specs/2026-09-29-branch-mode-clarity-design.md`

## Global Constraints

- **Field names stay.** `appState.startBranch` is the **base**, `appState.targetBranch` is **compare**. Do not rename them.
- **Toolbar invariant.** The toolbar pickers only ever read and write `appState.startBranch` / `appState.targetBranch`. Per-repo overrides are edited only from `ScopeBar.svelte`.
- **Notation.** Every range reads `base ← compare` (compare merges into base). UI strings are English and match the spec's tables verbatim, e.g. `pinned by sandbox: 5e1c0aa ← b93f7d2`, `● 8 not merged`, `Show merged commits`.
- **Backend.** The only Rust change is `squash_check`. It is read-only: no `write_lock`, no `drop_session`. Every ref passes through `validate_ref`.
- **git ≥ 2.38** is needed only by `squash_check`'s merge-tree step. That step failing (old git, conflict) means "not detected", never an error.
- **squash_check step order** (corrects the spec, which is updated in the same commit as this plan): merge-base → "no net change" check → "base has nothing since the fork" early exit → candidates → patch-id → merge-tree. Checking "no net change" first is what lets a branch that merged the base back in after its squash read as `NoNetChange` instead of `None`.
- **Frontend tests** run under vitest's node environment. Any module that touches runes (`*.svelte.ts`) or Tauri `invoke` is mocked with `vi.mock`, following `src/lib/workspace.test.ts`. There are no component tests; Svelte files are checked by `npm run check`.
- **Commands:** `npm test`, `npx vitest run <file>`, `npm run check`, `cargo test --manifest-path src-tauri/Cargo.toml <filter>`.
- **CSS variables** available: `--bg --fg --border --muted --accent --accent-soft --hover --mono --input-bg --bar-bg --sidebar-bg --selected --selected-fg --error-fg --ok-fg` (use `var(--error-fg, #f85149)` / `var(--ok-fg, #3fb950)` fallbacks as existing code does).
- **Commits:** conventional subjects (`feat(branch): …`, `fix(branch): …`, `docs: …`) with a prose body; follow the session's commit-attribution instructions. Never put destructive-looking git command literals in a commit body — the sandbox guard blocks the whole commit.

## Review Focus

1. **A reload while a commit is picked** (the window regains focus, a fetch finishes): `refsRefresh` reloads the table, which drops the pick — the file list must go back to all changes instead of keeping the old commit's files. Test in Task 6.
2. **Refs with revision suffixes or full SHAs** (drill-in's `<sha>^`, a picked commit, gitlink pins): labels must shorten the SHA and keep the suffix (`a41f2c9^`). Test in Task 3.
3. **A branch that touches more paths than fit on one Windows command line**: squash detection must drop the path filter and still find the squash. Test in Task 7.
4. **Tabs layout with a submodule tab active**: the commit table and "All changes" names must follow the active tab, not `activeRepoIdx === null` semantics. Test in Task 6.
5. **Unified view where some repos have no range**: the summary must count only the groups that exist and use the single-group wording when one remains. Test in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/types.ts` | `RepoRange` / `RangeSource` / `RangeGap` (Task 1), `BcGroup` (Task 6), `SquashVerdict` / `SquashCheck` (Task 7), `BcGroup.squash` (Task 8) |
| `src/lib/store.svelte.ts` | `repoRanges` (Task 1); `bcDiffRange.repoIdx` (Task 2); commit-table state replacing the single-repo containment state (Task 6) |
| `src/lib/repoRange.ts` (new) | The resolver: `resolveRepoRange`, `resolveRepoRanges`, `resetRepoRanges` |
| `src/lib/compare.ts` | Reads ranges; honors `bcDiffRange.repoIdx` |
| `src/lib/workspace.ts` | Loses `resolveDiffRefsFor` (moved into the resolver) |
| `src/lib/rangeText.ts` (new) | Range, scope, pane-label and diff-mode strings |
| `src/lib/branchContainment.ts` | Commit-table data layer (rewritten in Task 6, extended in Task 8) |
| `src/lib/commitTableText.ts` (new) | Commit-table strings: summary, group counts, row status, Files header |
| `src/lib/git.ts` | `squashCheck` binding (Task 7) |
| `src/lib/ui/BranchPicker.svelte` | Optional `label` prefix inside the trigger |
| `src/lib/ui/BranchModeFields.svelte` | Toolbar: super pair only, `base` / `compare` labels, diff-mode labels |
| `src/lib/ui/ScopeBar.svelte` (new) | The focused repo's scope bar and own-branch editing |
| `src/lib/ui/FileList.svelte` | Range line under every group header |
| `src/lib/ui/DiffView.svelte` | Range by `repoIdx`; pane label row |
| `src/lib/ui/Breadcrumb.svelte` | `main ← feature/x (since fork)` notation |
| `src/lib/ui/CommitTable.svelte` (new) | The full-width commit table (replaces `BranchContainment.svelte`) |
| `src/lib/ui/FilesScope.svelte` (new) | The line above the file list: all changes, or the picked commit's state |
| `src/lib/ui/InputBar.svelte` | Compare button clears the new pick state |
| `src/routes/+page.svelte` | Scope bar placement, diff header badges, three-row Branch layout |
| `src-tauri/src/git/mod.rs`, `cli.rs`, `lib.rs` | `squash_check` (Task 7) |
| `README.md`, `CHANGELOG.md` | Docs (Task 9) |

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Tasks 4, 5 and 6 depend on 3's helpers; 6 depends on 1–2; 8 depends on 6 and 7. Task 7 is independent of 2–6 and can run any time after Task 1.

---

### Task 1: The range resolver

**Files:**
- Modify: `src/lib/types.ts` (append after the `RepoEntry` interface)
- Modify: `src/lib/store.svelte.ts` (import + one field)
- Create: `src/lib/repoRange.ts`
- Test: `src/lib/repoRange.test.ts`

**Interfaces:**
- Produces:
  - `type RangeSource = "toolbar" | "gitlink" | "override" | "same-name"`
  - `type RangeGap = "no-refs" | "unchanged" | "added" | "removed" | "absent" | "error"`
  - `type RepoRange = { ok: true; path: string; base: string; compare: string; source: RangeSource } | { ok: false; reason: RangeGap; pin?: string; message?: string }`
  - `appState.repoRanges: RepoRange[]` (indexed like `appState.repos`)
  - `resolveRepoRange(repo: RepoEntry, mainPath: string, base: string, compare: string): Promise<RepoRange>`
  - `resolveRepoRanges(): Promise<RepoRange[]>` — memoized per input set, publishes to `appState.repoRanges`
  - `resetRepoRanges(): void` — test seam

- [ ] **Step 1: Add the range types**

Append to `src/lib/types.ts`, directly after the `RepoEntry` interface:

```ts
/// Where a repo's compare range comes from. See "One range resolver" in
/// docs/superpowers/specs/2026-09-29-branch-mode-clarity-design.md.
export type RangeSource = "toolbar" | "gitlink" | "override" | "same-name";

/// Why a repo has no range to compare.
export type RangeGap =
  | "no-refs"
  | "unchanged"
  | "added"
  | "removed"
  | "absent"
  | "error";

/// One repo's base/compare pair, or the reason it has none. For a `gitlink`
/// range, `base` / `compare` are the commits the super repo's base / compare
/// refs pin. `pin` names the one existing pin for `unchanged` / `added` /
/// `removed`; `message` carries the failure for `error`.
export type RepoRange =
  | {
      ok: true;
      path: string;
      base: string;
      compare: string;
      source: RangeSource;
    }
  | { ok: false; reason: RangeGap; pin?: string; message?: string };
```

- [ ] **Step 2: Add `repoRanges` to the store**

In `src/lib/store.svelte.ts`, add `RepoRange` to the type import list (keep it alphabetical after `RepoFile`):

```ts
  RepoFile,
  RepoRange,
  RepoStatus,
```

and add this field directly after `activeRepoIdx = $state<number | null>(null);`:

```ts
  // Every repo's resolved base/compare range (repoRange.ts), indexed like
  // `repos`. Written only by resolveRepoRanges(); read by every surface that
  // names or diffs a range, so they can never disagree. Session-only.
  repoRanges = $state<RepoRange[]>([]);
```

- [ ] **Step 3: Write the failing tests**

Create `src/lib/repoRange.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// repoRange.ts reads the runes store and calls one Tauri binding; both are
// stubbed. Specifiers resolve relative to this file (src/lib).
vi.mock("./store.svelte", () => ({
  appState: {
    repos: [],
    repoPath: "",
    startBranch: "",
    targetBranch: "",
    refsRefresh: 0,
    repoRanges: [],
  },
}));
vi.mock("./git", () => ({ submoduleShaAt: vi.fn() }));

import {
  resetRepoRanges,
  resolveRepoRange,
  resolveRepoRanges,
} from "./repoRange";
import { appState } from "./store.svelte";
import { submoduleShaAt } from "./git";
import type { RepoEntry } from "./types";

const main: RepoEntry = { path: "/main", kind: "main", displayName: "main" };
const sub: RepoEntry = {
  path: "/main/sub",
  kind: "submodule",
  displayName: "sub",
  parentGitlinkPath: "sub",
};
const manual: RepoEntry = {
  path: "/manual",
  kind: "manual",
  displayName: "manual",
};

beforeEach(() => {
  vi.mocked(submoduleShaAt).mockReset();
  resetRepoRanges();
  appState.repos = [];
  appState.repoPath = "";
  appState.startBranch = "";
  appState.targetBranch = "";
  appState.refsRefresh = 0;
  appState.repoRanges = [];
});

describe("resolveRepoRange", () => {
  it("uses the toolbar pair for main", async () => {
    expect(await resolveRepoRange(main, "/main", "main", "feature")).toEqual({
      ok: true,
      path: "/main",
      base: "main",
      compare: "feature",
      source: "toolbar",
    });
  });

  it("reports no-refs for main while a side is empty", async () => {
    expect(await resolveRepoRange(main, "/main", "main", "")).toEqual({
      ok: false,
      reason: "no-refs",
    });
  });

  it("prefers an override over the gitlinks", async () => {
    const r: RepoEntry = {
      ...sub,
      override: { startBranch: "develop", targetBranch: "feature/y" },
    };
    expect(await resolveRepoRange(r, "/main", "main", "feature")).toEqual({
      ok: true,
      path: "/main/sub",
      base: "develop",
      compare: "feature/y",
      source: "override",
    });
    expect(submoduleShaAt).not.toHaveBeenCalled();
  });

  it("reports no-refs for an override with a side cleared", async () => {
    const r: RepoEntry = {
      ...sub,
      override: { startBranch: "develop", targetBranch: "" },
    };
    expect(await resolveRepoRange(r, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "no-refs",
    });
  });

  it("follows the commits the super repo's refs pin", async () => {
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce("aaa")
      .mockResolvedValueOnce("bbb");
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: true,
      path: "/main/sub",
      base: "aaa",
      compare: "bbb",
      source: "gitlink",
    });
    expect(submoduleShaAt).toHaveBeenCalledWith("/main", "main", "sub");
    expect(submoduleShaAt).toHaveBeenCalledWith("/main", "feature", "sub");
  });

  it("reports unchanged, with the pin, when both refs pin one commit", async () => {
    // Regression: resolveDiffRefsFor returned a range here while compare()
    // skipped the repo.
    vi.mocked(submoduleShaAt).mockResolvedValue("aaa");
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "unchanged",
      pin: "aaa",
    });
  });

  it("reports added when only compare pins the submodule", async () => {
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("bbb");
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "added",
      pin: "bbb",
    });
  });

  it("reports removed when only base pins it", async () => {
    vi.mocked(submoduleShaAt)
      .mockResolvedValueOnce("aaa")
      .mockResolvedValueOnce(null);
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "removed",
      pin: "aaa",
    });
  });

  it("reports absent when neither ref pins it", async () => {
    vi.mocked(submoduleShaAt).mockResolvedValue(null);
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "absent",
    });
  });

  it("reports an error with its message when the pin lookup throws", async () => {
    vi.mocked(submoduleShaAt).mockRejectedValue("bad tree-ish");
    expect(await resolveRepoRange(sub, "/main", "main", "feature")).toEqual({
      ok: false,
      reason: "error",
      message: "bad tree-ish",
    });
  });

  it("resolves a manual repo without an override to same-name", async () => {
    // Regression: the containment pane's resolveContext returned nothing here
    // while compare() and the diff used the same-name branches.
    expect(await resolveRepoRange(manual, "/main", "main", "feature")).toEqual({
      ok: true,
      path: "/manual",
      base: "main",
      compare: "feature",
      source: "same-name",
    });
  });

  it("reports no-refs for a manual repo while the toolbar is empty", async () => {
    expect(await resolveRepoRange(manual, "/main", "", "feature")).toEqual({
      ok: false,
      reason: "no-refs",
    });
  });
});

describe("resolveRepoRanges", () => {
  it("resolves every repo and publishes the result", async () => {
    appState.repos = [main, manual];
    appState.startBranch = "main";
    appState.targetBranch = "feature";
    const ranges = await resolveRepoRanges();
    expect(ranges.map((r) => (r.ok ? r.source : r.reason))).toEqual([
      "toolbar",
      "same-name",
    ]);
    expect(appState.repoRanges).toBe(ranges);
  });

  it("shares one resolution until an input changes", async () => {
    appState.repos = [main, sub];
    appState.startBranch = "main";
    appState.targetBranch = "feature";
    vi.mocked(submoduleShaAt).mockResolvedValue("aaa");
    const first = resolveRepoRanges();
    expect(resolveRepoRanges()).toBe(first);
    await first;
    expect(submoduleShaAt).toHaveBeenCalledTimes(2);
    appState.refsRefresh = 1;
    await resolveRepoRanges();
    expect(submoduleShaAt).toHaveBeenCalledTimes(4);
  });

  it("falls back to main alone before the workspace is built", async () => {
    appState.repoPath = "/main";
    appState.startBranch = "a";
    appState.targetBranch = "b";
    expect(await resolveRepoRanges()).toEqual([
      { ok: true, path: "/main", base: "a", compare: "b", source: "toolbar" },
    ]);
  });

  it("publishes only the latest resolution", async () => {
    appState.repos = [main, sub];
    appState.startBranch = "main";
    appState.targetBranch = "feature";
    let release: (v: string | null) => void = () => {};
    vi.mocked(submoduleShaAt)
      .mockImplementationOnce(
        () => new Promise<string | null>((r) => (release = r)),
      )
      .mockResolvedValueOnce("c1")
      .mockResolvedValueOnce("b2")
      .mockResolvedValueOnce("c2");
    const first = resolveRepoRanges();
    appState.targetBranch = "feature2";
    const second = await resolveRepoRanges();
    release("b1");
    await first;
    expect(appState.repoRanges).toBe(second);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/lib/repoRange.test.ts`
Expected: FAIL — `Failed to resolve import "./repoRange"`.

- [ ] **Step 5: Implement the resolver**

Create `src/lib/repoRange.ts`:

```ts
import { appState } from "./store.svelte";
import { submoduleShaAt } from "./git";
import type { RepoEntry, RepoRange } from "./types";

/// Resolve which two refs `repo` compares, and why. `base` / `compare` are the
/// toolbar pair (the super repo's), `mainPath` the super repo whose gitlinks
/// pin a submodule. This is the one rule compare(), the commit table, DiffView
/// and every range label follow.
export async function resolveRepoRange(
  repo: RepoEntry,
  mainPath: string,
  base: string,
  compare: string,
): Promise<RepoRange> {
  if (repo.kind === "main") {
    if (!base || !compare) return { ok: false, reason: "no-refs" };
    return { ok: true, path: repo.path, base, compare, source: "toolbar" };
  }
  if (repo.override) {
    const { startBranch, targetBranch } = repo.override;
    if (!startBranch || !targetBranch) return { ok: false, reason: "no-refs" };
    return {
      ok: true,
      path: repo.path,
      base: startBranch,
      compare: targetBranch,
      source: "override",
    };
  }
  if (!base || !compare) return { ok: false, reason: "no-refs" };
  if (repo.kind === "manual") {
    return { ok: true, path: repo.path, base, compare, source: "same-name" };
  }
  if (!repo.parentGitlinkPath) return { ok: false, reason: "absent" };
  let basePin: string | null;
  let comparePin: string | null;
  try {
    [basePin, comparePin] = await Promise.all([
      submoduleShaAt(mainPath, base, repo.parentGitlinkPath),
      submoduleShaAt(mainPath, compare, repo.parentGitlinkPath),
    ]);
  } catch (e) {
    return { ok: false, reason: "error", message: String(e) };
  }
  if (!basePin && !comparePin) return { ok: false, reason: "absent" };
  if (!basePin) return { ok: false, reason: "added", pin: comparePin ?? undefined };
  if (!comparePin) return { ok: false, reason: "removed", pin: basePin };
  if (basePin === comparePin) {
    return { ok: false, reason: "unchanged", pin: basePin };
  }
  return {
    ok: true,
    path: repo.path,
    base: basePin,
    compare: comparePin,
    source: "gitlink",
  };
}

/// The repos a resolution covers: the workspace, or main alone before the
/// workspace is built (compare() has the same fallback, so indexes line up).
function workspaceRepos(): RepoEntry[] {
  return appState.repos.length > 0
    ? appState.repos
    : [{ path: appState.repoPath, kind: "main", displayName: "" }];
}

function inputsKey(repos: RepoEntry[]): string {
  return JSON.stringify([
    appState.startBranch,
    appState.targetBranch,
    appState.refsRefresh,
    repos.map((r) => [
      r.path,
      r.kind,
      r.parentGitlinkPath ?? "",
      r.override ?? null,
    ]),
  ]);
}

let lastKey: string | null = null;
let lastRun: Promise<RepoRange[]> | null = null;

/// Resolve every repo's range and publish it to `appState.repoRanges`. Runs
/// again only when an input changed — the toolbar pair, the repo list or an
/// override, or `refsRefresh` (the repo moved) — so every caller in between
/// shares one resolution, and therefore one answer.
export function resolveRepoRanges(): Promise<RepoRange[]> {
  const repos = workspaceRepos();
  const key = inputsKey(repos);
  if (lastRun && key === lastKey) return lastRun;
  lastKey = key;
  const mainPath = repos[0].path;
  const base = appState.startBranch;
  const compare = appState.targetBranch;
  const run: Promise<RepoRange[]> = Promise.all(
    repos.map((r) => resolveRepoRange(r, mainPath, base, compare)),
  ).then((ranges) => {
    // A newer resolution may have started meanwhile; only the latest publishes.
    if (lastRun === run) appState.repoRanges = ranges;
    return ranges;
  });
  lastRun = run;
  return run;
}

/// Test seam: forget the memoized resolution.
export function resetRepoRanges(): void {
  lastKey = null;
  lastRun = null;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/repoRange.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/store.svelte.ts src/lib/repoRange.ts src/lib/repoRange.test.ts
git commit -m "feat(branch): resolve every repo's compare range in one place"
```

Body: the per-repo rule was written three times (compare, the containment pane, DiffView) and had drifted; this adds the single resolver the next task switches them to.

---

### Task 2: Switch every consumer to the resolver, and fix the submodule drill

**Files:**
- Modify: `src/lib/store.svelte.ts` (`bcDiffRange` type)
- Modify: `src/lib/compare.ts`
- Modify: `src/lib/ui/DiffView.svelte:9` and `:179-209`
- Modify: `src/lib/branchContainment.ts` (`resolveContext`, `selectBranchCommit`)
- Modify: `src/lib/workspace.ts` (delete `resolveDiffRefsFor`), `src/lib/workspace.test.ts` (delete its tests — Task 1 covers them)
- Test: `src/lib/compare.test.ts` (new)

**Interfaces:**
- Consumes: `resolveRepoRanges(): Promise<RepoRange[]>` (Task 1).
- Produces: `appState.bcDiffRange: { repoIdx: number; start: string; target: string } | null` — a commit picked in the commit table, diffed inside repo `repoIdx` only.

- [ ] **Step 1: Write the failing test**

Create `src/lib/compare.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// compare() pulls in the runes store, the Tauri bindings, the range resolver
// and a few UI helpers at module load; none matter to which repos it scans, so
// they are stubbed. Specifiers resolve relative to this file (src/lib).
vi.mock("./store.svelte", () => ({
  appState: {
    repoPath: "/main",
    workspaceLayout: "unified",
    compareMode: "branch",
    activeRepoIdx: null,
    repos: [],
    startBranch: "main",
    targetBranch: "feature",
    mode: "three-dot",
    ignoreWhitespace: false,
    error: null,
    loadingFiles: false,
    files: [],
    selectedFile: null,
    bcDiffRange: null,
  },
}));
vi.mock("./git", () => ({ diffFiles: vi.fn() }));
vi.mock("./repoRange", () => ({ resolveRepoRanges: vi.fn() }));
vi.mock("./diff/lang", () => ({ detectLanguage: () => null }));
vi.mock("./diff/shiki", () => ({ preloadLanguages: vi.fn() }));
vi.mock("./commitHistory", () => ({ restoreCompareContext: vi.fn() }));
vi.mock("./workingCopy", () => ({ enterChangesMode: vi.fn() }));

import { compare } from "./compare";
import { appState } from "./store.svelte";
import { diffFiles } from "./git";
import { resolveRepoRanges } from "./repoRange";
import type { ChangedFile, RepoEntry, RepoRange } from "./types";

const main: RepoEntry = { path: "/main", kind: "main", displayName: "main" };
const sub: RepoEntry = {
  path: "/main/sub",
  kind: "submodule",
  displayName: "sub",
  parentGitlinkPath: "sub",
};
const manual: RepoEntry = {
  path: "/manual",
  kind: "manual",
  displayName: "manual",
};

const ok = (path: string, base: string, compare: string): RepoRange => ({
  ok: true,
  path,
  base,
  compare,
  source: "toolbar",
});
const allOk = [
  ok("/main", "main", "feature"),
  ok("/main/sub", "aaa", "bbb"),
  ok("/manual", "main", "feature"),
];

beforeEach(() => {
  // compare() batches file arrivals per animation frame; run them at once.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.mocked(diffFiles).mockReset();
  vi.mocked(diffFiles).mockImplementation(async (...args) => {
    const onFile = args[5];
    onFile({
      path: "x.cpp",
      old_path: null,
      status: "modified",
      repoIdx: 0,
    } as ChangedFile);
  });
  vi.mocked(resolveRepoRanges).mockReset();
  appState.repos = [main, sub, manual];
  appState.activeRepoIdx = null;
  appState.bcDiffRange = null;
  appState.files = [];
  appState.selectedFile = null;
  appState.error = null;
});

describe("compare", () => {
  it("diffs a picked submodule commit inside that submodule", async () => {
    // The drill bug: with Focus on the submodule, picking one of its commits
    // used to scan nothing and leave the file list empty.
    vi.mocked(resolveRepoRanges).mockResolvedValue(allOk);
    appState.activeRepoIdx = 1;
    appState.bcDiffRange = { repoIdx: 1, start: "p1", target: "c1" };
    await compare();
    expect(vi.mocked(diffFiles).mock.calls.map((c) => c.slice(0, 4))).toEqual([
      ["/main/sub", "p1", "c1", "two-dot"],
    ]);
    expect(appState.files.map((f) => f.repoIdx)).toEqual([1]);
  });

  it("diffs a picked main commit only in main", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue(allOk);
    appState.bcDiffRange = { repoIdx: 0, start: "p0", target: "c0" };
    await compare();
    expect(vi.mocked(diffFiles).mock.calls.map((c) => c.slice(0, 4))).toEqual([
      ["/main", "p0", "c0", "two-dot"],
    ]);
  });

  it("scans each repo's resolved range and skips repos without one", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      ok("/main", "main", "feature"),
      { ok: false, reason: "unchanged", pin: "aaa" },
      ok("/manual", "main", "feature"),
    ]);
    await compare();
    expect(vi.mocked(diffFiles).mock.calls.map((c) => c.slice(0, 4))).toEqual([
      ["/main", "main", "feature", "three-dot"],
      ["/manual", "main", "feature", "three-dot"],
    ]);
    expect(appState.files.map((f) => f.repoIdx)).toEqual([0, 2]);
  });

  it("scans only the focused repo in Unified view", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue(allOk);
    appState.activeRepoIdx = 2;
    await compare();
    expect(vi.mocked(diffFiles).mock.calls.map((c) => c[0])).toEqual([
      "/manual",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/compare.test.ts`
Expected: FAIL — the first test sees no `diffFiles` call (the drill skips every non-main repo, and Focus skips main), and the `./repoRange` mock is never consulted.

- [ ] **Step 3: Give `bcDiffRange` its repo**

In `src/lib/store.svelte.ts` replace

```ts
  bcDiffRange = $state<{ start: string; target: string } | null>(null);
```

with

```ts
  bcDiffRange = $state<{ repoIdx: number; start: string; target: string } | null>(
    null,
  );
```

- [ ] **Step 4: Switch compare() to the resolver**

In `src/lib/compare.ts`:

1. Replace the import lines

```ts
import { diffFiles, submoduleShaAt } from "./git";
```

with

```ts
import { diffFiles } from "./git";
import { resolveRepoRanges } from "./repoRange";
```

2. In the branch-mode precondition, change the message:

```ts
      if (!opts.silent) appState.error = "base and compare are required";
```

3. Replace the `willScan` block

```ts
  // Which repos this pass will actually scan (mirrors the per-repo loop's
  // skips below). A submodule that won't be scanned has no group of its own in
  // this view, which drives the gitlink decision just below.
  const willScan = (i: number) =>
    !(appState.bcDiffRange && i !== 0) &&
    !(!isTabMode && appState.activeRepoIdx !== null && appState.activeRepoIdx !== i);
```

with

```ts
  // Which repos this pass will actually scan. A commit picked in the commit
  // table is diffed inside its own repo and nothing else is scanned; otherwise
  // Focus (Unified) narrows the scan. A submodule that won't be scanned has no
  // group of its own in this view, which drives the gitlink decision below.
  const drill = appState.bcDiffRange;
  const willScan = (i: number) =>
    drill
      ? i === drill.repoIdx
      : !(!isTabMode && appState.activeRepoIdx !== null && appState.activeRepoIdx !== i);
```

4. Delete the line `  const mainPath = repos[0].path;`.

5. Replace the body of the outer `try` up to (not including) the final `flushBuffer();` — i.e. the whole `for` loop and the comment above it — with:

```ts
    const ranges = await resolveRepoRanges();
    // Sequential per-repo. The Rust `GitCli` keeps a single
    // `Mutex<Option<Session>>` slot so parallel calls with different
    // paths would thrash and drop each others' children mid-stream.
    for (let i = 0; i < repos.length; i++) {
      if (session !== compareSession) break;
      if (!willScan(i)) continue;
      const repo = repos[i];
      try {
        if (drill) {
          await diffFiles(
            repo.path,
            drill.start,
            drill.target,
            "two-dot",
            appState.ignoreWhitespace,
            makeOnFile(i),
          );
          continue;
        }
        const range = ranges[i];
        // No range — refs missing, pointer unchanged, submodule added or
        // removed — means nothing to list for this repo.
        if (!range?.ok) continue;
        await diffFiles(
          range.path,
          range.base,
          range.compare,
          appState.mode,
          appState.ignoreWhitespace,
          makeOnFile(i),
        );
      } catch (e) {
        // One repo failing shouldn't kill the whole compare.
        console.warn(`compare: repo ${repo.path} failed:`, e);
      }
    }
```

6. Delete the whole `fetchRepoChanges` function and its doc comment (from `/**\n * Fetch one repo's changed files` through its closing `}`).

- [ ] **Step 5: Switch DiffView to the resolver**

In `src/lib/ui/DiffView.svelte` replace the import

```ts
  import { resolveDiffRefsFor } from "$lib/workspace";
```

with

```ts
  import { resolveRepoRanges } from "$lib/repoRange";
```

and replace the two branch-mode arms of `load()` (from `} else if (appState.bcDiffRange && repoIdx === 0) {` through the closing `}` of the following `else` arm) with:

```ts
      } else if (
        appState.bcDiffRange &&
        appState.bcDiffRange.repoIdx === repoIdx
      ) {
        // A commit picked in the commit table: this file's diff is
        // parent..commit inside the commit's own repo, not the toolbar range.
        const range = appState.bcDiffRange;
        next = await fileDiff(
          repoPath,
          range.start,
          range.target,
          "two-dot",
          file.path,
          file.old_path,
          force,
          ueVersion,
        );
      } else {
        const range = (await resolveRepoRanges())[repoIdx];
        if (!range?.ok) {
          nextErr = "no refs to compare for this file";
        } else {
          next = await fileDiff(
            range.path,
            range.base,
            range.compare,
            appState.mode,
            file.path,
            file.old_path,
            force,
            ueVersion,
          );
        }
      }
```

- [ ] **Step 6: Switch the containment pane's context to the resolver**

In `src/lib/branchContainment.ts`:

1. Replace the `./git` import with

```ts
import { commitContainmentDetail, commitLog, containment } from "./git";
import { resolveRepoRanges } from "./repoRange";
```

2. Delete the `mainPath()` function and its comment.

3. Replace the `BcContext` interface, its doc comment and `resolveContext()` (everything from `/// The repo and refs this pane describes` through the end of `resolveContext`) with:

```ts
/// The repo and refs this pane describes: whatever Focus is on, resolved by
/// the same resolver compare() uses, so the marks describe the diff on screen.
interface BcContext {
  idx: number;
  path: string;
  start: string;
  target: string;
  /// What to call the repo in the pane's header.
  repo: string;
}

async function resolveContext(): Promise<BcContext | null> {
  if (appState.appMode !== "compare" || !appState.repoPath) return null;
  const idx = appState.activeRepoIdx ?? 0;
  const range = (await resolveRepoRanges())[idx];
  if (!range?.ok) return null;
  return {
    idx,
    path: range.path,
    start: range.base,
    target: range.compare,
    repo: appState.repos[idx]?.displayName || "repo",
  };
}
```

4. In `selectBranchCommit`, replace

```ts
  appState.bcDiffRange = {
    start: commit.parents[0] ?? EMPTY_TREE,
    target: commit.sha,
  };
```

with

```ts
  appState.bcDiffRange = {
    repoIdx: bcContext?.idx ?? 0,
    start: commit.parents[0] ?? EMPTY_TREE,
    target: commit.sha,
  };
```

- [ ] **Step 7: Delete the old resolver**

In `src/lib/workspace.ts` delete `resolveDiffRefsFor` together with its doc comment, and remove `submoduleShaAt,` from the `./git` import list (nothing else in the file uses it).

In `src/lib/workspace.test.ts`:
- replace `import { resolveDiffRefsFor, repoPathFor } from "./workspace";` with `import { repoPathFor } from "./workspace";`
- delete `import { submoduleShaAt } from "./git";`
- replace `vi.mock("./git", () => ({ submoduleShaAt: vi.fn() }));` with `vi.mock("./git", () => ({}));`
- delete `vi.mocked(submoduleShaAt).mockReset();` from `beforeEach`
- delete the whole `describe("resolveDiffRefsFor", …)` block (its cases now live in `repoRange.test.ts`).

- [ ] **Step 8: Run the tests and the type check**

Run: `npm test`
Expected: PASS, including `compare.test.ts` (4 tests) and `repoRange.test.ts`.

Run: `npm run check`
Expected: `svelte-check found 0 errors`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/store.svelte.ts src/lib/compare.ts src/lib/ui/DiffView.svelte src/lib/branchContainment.ts src/lib/workspace.ts src/lib/workspace.test.ts src/lib/compare.test.ts
git commit -m "fix(branch): list a picked submodule commit's files"
```

Body: with Focus on a submodule, picking one of its commits in the containment pane emptied the file list — the drill range was main-only, so compare() skipped the submodule and Focus skipped main. The range now names its repo. compare(), DiffView and the pane also read one resolver now, which fixes two drifts: a manual repo without an override got no containment, and a submodule whose pins match got a diff range the file list never used.

---

### Task 3: Range text helpers

**Files:**
- Create: `src/lib/rangeText.ts`
- Test: `src/lib/rangeText.test.ts`

**Interfaces:**
- Consumes: `RepoRange`, `DiffMode` from `./types`.
- Produces:
  - `interface ToolbarPair { base: string; compare: string }`
  - `shortRef(ref: string): string`
  - `pairLabel(base: string, compare: string): string`
  - `sideNames(range: Extract<RepoRange, { ok: true }>, pair: ToolbarPair): ToolbarPair`
  - `rangeLabel(range: RepoRange, superName: string, pair: ToolbarPair): string`
  - `rangeTooltip(range: RepoRange, pair: ToolbarPair): string | undefined`
  - `scopeText(range: RepoRange, superName: string, pair: ToolbarPair): string`
  - `diffModeLabel(mode: DiffMode): string`, `diffModeName(mode: DiffMode): string`
  - `diffRangeText(range: RepoRange | undefined, drillTarget: string | null): string | null`
  - `interface PaneLabels { left: string; right: string }`
  - `paneLabels(range: RepoRange | undefined, pair: ToolbarPair, mode: DiffMode, drill: { target: string; summary?: string } | null): PaneLabels | null`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/rangeText.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  diffModeLabel,
  diffModeName,
  diffRangeText,
  pairLabel,
  paneLabels,
  rangeLabel,
  rangeTooltip,
  scopeText,
  shortRef,
  sideNames,
} from "./rangeText";
import type { RepoRange } from "./types";

const SHA_A = "5e1c0aa7b2c3d4e5f60718293a4b5c6d7e8f9012";
const SHA_B = "b93f7d2c1d2e3f405162738495a6b7c8d9e0f123";
const pair = { base: "main", compare: "feature/x" };
const toolbar: RepoRange = { ok: true, path: "/m", base: "main", compare: "feature/x", source: "toolbar" };
const gitlink: RepoRange = { ok: true, path: "/s", base: SHA_A, compare: SHA_B, source: "gitlink" };
const override: RepoRange = { ok: true, path: "/s", base: "develop", compare: "feature/y", source: "override" };
const sameName: RepoRange = { ok: true, path: "/l", base: "main", compare: "feature/x", source: "same-name" };

describe("shortRef", () => {
  it("shortens a full SHA and leaves names alone", () => {
    expect(shortRef(SHA_A)).toBe("5e1c0aa");
    expect(shortRef("feature/x")).toBe("feature/x");
  });

  it("keeps a revision suffix after shortening", () => {
    // Drill-in writes `<sha>^`; the label must stay short and keep the caret.
    expect(shortRef(`${SHA_A}^`)).toBe("5e1c0aa^");
    expect(shortRef(`${SHA_A}~2`)).toBe("5e1c0aa~2");
  });
});

describe("pairLabel / sideNames", () => {
  it("writes base ← compare", () => {
    expect(pairLabel("main", SHA_B)).toBe("main ← b93f7d2");
  });

  it("names a gitlink range's sides after the refs that pin them", () => {
    if (!gitlink.ok) throw new Error("fixture");
    expect(sideNames(gitlink, pair)).toEqual({ base: "main's pin", compare: "feature/x's pin" });
  });

  it("names other ranges by their refs", () => {
    if (!override.ok) throw new Error("fixture");
    expect(sideNames(override, pair)).toEqual({ base: "develop", compare: "feature/y" });
  });
});

describe("rangeLabel", () => {
  it("labels each source", () => {
    expect(rangeLabel(toolbar, "sandbox", pair)).toBe("main ← feature/x");
    expect(rangeLabel(gitlink, "sandbox", pair)).toBe("pinned by sandbox: 5e1c0aa ← b93f7d2");
    expect(rangeLabel(override, "sandbox", pair)).toBe("own branches: develop ← feature/y");
    expect(rangeLabel(sameName, "sandbox", pair)).toBe("same names: main ← feature/x");
  });

  it("labels each gap", () => {
    const gap = (reason: string, extra: object = {}) =>
      rangeLabel({ ok: false, reason, ...extra } as RepoRange, "sandbox", pair);
    expect(gap("no-refs")).toBe("pick both refs");
    expect(gap("unchanged", { pin: SHA_A })).toBe("unchanged: both pin 5e1c0aa");
    expect(gap("added", { pin: SHA_B })).toBe("only in feature/x (added)");
    expect(gap("removed", { pin: SHA_A })).toBe("not in feature/x (removed)");
    expect(gap("absent")).toBe("not in main or feature/x");
    expect(gap("error", { message: "boom" })).toBe("couldn't resolve: boom");
  });
});

describe("rangeTooltip / scopeText", () => {
  it("explains which ref pins which commit", () => {
    expect(rangeTooltip(gitlink, pair)).toBe("main pins 5e1c0aa · feature/x pins b93f7d2");
    expect(rangeTooltip(toolbar, pair)).toBeUndefined();
  });

  it("says what a focused repo follows", () => {
    expect(scopeText(gitlink, "sandbox", pair)).toBe(
      "following sandbox: main pins 5e1c0aa ← feature/x pins b93f7d2",
    );
    expect(scopeText(sameName, "sandbox", pair)).toBe(
      "same branch names as sandbox: main ← feature/x",
    );
    expect(scopeText({ ok: false, reason: "unchanged", pin: SHA_A }, "sandbox", pair)).toBe(
      "unchanged: both pin 5e1c0aa",
    );
  });
});

describe("diff mode and diff header", () => {
  it("names the diff modes", () => {
    expect(diffModeLabel("three-dot")).toBe("since fork (...)");
    expect(diffModeLabel("two-dot")).toBe("direct (..)");
    expect(diffModeName("three-dot")).toBe("since fork");
    expect(diffModeName("two-dot")).toBe("direct");
  });

  it("shows the drilled commit, else the range, else nothing", () => {
    expect(diffRangeText(toolbar, SHA_A)).toBe("commit 5e1c0aa");
    expect(diffRangeText(gitlink, null)).toBe("5e1c0aa ← b93f7d2");
    expect(diffRangeText({ ok: false, reason: "no-refs" }, null)).toBeNull();
    expect(diffRangeText(undefined, null)).toBeNull();
  });
});

describe("paneLabels", () => {
  it("labels a three-dot and a two-dot range", () => {
    expect(paneLabels(toolbar, pair, "three-dot", null)).toEqual({
      left: "base · main (merge-base)",
      right: "compare · feature/x",
    });
    expect(paneLabels(toolbar, pair, "two-dot", null)).toEqual({
      left: "base · main",
      right: "compare · feature/x",
    });
  });

  it("labels a gitlink range by the pins", () => {
    expect(paneLabels(gitlink, pair, "three-dot", null)).toEqual({
      left: "base · 5e1c0aa (main's pin)",
      right: "compare · b93f7d2 (feature/x's pin)",
    });
  });

  it("labels a picked commit as parent and commit", () => {
    expect(paneLabels(toolbar, pair, "three-dot", { target: SHA_A, summary: "Add clone" })).toEqual({
      left: "5e1c0aa^ (parent)",
      right: "5e1c0aa · Add clone",
    });
  });

  it("has nothing to say without a range", () => {
    expect(paneLabels({ ok: false, reason: "no-refs" }, pair, "three-dot", null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/rangeText.test.ts`
Expected: FAIL — `Failed to resolve import "./rangeText"`.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/rangeText.ts`:

```ts
import type { DiffMode, RepoRange } from "./types";

/// The toolbar's pair: the super repo's base and compare refs.
export interface ToolbarPair {
  base: string;
  compare: string;
}

/// Shorten a full or long hex SHA to git's 7 characters, keeping any revision
/// suffix (`^`, `~2`) so a drill-in's `<sha>^` reads `a41f2c9^`. Names pass
/// through unchanged.
export function shortRef(ref: string): string {
  const m = /^([0-9a-f]{12,40})([\^~].*)?$/i.exec(ref);
  return m ? m[1].slice(0, 7) + (m[2] ?? "") : ref;
}

/// `base ← compare`, the notation every range uses (compare merges into base).
export function pairLabel(base: string, compare: string): string {
  return `${shortRef(base)} ← ${shortRef(compare)}`;
}

/// The two sides of an ok range as every string names them: the refs
/// themselves, or for a gitlink range the pins, named after the super refs
/// that set them.
export function sideNames(
  range: Extract<RepoRange, { ok: true }>,
  pair: ToolbarPair,
): ToolbarPair {
  if (range.source === "gitlink") {
    return {
      base: `${shortRef(pair.base)}'s pin`,
      compare: `${shortRef(pair.compare)}'s pin`,
    };
  }
  return { base: shortRef(range.base), compare: shortRef(range.compare) };
}

/// The range line of a repo's group header, shared by the commit table and
/// the file list. `superName` is the super repo's display name.
export function rangeLabel(
  range: RepoRange,
  superName: string,
  pair: ToolbarPair,
): string {
  if (range.ok) {
    const r = pairLabel(range.base, range.compare);
    switch (range.source) {
      case "toolbar":
        return r;
      case "gitlink":
        return `pinned by ${superName}: ${r}`;
      case "override":
        return `own branches: ${r}`;
      case "same-name":
        return `same names: ${r}`;
    }
  }
  const base = shortRef(pair.base);
  const compare = shortRef(pair.compare);
  switch (range.reason) {
    case "no-refs":
      return "pick both refs";
    case "unchanged":
      return `unchanged: both pin ${shortRef(range.pin ?? "")}`;
    case "added":
      return `only in ${compare} (added)`;
    case "removed":
      return `not in ${compare} (removed)`;
    case "absent":
      return `not in ${base} or ${compare}`;
    case "error":
      return `couldn't resolve: ${range.message ?? "unknown error"}`;
  }
}

/// Hover text for a gitlink range: which super ref pins which commit.
export function rangeTooltip(
  range: RepoRange,
  pair: ToolbarPair,
): string | undefined {
  if (!range.ok || range.source !== "gitlink") return undefined;
  return `${shortRef(pair.base)} pins ${shortRef(range.base)} · ${shortRef(pair.compare)} pins ${shortRef(range.compare)}`;
}

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

/// The diff-mode select's option text.
export function diffModeLabel(mode: DiffMode): string {
  return mode === "three-dot" ? "since fork (...)" : "direct (..)";
}

/// A diff mode's short name, for inline notation such as the breadcrumb.
export function diffModeName(mode: DiffMode): string {
  return mode === "three-dot" ? "since fork" : "direct";
}

/// The right side of the diff header: the commit picked in the commit table,
/// else the file's repo range, else nothing.
export function diffRangeText(
  range: RepoRange | undefined,
  drillTarget: string | null,
): string | null {
  if (drillTarget) return `commit ${shortRef(drillTarget)}`;
  if (range?.ok) return pairLabel(range.base, range.compare);
  return null;
}

export interface PaneLabels {
  left: string;
  right: string;
}

/// Labels over the diff's two panes. `drill` is the commit picked in the commit
/// table, when it belongs to the shown file's repo.
export function paneLabels(
  range: RepoRange | undefined,
  pair: ToolbarPair,
  mode: DiffMode,
  drill: { target: string; summary?: string } | null,
): PaneLabels | null {
  if (drill) {
    const sha = shortRef(drill.target);
    return {
      left: `${sha}^ (parent)`,
      right: drill.summary ? `${sha} · ${drill.summary}` : sha,
    };
  }
  if (!range?.ok) return null;
  if (range.source === "gitlink") {
    return {
      left: `base · ${shortRef(range.base)} (${shortRef(pair.base)}'s pin)`,
      right: `compare · ${shortRef(range.compare)} (${shortRef(pair.compare)}'s pin)`,
    };
  }
  const base = shortRef(range.base);
  return {
    left: mode === "three-dot" ? `base · ${base} (merge-base)` : `base · ${base}`,
    right: `compare · ${shortRef(range.compare)}`,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/rangeText.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rangeText.ts src/lib/rangeText.test.ts
git commit -m "feat(branch): one set of strings for ranges, scope and diff panes"
```

---

### Task 4: Toolbar on the super pair, and the scope bar

**Files:**
- Modify: `src/lib/ui/BranchPicker.svelte` (props + trigger + one style rule)
- Modify (rewrite): `src/lib/ui/BranchModeFields.svelte`
- Create: `src/lib/ui/ScopeBar.svelte`
- Modify: `src/routes/+page.svelte` (import + placement)
- Modify: `src/lib/ui/FileList.svelte` (the Focus button's tooltip)

**Interfaces:**
- Consumes: `diffModeLabel`, `scopeText` (Task 3); `appState.repoRanges` (Task 1); `setRepoOverride`, `clearRepoOverride`, `loadBranchesFor` (`src/lib/workspace.ts`); `exitFocus` (`src/lib/focus.ts`).
- Produces: `BranchPicker` gains `label?: string`; `<ScopeBar />` component (no props).

- [ ] **Step 1: Let BranchPicker show a label inside its trigger**

In `src/lib/ui/BranchPicker.svelte`, extend `Props` and the destructuring:

```ts
  interface Props {
    value: string;
    options: Branch[];
    placeholder?: string;
    onchange: (v: string) => void;
    title?: string;
    /// Muted word shown before the value inside the trigger ("base", "compare").
    label?: string;
  }

  let { value, options, placeholder, onchange, title, label }: Props = $props();
```

In the trigger button, insert before `<span class="label" …>`:

```svelte
    {#if label}
      <span class="prefix">{label}</span>
    {/if}
```

and add to the `<style>` block, after the `.trigger:hover` rule:

```css
  .prefix {
    flex-shrink: 0;
    color: var(--muted);
    font-size: 0.85em;
  }
```

- [ ] **Step 2: Rewrite the toolbar fields**

Replace the whole of `src/lib/ui/BranchModeFields.svelte` with:

```svelte
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { diffModeLabel } from "$lib/rangeText";
  import BranchPicker from "./BranchPicker.svelte";

  // The pickers always edit the super repo's pair — `startBranch` is base,
  // `targetBranch` is compare. Focus and tabs only filter what is shown; a
  // submodule's own pair is edited from the scope bar (ScopeBar.svelte).
  const superName = $derived(
    appState.repos.length > 1 ? (appState.repos[0]?.displayName ?? "") : "",
  );
</script>

{#if superName}
  <span class="super" title="These refs belong to the super repo">{superName}</span>
{/if}
<BranchPicker
  label="base"
  value={appState.startBranch}
  options={appState.branches}
  placeholder="pick a ref"
  onchange={(v) => (appState.startBranch = v)}
  title="base — where compare would merge; the diff's left side"
/>
<span class="sep" title="compare merges into base">←</span>
<BranchPicker
  label="compare"
  value={appState.targetBranch}
  options={appState.branches}
  placeholder="pick a ref"
  onchange={(v) => (appState.targetBranch = v)}
  title="compare — the branch under review; the diff's right side"
/>
<select bind:value={appState.mode} title="Diff mode">
  <option value="three-dot">{diffModeLabel("three-dot")}</option>
  <option value="two-dot">{diffModeLabel("two-dot")}</option>
</select>

<style>
  .super {
    color: var(--muted);
    font-size: 0.85em;
    font-family: var(--mono);
  }
  .sep {
    opacity: 0.6;
  }
  select {
    font-size: 0.9em;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
  }
</style>
```

- [ ] **Step 3: Create the scope bar**

Create `src/lib/ui/ScopeBar.svelte`:

```svelte
<script lang="ts">
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
  const repo = $derived(idx === null ? null : (appState.repos[idx] ?? null));
  const range = $derived(idx === null ? undefined : appState.repoRanges[idx]);
  const superName = $derived(appState.repos[0]?.displayName ?? "");
  const pair = $derived({
    base: appState.startBranch,
    compare: appState.targetBranch,
  });
  const branches = $derived(
    idx === null ? [] : (appState.branchesByRepoIdx[idx] ?? []),
  );

  $effect(() => {
    if (idx !== null && idx !== 0) void loadBranchesFor(idx);
  });

  /// Compare this repo on its own pair, seeded with what is on screen so
  /// nothing changes until a ref is picked.
  function compareOwnBranches() {
    if (idx === null) return;
    let base = "";
    let compare = "";
    if (range?.ok) {
      base = range.base;
      compare = range.compare;
    } else if (range?.reason === "unchanged") {
      base = range.pin ?? "";
      compare = range.pin ?? "";
    } else if (range?.reason === "added") {
      compare = range.pin ?? "";
    } else if (range?.reason === "removed") {
      base = range.pin ?? "";
    }
    setRepoOverride(idx, base, compare);
  }

  function setOwn(side: "base" | "compare", v: string) {
    if (idx === null || !repo?.override) return;
    const o = repo.override;
    setRepoOverride(
      idx,
      side === "base" ? v : o.startBranch,
      side === "compare" ? v : o.targetBranch,
    );
  }

  function followDefault() {
    if (idx !== null) clearRepoOverride(idx);
  }
</script>

{#if repo}
  <div class="scope" role="group" aria-label="Scope">
    <span class="name">{repo.displayName}</span>
    <span class="kind" data-kind={repo.kind}>
      {repo.kind === "main" ? "super" : repo.kind}
    </span>
    {#if repo.kind !== "main"}
      {#if repo.override}
        <span class="what">own branches:</span>
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
        <button type="button" onclick={followDefault}>
          {repo.kind === "submodule" ? `Follow ${superName}` : "Use same names"}
        </button>
      {:else}
        <span class="what">{range ? scopeText(range, superName, pair) : "…"}</span>
        <button type="button" onclick={compareOwnBranches}>
          Compare own branches…
        </button>
      {/if}
    {/if}
    {#if !isTabs}
      <button type="button" class="exit" onclick={exitFocus}>× All repos</button>
    {/if}
  </div>
{/if}

<style>
  .scope {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 4px 10px;
    background: var(--accent-soft);
    border-bottom: 1px solid var(--accent);
    font-size: 0.85em;
  }
  .name {
    font-weight: 600;
    font-family: var(--mono);
  }
  .kind {
    font-size: 0.72em;
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .kind[data-kind="submodule"] {
    color: var(--accent);
    border-color: var(--accent);
  }
  .what {
    font-family: var(--mono);
    color: var(--muted);
  }
  .sep {
    opacity: 0.6;
  }
  button {
    font-size: 0.95em;
    padding: 3px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .exit {
    margin-left: auto;
  }
</style>
```

- [ ] **Step 4: Place the scope bar**

In `src/routes/+page.svelte` add the import next to the other UI imports:

```ts
  import ScopeBar from "$lib/ui/ScopeBar.svelte";
```

and directly after the `{#if appState.appMode === "compare" && appState.workspaceLayout === "tabs" && appState.repos.length > 0}<TabBar />{/if}` block insert:

```svelte
  {#if appState.appMode === "compare"}
    <ScopeBar />
  {/if}
```

- [ ] **Step 5: Retitle the Focus button**

The group header's `→` button no longer makes the toolbar edit that repo. In `src/lib/ui/FileList.svelte` replace

```svelte
              : "Enter this repo — edits refs above"}
```

with

```svelte
              : "Focus on this repo"}
```

- [ ] **Step 6: Check types and tests**

Run: `npm run check`
Expected: 0 errors.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ui/BranchPicker.svelte src/lib/ui/BranchModeFields.svelte src/lib/ui/ScopeBar.svelte src/routes/+page.svelte src/lib/ui/FileList.svelte
git commit -m "feat(branch): keep the toolbar on the super repo and add a scope bar"
```

Body: moving Focus used to make the same two pickers silently edit the focused repo's override. The toolbar now always holds the super repo's base and compare; a focused submodule or manual repo gets a scope bar that says what it follows and edits its own pair.

---

### Task 5: Range lines, diff header and pane labels, breadcrumb

**Files:**
- Modify: `src/lib/ui/FileList.svelte` (script + group block + styles)
- Modify: `src/routes/+page.svelte` (diff header)
- Modify: `src/lib/ui/DiffView.svelte` (pane label row)
- Modify (rewrite script): `src/lib/ui/Breadcrumb.svelte`

**Interfaces:**
- Consumes: `rangeLabel`, `rangeTooltip`, `diffRangeText`, `paneLabels`, `pairLabel`, `diffModeName` (Task 3); `appState.repoRanges`; `appState.bcDiffRange.repoIdx` (Task 2).

- [ ] **Step 1: A range line under every group header**

In `src/lib/ui/FileList.svelte`:

1. Delete the local `shortRef` function and its comment.
2. Add the import `import { rangeLabel, rangeTooltip } from "$lib/rangeText";`.
3. Add after the `showGroups` derived:

```ts
  // Branch mode names each group's range under its header, for every repo:
  // where it comes from (toolbar, gitlink pins, own branches, same names) or
  // why it has none.
  const superName = $derived(appState.repos[0]?.displayName ?? "");
  const pair = $derived({
    base: appState.startBranch,
    compare: appState.targetBranch,
  });
```

4. On the `.group-header` div add `class:dim={appState.appMode === "compare" && appState.repoRanges[group.idx]?.ok === false}`.
5. Replace the block

```svelte
        {#if appState.compareMode === "branch" && group.repo.kind !== "main" && group.repo.override}
          <div
            class="group-refs"
            class:focused={isFocused}
            title={`${group.repo.override.startBranch} → ${group.repo.override.targetBranch}`}
          >
            <span class="ref">{shortRef(group.repo.override.startBranch)}</span>
            <span class="arrow" aria-hidden="true">→</span>
            <span class="ref">{shortRef(group.repo.override.targetBranch)}</span>
          </div>
        {/if}
```

with

```svelte
        {#if appState.appMode === "compare" && appState.repoRanges[group.idx]}
          {@const range = appState.repoRanges[group.idx]}
          <div
            class="group-refs"
            class:focused={isFocused}
            class:gap={!range.ok}
            title={rangeTooltip(range, pair) ?? rangeLabel(range, superName, pair)}
          >
            <span class="ref">{rangeLabel(range, superName, pair)}</span>
          </div>
        {/if}
```

6. In `<style>`, delete the now-unused `.group-refs .arrow` rule and add:

```css
  .group-refs.gap {
    font-style: italic;
    opacity: 0.7;
  }
  .group-header.dim {
    opacity: 0.6;
  }
```

- [ ] **Step 2: Repo and range in the diff header**

In `src/routes/+page.svelte`:

1. Add the import `import { diffRangeText } from "$lib/rangeText";`.
2. Add to the script, after `graphCommit`:

```ts
  // Branch mode: the diff header's right side names what the diff is between —
  // the commit picked in the commit table, else the file's repo range.
  const headerRange = $derived.by(() => {
    const f = appState.selectedFile;
    if (appState.appMode !== "compare" || !f) return null;
    const idx = f.repoIdx ?? 0;
    const d = appState.bcDiffRange;
    return diffRangeText(
      appState.repoRanges[idx],
      d && d.repoIdx === idx ? d.target : null,
    );
  });
```

3. In the `diffPane` snippet's `<header>`, insert between the status badge `</span>` and `<span class="path">`:

```svelte
            {#if appState.appMode === "compare" && appState.repos.length > 1}
              {@const repo = appState.repos[appState.selectedFile.repoIdx ?? 0]}
              {#if repo}
                <span class="repo-kind" data-kind={repo.kind}>
                  {repo.kind === "main" ? "super" : repo.kind}
                </span>
                <span class="repo-name">{repo.displayName}</span>
                <span class="chev" aria-hidden="true">›</span>
              {/if}
            {/if}
```

and before `</header>`:

```svelte
            {#if headerRange}
              <span class="range">{headerRange}</span>
            {/if}
```

4. Add to `<style>` after the `.diff .from` rule:

```css
  .diff .repo-kind {
    font-size: 0.7em;
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .diff .repo-kind[data-kind="submodule"] {
    color: var(--accent);
    border-color: var(--accent);
  }
  .diff .repo-name {
    font-weight: 600;
  }
  .diff .chev {
    opacity: 0.5;
  }
  .diff .range {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--muted);
  }
```

- [ ] **Step 3: Pane labels over the diff**

In `src/lib/ui/DiffView.svelte`:

1. Add the import `import { paneLabels } from "$lib/rangeText";`.
2. Add after the `showSvgPreview` derived:

```ts
  // Branch mode: name what each pane shows — base / compare, or parent /
  // commit for a commit picked in the commit table.
  const labels = $derived.by(() => {
    const f = appState.selectedFile;
    if (appState.appMode !== "compare" || !f) return null;
    const idx = f.repoIdx ?? 0;
    const d = appState.bcDiffRange;
    const drill = d && d.repoIdx === idx ? { target: d.target } : null;
    return paneLabels(
      appState.repoRanges[idx],
      { base: appState.startBranch, compare: appState.targetBranch },
      appState.mode,
      drill,
    );
  });
```

3. In the template, directly after the closing `</div>` of `<div class="toolbar">`, insert:

```svelte
  {#if labels && diff && diff.kind !== "submodule"}
    {#if effectiveViewMode === "side-by-side" && diff.kind === "text" && !showSvgPreview}
      <div class="pane-labels split">
        <span title={labels.left}>{labels.left}</span>
        <span title={labels.right}>{labels.right}</span>
      </div>
    {:else}
      <div class="pane-labels">
        <span>{labels.left} ← {labels.right}</span>
      </div>
    {/if}
  {/if}
```

4. Add to `<style>`:

```css
  .pane-labels {
    display: flex;
    padding: 2px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    color: var(--muted);
    font-size: 0.78em;
    font-family: var(--mono);
  }
  .pane-labels.split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .pane-labels span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
```

- [ ] **Step 4: The breadcrumb's notation**

Replace the `<script>` block of `src/lib/ui/Breadcrumb.svelte` with:

```svelte
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { popHistory } from "$lib/history";
  import { diffModeName, pairLabel } from "$lib/rangeText";
  import type { DiffMode } from "$lib/types";

  function ctxLabel(start: string, target: string, mode: DiffMode): string {
    return `${pairLabel(start, target)} (${diffModeName(mode)})`;
  }

  function currentLabel(): string {
    return ctxLabel(appState.startBranch, appState.targetBranch, appState.mode);
  }

  function previousLabel(): string | null {
    const prev = appState.history[appState.history.length - 1];
    return prev ? ctxLabel(prev.startBranch, prev.targetBranch, prev.mode) : null;
  }
</script>
```

(The markup and styles stay.)

- [ ] **Step 5: Check types and tests**

Run: `npm run check`
Expected: 0 errors (in particular no "Unused CSS selector" for `.group-refs .arrow`).

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ui/FileList.svelte src/routes/+page.svelte src/lib/ui/DiffView.svelte src/lib/ui/Breadcrumb.svelte
git commit -m "feat(branch): name each repo's range and each diff pane"
```

Body: a gitlink-followed submodule showed neither its SHAs nor where they came from, and the diff header never said which repo or refs it was between. Group headers now carry every repo's range and provenance, the diff header names the repo and range, and a label row says what each pane is.

---

### Task 6: The commit table

**Files:**
- Modify: `src/lib/types.ts` (add `BcGroup`)
- Modify: `src/lib/store.svelte.ts` (replace the containment state)
- Modify (rewrite): `src/lib/branchContainment.ts`
- Create: `src/lib/commitTableText.ts`
- Create: `src/lib/ui/CommitTable.svelte`, `src/lib/ui/FilesScope.svelte`
- Delete: `src/lib/ui/BranchContainment.svelte`
- Modify: `src/routes/+page.svelte` (layout), `src/lib/ui/InputBar.svelte` (Compare button), `src/lib/ui/DiffView.svelte` (drill summary)
- Test: `src/lib/branchContainment.test.ts`, `src/lib/commitTableText.test.ts`

**Interfaces:**
- Consumes: `resolveRepoRanges` (Task 1); `ToolbarPair`, `shortRef`, `sideNames`, `rangeLabel`, `rangeTooltip` (Task 3); git bindings `containment`, `commitLog`, `commitLogExcluding`, `commitContainmentDetail`; `compare`.
- Produces (Task 8 extends these):
  - `interface BcGroup { path; base; compare; status: "loading" | "ready" | "error"; error: string | null; marks: Containment | null; commits: Commit[]; hasMore: boolean; loadingMore: boolean; mergedBy: Commit | null | undefined }`
  - store: `bcGroups: Record<number, BcGroup>`, `bcSelected: { repoIdx: number; commit: Commit } | null`, `bcSelectedDetail: ContainmentDetail | null`, `bcShowMerged: boolean`, `commitTableHeight: number`, `commitTableCollapsed: boolean`
  - `branchContainment.ts`: `PAGE_SIZE`, `isRepoVisible(idx)`, `groupCounts(g)`, `rowMark(sha, notIn, equiv)`, `summarize(groups, pair)`, `loadBranchContainment()`, `loadMoreGroup(idx)`, `setShowMerged(on)`, `selectBranchCommit(repoIdx, commit)`, `showAllChanges()`, `clearBranchContainment()`, `interface VisibleGroup { idx: number; group: BcGroup; names: ToolbarPair }`
  - `commitTableText.ts`: `type SideNames = ToolbarPair`, `type RowMark = "out" | "patch" | "in"`, `type Summary`, `interface Counts`, `interface GroupNotes { mergedBy: Commit | null | undefined }`, `shortDate`, `summaryText`, `groupCountsText`, `statusText`, `commitStateText`, `allChangesText`

- [ ] **Step 1: Add `BcGroup`**

Append to `src/lib/types.ts`:

```ts
/// One repo's group in the Branch-mode commit table: compare's commits the
/// base lacks, with their marks. See "The commit table" in
/// docs/superpowers/specs/2026-09-29-branch-mode-clarity-design.md.
export interface BcGroup {
  /// The range this group describes (from `appState.repoRanges`).
  path: string;
  base: string;
  compare: string;
  status: "loading" | "ready" | "error";
  error: string | null;
  /// `containment(compare, base)`: the ● set, the ◐ (patch-equivalent) set,
  /// ahead / behind.
  marks: Containment | null;
  /// Rows loaded so far, and whether another page exists.
  commits: Commit[];
  hasMore: boolean;
  loadingMore: boolean;
  /// Once nothing is left to merge: the merge that brought compare in, null for
  /// a fast-forward. undefined while unknown or not applicable.
  mergedBy: Commit | null | undefined;
}
```

- [ ] **Step 2: Replace the containment state in the store**

In `src/lib/store.svelte.ts`:

1. In the type import list remove `Containment,` and add `BcGroup,` (keep `ContainmentDetail`).
2. Replace the whole block from the comment `// Branch-mode containment ("is my branch in target"): …` through the `bcRefs = $state<…>(null);` line with:

```ts
  // Branch-mode commit table: one group per repo whose range resolved, keyed
  // by repo index (see branchContainment.ts). `bcSelected` is the commit
  // picked in it, whose own diff shows via `bcDiffRange` (parent..commit inside
  // that repo) without touching the toolbar; null = all changes.
  // `bcSelectedDetail` says how the picked commit reached base. Session-only.
  bcGroups = $state<Record<number, BcGroup>>({});
  bcSelected = $state<{ repoIdx: number; commit: Commit } | null>(null);
  bcSelectedDetail = $state<ContainmentDetail | null>(null);
  bcDiffRange = $state<{ repoIdx: number; start: string; target: string } | null>(
    null,
  );
  // "Show merged commits": also list the commits already in base.
  bcShowMerged = $state(false);
  // Commit table height (px, drag-resizable) and whether it is collapsed to
  // its summary line. Session-only.
  commitTableHeight = $state(260);
  commitTableCollapsed = $state(false);
```

- [ ] **Step 3: Write the failing text tests**

Create `src/lib/commitTableText.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  allChangesText,
  commitStateText,
  groupCountsText,
  statusText,
  summaryText,
} from "./commitTableText";
import type { Commit } from "./types";

const names = { base: "main", compare: "feature/x" };
const merge: Commit = {
  sha: "3c9e2f1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  short_sha: "3c9e2f1",
  parents: ["b0", "f1"],
  author: "a",
  time: 0,
  summary: "Merge branch 'feature/x'",
  refs: [],
  body: "",
};

describe("summaryText", () => {
  it("counts what is not merged yet", () => {
    expect(summaryText({ kind: "unmerged", names, out: 8, patch: 1, behind: 9, repos: 1 })).toBe(
      "main ← feature/x: ● 8 not merged · ◐ 1 applied as patch · feature/x is 9 behind",
    );
    expect(summaryText({ kind: "unmerged", names, out: 140, patch: 1, behind: null, repos: 2 })).toBe(
      "main ← feature/x across 2 repos: ● 140 not merged · ◐ 1 applied as patch",
    );
    expect(summaryText({ kind: "unmerged", names, out: 3, patch: 0, behind: 0, repos: 1 })).toBe(
      "main ← feature/x: ● 3 not merged",
    );
  });

  it("says when only patches are left", () => {
    expect(summaryText({ kind: "patches", names, patch: 2 })).toBe(
      "✓ Every commit on feature/x is in main, 2 of them as patches (rebased, cherry-picked or squash-merged)",
    );
    expect(summaryText({ kind: "patches", names, patch: 1 })).toBe(
      "✓ Every commit on feature/x is in main, 1 of them as a patch (rebased, cherry-picked or squash-merged)",
    );
  });

  it("names the merge that brought everything in", () => {
    expect(summaryText({ kind: "merged", names, mergedBy: merge })).toMatch(
      /^✓ All commits on feature\/x are in main — merged by 3c9e2f1 "Merge branch 'feature\/x'" · /,
    );
    expect(summaryText({ kind: "merged", names, mergedBy: null })).toBe(
      "✓ All commits on feature/x are in main (fast-forward, no merge commit)",
    );
  });

  it("covers the remaining states", () => {
    expect(summaryText({ kind: "all-in", names, repos: 2 })).toBe(
      "✓ All changes on feature/x are in main across 2 repos",
    );
    expect(summaryText({ kind: "no-refs" })).toBe(
      "Pick base and compare to see which commits are merged.",
    );
    expect(summaryText({ kind: "same" })).toBe("base and compare are the same.");
    expect(summaryText({ kind: "loading" })).toBe("Checking commits…");
    expect(summaryText({ kind: "error" })).toBe("Couldn't read commits.");
  });
});

describe("group, row and Files header text", () => {
  it("writes a group header's counts", () => {
    expect(groupCountsText({ out: 3, patch: 1, behind: 9 }, names, { mergedBy: undefined })).toBe(
      "● 3 ◐ 1 · feature/x is 9 behind",
    );
    expect(groupCountsText({ out: 0, patch: 0, behind: 0 }, names, { mergedBy: merge })).toBe(
      "✓ all in main · merged by 3c9e2f1",
    );
    expect(groupCountsText({ out: 0, patch: 0, behind: 0 }, names, { mergedBy: null })).toBe(
      "✓ all in main",
    );
  });

  it("writes a row's status", () => {
    expect(statusText("out", names)).toBe("not in main");
    expect(statusText("patch", names)).toBe("applied as patch");
    expect(statusText("in", names)).toBe("in main");
  });

  it("writes the picked commit's state", () => {
    expect(commitStateText("out", names, null)).toBe("not in main");
    expect(commitStateText("patch", names, null)).toBe("applied to main as a patch");
    expect(commitStateText("in", names, { in_target: true, introduced_by: merge })).toMatch(
      /^merged by 3c9e2f1 \(/,
    );
    expect(commitStateText("in", names, null)).toBe("in main");
  });

  it("writes the all-changes line", () => {
    expect(allChangesText(names)).toBe("All changes · main ← feature/x");
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run src/lib/commitTableText.test.ts`
Expected: FAIL — `Failed to resolve import "./commitTableText"`.

- [ ] **Step 5: Implement the text module**

Create `src/lib/commitTableText.ts`:

```ts
import type { ToolbarPair } from "./rangeText";
import type { Commit, ContainmentDetail } from "./types";

/// How a range's two sides are named (see rangeText.sideNames).
export type SideNames = ToolbarPair;

/// A row's mark: ● not in base, ◐ in base as a patch, ✓ in base by ancestry.
export type RowMark = "out" | "patch" | "in";

/// ● / ◐ / behind counts for a group or a total.
export interface Counts {
  out: number;
  patch: number;
  behind: number;
}

/// What a group header can add beyond its counts.
export interface GroupNotes {
  mergedBy: Commit | null | undefined;
}

/// The summary line's state, decided by branchContainment.summarize().
export type Summary =
  | { kind: "no-refs" }
  | { kind: "same" }
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "unmerged";
      names: SideNames;
      out: number;
      patch: number;
      behind: number | null;
      repos: number;
    }
  | { kind: "patches"; names: SideNames; patch: number }
  | { kind: "merged"; names: SideNames; mergedBy: Commit | null }
  | { kind: "all-in"; names: SideNames; repos: number };

/// The table's short date, in the user's locale.
export function shortDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function summaryText(s: Summary): string {
  switch (s.kind) {
    case "no-refs":
      return "Pick base and compare to see which commits are merged.";
    case "same":
      return "base and compare are the same.";
    case "loading":
      return "Checking commits…";
    case "error":
      return "Couldn't read commits.";
    case "unmerged": {
      const range = `${s.names.base} ← ${s.names.compare}`;
      const head = s.repos > 1 ? `${range} across ${s.repos} repos:` : `${range}:`;
      const parts = [`● ${s.out} not merged`];
      if (s.patch > 0) parts.push(`◐ ${s.patch} applied as patch`);
      if (s.behind) parts.push(`${s.names.compare} is ${s.behind} behind`);
      return `${head} ${parts.join(" · ")}`;
    }
    case "patches":
      return `✓ Every commit on ${s.names.compare} is in ${s.names.base}, ${s.patch} of them as ${s.patch === 1 ? "a patch" : "patches"} (rebased, cherry-picked or squash-merged)`;
    case "merged":
      return s.mergedBy
        ? `✓ All commits on ${s.names.compare} are in ${s.names.base} — merged by ${s.mergedBy.short_sha} "${s.mergedBy.summary}" · ${shortDate(s.mergedBy.time)}`
        : `✓ All commits on ${s.names.compare} are in ${s.names.base} (fast-forward, no merge commit)`;
    case "all-in":
      return `✓ All changes on ${s.names.compare} are in ${s.names.base} across ${s.repos} repos`;
  }
}

/// The counts on a group header.
export function groupCountsText(c: Counts, names: SideNames, n: GroupNotes): string {
  if (c.out === 0 && c.patch === 0) {
    return n.mergedBy
      ? `✓ all in ${names.base} · merged by ${n.mergedBy.short_sha}`
      : `✓ all in ${names.base}`;
  }
  const parts: string[] = [];
  if (c.out > 0) parts.push(`● ${c.out}`);
  if (c.patch > 0) parts.push(`◐ ${c.patch}`);
  let text = parts.join(" ");
  if (c.behind > 0) text += ` · ${names.compare} is ${c.behind} behind`;
  return text;
}

/// A row's status column.
export function statusText(mark: RowMark, names: SideNames): string {
  switch (mark) {
    case "out":
      return `not in ${names.base}`;
    case "patch":
      return "applied as patch";
    case "in":
      return `in ${names.base}`;
  }
}

/// The Files header's account of the picked commit.
export function commitStateText(
  mark: RowMark,
  names: SideNames,
  detail: ContainmentDetail | null,
): string {
  switch (mark) {
    case "out":
      return `not in ${names.base}`;
    case "patch":
      return `applied to ${names.base} as a patch`;
    case "in": {
      const m = detail?.introduced_by;
      return m
        ? `merged by ${m.short_sha} (${shortDate(m.time)})`
        : `in ${names.base}`;
    }
  }
}

/// The Files header while nothing is picked.
export function allChangesText(names: SideNames): string {
  return `All changes · ${names.base} ← ${names.compare}`;
}
```

- [ ] **Step 6: Run the text tests to verify they pass**

Run: `npx vitest run src/lib/commitTableText.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing data-layer tests**

Create `src/lib/branchContainment.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// branchContainment.ts drives the runes store, four Tauri bindings, the range
// resolver and compare(); all are stubbed. Specifiers resolve relative to this
// file (src/lib).
vi.mock("./store.svelte", () => ({ appState: {} }));
vi.mock("./git", () => ({
  containment: vi.fn(),
  commitLog: vi.fn(),
  commitLogExcluding: vi.fn(),
  commitContainmentDetail: vi.fn(),
}));
vi.mock("./repoRange", () => ({ resolveRepoRanges: vi.fn() }));
vi.mock("./compare", () => ({ compare: vi.fn() }));

import {
  PAGE_SIZE,
  groupCounts,
  isRepoVisible,
  loadBranchContainment,
  loadMoreGroup,
  rowMark,
  selectBranchCommit,
  setShowMerged,
  showAllChanges,
  summarize,
  type VisibleGroup,
} from "./branchContainment";
import { appState } from "./store.svelte";
import {
  commitContainmentDetail,
  commitLog,
  commitLogExcluding,
  containment,
} from "./git";
import { resolveRepoRanges } from "./repoRange";
import { compare } from "./compare";
import type { BcGroup, Commit, Containment, RepoEntry, RepoRange } from "./types";

const commit = (sha: string, parents: string[] = ["p"]): Commit => ({
  sha,
  short_sha: sha.slice(0, 7),
  parents,
  author: "a",
  time: 0,
  summary: sha,
  refs: [],
  body: "",
});
const marks = (m: Partial<Containment>): Containment => ({
  not_in_target: [],
  equivalent: [],
  ahead: 0,
  behind: 0,
  source_is_branch: true,
  ...m,
});
const range = (path: string, base: string, compare: string): RepoRange => ({
  ok: true,
  path,
  base,
  compare,
  source: "toolbar",
});
const repos: RepoEntry[] = [
  { path: "/main", kind: "main", displayName: "main" },
  { path: "/main/sub", kind: "submodule", displayName: "sub", parentGitlinkPath: "sub" },
];
const tick = () => new Promise((r) => setTimeout(r, 0));
const group = (g: Partial<BcGroup>): BcGroup => ({
  path: "/main",
  base: "main",
  compare: "feature",
  status: "ready",
  error: null,
  marks: marks({}),
  commits: [],
  hasMore: false,
  loadingMore: false,
  mergedBy: undefined,
  ...g,
});
const names = { base: "main", compare: "feature" };

beforeEach(() => {
  for (const f of [containment, commitLog, commitLogExcluding, commitContainmentDetail, resolveRepoRanges, compare]) {
    vi.mocked(f).mockReset();
  }
  Object.assign(appState, {
    appMode: "compare",
    repoPath: "/main",
    repos,
    activeRepoIdx: null,
    workspaceLayout: "unified",
    bcGroups: {},
    bcSelected: null,
    bcSelectedDetail: null,
    bcDiffRange: null,
    bcShowMerged: false,
    selectedFile: null,
    files: [],
  });
});

describe("loadBranchContainment", () => {
  it("builds one group per resolved range, asking about compare's commits against base", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      range("/main", "main", "feature"),
      { ok: false, reason: "unchanged", pin: "x" },
    ]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    await loadBranchContainment();
    expect(containment).toHaveBeenCalledWith("/main", "feature", "main");
    expect(commitLogExcluding).toHaveBeenCalledWith("/main", "feature", "main", PAGE_SIZE, 0);
    expect(Object.keys(appState.bcGroups)).toEqual(["0"]);
    expect(appState.bcGroups[0].status).toBe("ready");
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c1"]);
    expect(commitContainmentDetail).not.toHaveBeenCalled();
  });

  it("looks up the introducing merge once nothing is left to merge", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitContainmentDetail).mockResolvedValue({
      in_target: true,
      introduced_by: commit("m1", ["b0", "f1"]),
    });
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    await loadBranchContainment();
    expect(commitContainmentDetail).toHaveBeenCalledWith("/main", "feature", "main");
    expect(appState.bcGroups[0].mergedBy?.sha).toBe("m1");
  });

  it("keeps a failing group from affecting the others", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      range("/main", "main", "feature"),
      range("/main/sub", "aaa", "bbb"),
    ]);
    vi.mocked(containment).mockImplementation((path) =>
      path === "/main/sub" ? Promise.reject("boom") : Promise.resolve(marks({ not_in_target: ["c1"], ahead: 1 })),
    );
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    await loadBranchContainment();
    expect(appState.bcGroups[0].status).toBe("ready");
    expect(appState.bcGroups[1].status).toBe("error");
    expect(appState.bcGroups[1].error).toContain("boom");
  });

  it("drops results from a load the inputs have moved past", async () => {
    let release: (m: Containment) => void = () => {};
    vi.mocked(resolveRepoRanges)
      .mockResolvedValueOnce([range("/main", "main", "old")])
      .mockResolvedValueOnce([range("/main", "main", "new")]);
    vi.mocked(containment)
      .mockImplementationOnce(() => new Promise<Containment>((r) => (release = r)))
      .mockResolvedValueOnce(marks({ not_in_target: ["n1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("n1")]);
    const first = loadBranchContainment();
    await tick();
    await loadBranchContainment();
    release(marks({ not_in_target: ["o1"], ahead: 1 }));
    await first;
    expect(appState.bcGroups[0].compare).toBe("new");
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["n1"]);
  });

  it("drops a picked commit on reload and lists all changes again", async () => {
    // Review focus: a window-focus refresh must not leave the old commit's
    // files on screen after its pick is gone.
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1", ["c0"])]);
    vi.mocked(commitContainmentDetail).mockResolvedValue({ in_target: false, introduced_by: null });
    await loadBranchContainment();
    selectBranchCommit(0, appState.bcGroups[0].commits[0]);
    vi.mocked(compare).mockClear();
    await loadBranchContainment();
    expect(appState.bcSelected).toBeNull();
    expect(appState.bcDiffRange).toBeNull();
    expect(compare).toHaveBeenCalledWith({ silent: true });
  });

  it("clears a leftover file selection when there is nothing to compare", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([{ ok: false, reason: "no-refs" }]);
    appState.files = [{ path: "x", old_path: null, status: "modified", repoIdx: 0 }];
    await loadBranchContainment();
    expect(appState.bcGroups).toEqual({});
    expect(appState.files).toEqual([]);
  });
});

describe("paging and merged commits", () => {
  it("loads the next page from where the list ends", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 150 }));
    vi.mocked(commitLogExcluding)
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => commit(`c${i}`)))
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => commit(`d${i}`)));
    await loadBranchContainment();
    expect(appState.bcGroups[0].hasMore).toBe(true);
    await loadMoreGroup(0);
    expect(commitLogExcluding).toHaveBeenLastCalledWith("/main", "feature", "main", PAGE_SIZE, 100);
    expect(appState.bcGroups[0].commits).toHaveLength(150);
    expect(appState.bcGroups[0].hasMore).toBe(false);
  });

  it("lists what the introducing merge brought in when merged commits are shown", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ ahead: 0 }));
    vi.mocked(commitContainmentDetail).mockResolvedValue({
      in_target: true,
      introduced_by: commit("m1", ["b0", "f1"]),
    });
    vi.mocked(commitLogExcluding).mockResolvedValueOnce([]).mockResolvedValueOnce([commit("f1")]);
    await loadBranchContainment();
    await setShowMerged(true);
    expect(commitLogExcluding).toHaveBeenLastCalledWith("/main", "feature", "b0", PAGE_SIZE, 0);
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["f1"]);
  });

  it("falls back to compare's history when no merge is known", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    vi.mocked(commitLog).mockResolvedValue([commit("c1"), commit("old")]);
    await loadBranchContainment();
    await setShowMerged(true);
    expect(commitLog).toHaveBeenCalledWith("/main", "feature", false, PAGE_SIZE, 0);
    expect(appState.bcGroups[0].commits.map((c) => c.sha)).toEqual(["c1", "old"]);
  });
});

describe("picking a commit", () => {
  it("diffs the commit inside its own repo and goes back to all changes", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      range("/main", "main", "feature"),
      range("/main/sub", "aaa", "bbb"),
    ]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["s1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("s1", ["s0"])]);
    vi.mocked(commitContainmentDetail).mockResolvedValue({ in_target: false, introduced_by: null });
    await loadBranchContainment();
    selectBranchCommit(1, appState.bcGroups[1].commits[0]);
    expect(appState.bcDiffRange).toEqual({ repoIdx: 1, start: "s0", target: "s1" });
    expect(appState.bcSelected?.repoIdx).toBe(1);
    expect(compare).toHaveBeenCalledTimes(1);
    showAllChanges();
    expect(appState.bcDiffRange).toBeNull();
    expect(appState.bcSelected).toBeNull();
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it("diffs a root commit against the empty tree", () => {
    appState.bcGroups = { 0: group({}) };
    selectBranchCommit(0, commit("r1", []));
    expect(appState.bcDiffRange?.start).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
});

describe("pure helpers", () => {
  it("counts patch-equivalent commits apart from unmerged ones", () => {
    expect(groupCounts(group({ marks: marks({ ahead: 5, equivalent: ["a", "b"], behind: 3 }) }))).toEqual({
      out: 3,
      patch: 2,
      behind: 3,
    });
  });

  it("marks a row", () => {
    const notIn = new Set(["a", "b"]);
    const equiv = new Set(["b"]);
    expect(rowMark("a", notIn, equiv)).toBe("out");
    expect(rowMark("b", notIn, equiv)).toBe("patch");
    expect(rowMark("z", notIn, equiv)).toBe("in");
  });

  it("follows the active tab in Tabs, and Focus in Unified", () => {
    // Review focus: with a submodule tab active the table must show that tab.
    Object.assign(appState, { workspaceLayout: "tabs", activeRepoIdx: 1 });
    expect([0, 1].map(isRepoVisible)).toEqual([false, true]);
    Object.assign(appState, { workspaceLayout: "unified", activeRepoIdx: null });
    expect([0, 1].map(isRepoVisible)).toEqual([true, true]);
    Object.assign(appState, { activeRepoIdx: 0 });
    expect([0, 1].map(isRepoVisible)).toEqual([true, false]);
  });
});

describe("summarize", () => {
  const pair = { base: "main", compare: "feature" };
  const vis = (idx: number, g: BcGroup): VisibleGroup => ({ idx, group: g, names });

  it("uses the single-group wording when one group is visible", () => {
    // Review focus: repos without a range have no group; one group left means
    // the single-group sentence.
    expect(summarize([vis(0, group({ marks: marks({ ahead: 3, behind: 2 }) }))], pair)).toEqual({
      kind: "unmerged",
      names,
      out: 3,
      patch: 0,
      behind: 2,
      repos: 1,
    });
    expect(summarize([vis(0, group({ marks: marks({ ahead: 2, equivalent: ["a", "b"] }) }))], pair)).toEqual({
      kind: "patches",
      names,
      patch: 2,
    });
    expect(summarize([vis(0, group({ mergedBy: null }))], pair)).toEqual({
      kind: "merged",
      names,
      mergedBy: null,
    });
  });

  it("totals several groups", () => {
    const a = vis(0, group({ marks: marks({ ahead: 3 }) }));
    const b = vis(1, group({ marks: marks({ ahead: 2, equivalent: ["x"] }) }));
    expect(summarize([a, b], pair)).toEqual({
      kind: "unmerged",
      names: pair,
      out: 4,
      patch: 1,
      behind: null,
      repos: 2,
    });
    expect(summarize([vis(0, group({})), vis(1, group({}))], pair)).toEqual({
      kind: "all-in",
      names: pair,
      repos: 2,
    });
  });

  it("covers empty, same, loading and failed states", () => {
    expect(summarize([], pair)).toEqual({ kind: "no-refs" });
    expect(summarize([vis(0, group({ compare: "main" }))], pair)).toEqual({ kind: "same" });
    expect(summarize([vis(0, group({ status: "loading" }))], pair)).toEqual({ kind: "loading" });
    expect(summarize([vis(0, group({ status: "error" }))], pair)).toEqual({ kind: "error" });
  });
});
```

- [ ] **Step 8: Run them to verify they fail**

Run: `npx vitest run src/lib/branchContainment.test.ts`
Expected: FAIL — missing exports (`PAGE_SIZE`, `groupCounts`, `showAllChanges`, …).

- [ ] **Step 9: Rewrite the data layer**

Replace the whole of `src/lib/branchContainment.ts` with:

```ts
import { appState } from "./store.svelte";
import {
  commitContainmentDetail,
  commitLog,
  commitLogExcluding,
  containment,
} from "./git";
import { compare } from "./compare";
import { resolveRepoRanges } from "./repoRange";
import type { ToolbarPair } from "./rangeText";
import type { Counts, RowMark, SideNames, Summary } from "./commitTableText";
import type { BcGroup, Commit, RepoRange } from "./types";

/// Rows fetched per page of a commit-table group.
export const PAGE_SIZE = 100;

/// Git's empty-tree object — the "before" side for a root commit (no parent).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Monotonic guard: every reload bumps it, so the results of an older load,
// page or detail fetch can't land on the new groups.
let bcSession = 0;

/// Whether repo `idx` is on screen: the active tab in Tabs, the focused repo
/// (or every repo) in Unified. The commit table and the file list agree on it.
export function isRepoVisible(idx: number): boolean {
  if (appState.workspaceLayout === "tabs") {
    return idx === (appState.activeRepoIdx ?? 0);
  }
  return appState.activeRepoIdx === null || appState.activeRepoIdx === idx;
}

/// ● (not in base), ◐ (in base as an equivalent patch) and behind counts.
export function groupCounts(g: BcGroup): Counts {
  if (!g.marks) return { out: 0, patch: 0, behind: 0 };
  const patch = g.marks.equivalent.length;
  return {
    out: Math.max(0, g.marks.ahead - patch),
    patch,
    behind: g.marks.behind,
  };
}

/// A row's mark from its group's ● and ◐ sets.
export function rowMark(
  sha: string,
  notIn: Set<string>,
  equiv: Set<string>,
): RowMark {
  if (equiv.has(sha)) return "patch";
  if (notIn.has(sha)) return "out";
  return "in";
}

/// A group on screen, with the names its range's sides go by.
export interface VisibleGroup {
  idx: number;
  group: BcGroup;
  names: SideNames;
}

/// The summary line's state for the groups on screen: one group speaks for
/// itself; several give totals, and read as all in once none has ● left.
export function summarize(groups: VisibleGroup[], pair: ToolbarPair): Summary {
  if (groups.length === 0) return { kind: "no-refs" };
  if (groups.length === 1 && groups[0].group.base === groups[0].group.compare) {
    return { kind: "same" };
  }
  const ready = groups.filter((v) => v.group.status === "ready");
  if (ready.length === 0) {
    return groups.some((v) => v.group.status === "loading")
      ? { kind: "loading" }
      : { kind: "error" };
  }
  if (groups.length === 1) {
    const { group: g, names } = groups[0];
    const c = groupCounts(g);
    if (c.out > 0) {
      return { kind: "unmerged", names, out: c.out, patch: c.patch, behind: c.behind, repos: 1 };
    }
    if (c.patch > 0) return { kind: "patches", names, patch: c.patch };
    return { kind: "merged", names, mergedBy: g.mergedBy ?? null };
  }
  let out = 0;
  let patch = 0;
  for (const v of ready) {
    const c = groupCounts(v.group);
    out += c.out;
    patch += c.patch;
  }
  if (out > 0) {
    return { kind: "unmerged", names: pair, out, patch, behind: null, repos: groups.length };
  }
  if (ready.length < groups.length) return { kind: "loading" };
  return { kind: "all-in", names: pair, repos: groups.length };
}

function emptyGroup(range: Extract<RepoRange, { ok: true }>): BcGroup {
  return {
    path: range.path,
    base: range.base,
    compare: range.compare,
    status: "loading",
    error: null,
    marks: null,
    commits: [],
    hasMore: false,
    loadingMore: false,
    mergedBy: undefined,
  };
}

function patchGroup(idx: number, patch: Partial<BcGroup>): void {
  const cur = appState.bcGroups[idx];
  if (!cur) return;
  appState.bcGroups = { ...appState.bcGroups, [idx]: { ...cur, ...patch } };
}

/// One page of a group's rows. Default: compare's commits the base lacks.
/// With merged commits shown: what the introducing merge brought in when it
/// is known, otherwise compare's history.
function fetchPage(g: BcGroup, skip: number): Promise<Commit[]> {
  if (!appState.bcShowMerged) {
    return commitLogExcluding(g.path, g.compare, g.base, PAGE_SIZE, skip);
  }
  const beforeMerge = g.mergedBy?.parents[0];
  return beforeMerge
    ? commitLogExcluding(g.path, g.compare, beforeMerge, PAGE_SIZE, skip)
    : commitLog(g.path, g.compare, false, PAGE_SIZE, skip);
}

async function loadGroup(idx: number, s: number): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g) return;
  try {
    const marks = await containment(g.path, g.compare, g.base);
    if (s !== bcSession) return;
    let mergedBy: Commit | null | undefined;
    if (marks.ahead === 0) {
      try {
        mergedBy = (await commitContainmentDetail(g.path, g.compare, g.base))
          .introduced_by;
      } catch {
        mergedBy = undefined;
      }
      if (s !== bcSession) return;
    }
    patchGroup(idx, { marks, mergedBy });
    const commits = await fetchPage(appState.bcGroups[idx], 0);
    if (s !== bcSession) return;
    patchGroup(idx, {
      status: "ready",
      commits,
      hasMore: commits.length === PAGE_SIZE,
    });
  } catch (e) {
    if (s === bcSession) patchGroup(idx, { status: "error", error: String(e) });
  }
}

/// Rebuild the commit table for the current inputs: one group per repo whose
/// range resolved, each loading its marks and first page on its own. A picked
/// commit belonged to the old comparison, so it is dropped — and the file list
/// goes back to all changes rather than keep showing that commit's files.
export async function loadBranchContainment(): Promise<void> {
  const s = ++bcSession;
  if (appState.appMode !== "compare" || !appState.repoPath) {
    clearBranchContainment();
    return;
  }
  const ranges = await resolveRepoRanges();
  if (s !== bcSession) return;
  const hadPick = appState.bcDiffRange !== null;
  appState.bcSelected = null;
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = null;
  const groups: Record<number, BcGroup> = {};
  ranges.forEach((r, i) => {
    if (r.ok) groups[i] = emptyGroup(r);
  });
  appState.bcGroups = groups;
  if (Object.keys(groups).length === 0) {
    // Nothing to compare yet: drop a leftover selection (e.g. a file opened in
    // Changes) so the diff pane shows its placeholder, not an error.
    appState.selectedFile = null;
    appState.files = [];
    return;
  }
  if (hadPick) void compare({ silent: true });
  await Promise.all(Object.keys(groups).map((k) => loadGroup(Number(k), s)));
}

/// The next page of group `idx` — its "Load 100 more" row.
export async function loadMoreGroup(idx: number): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g || g.status !== "ready" || !g.hasMore || g.loadingMore) return;
  const s = bcSession;
  patchGroup(idx, { loadingMore: true });
  try {
    const page = await fetchPage(g, g.commits.length);
    if (s !== bcSession) return;
    patchGroup(idx, {
      commits: appState.bcGroups[idx].commits.concat(page),
      hasMore: page.length === PAGE_SIZE,
      loadingMore: false,
    });
  } catch {
    if (s === bcSession) patchGroup(idx, { loadingMore: false });
  }
}

/// Show or hide the commits already in base, reloading every group's rows.
export async function setShowMerged(on: boolean): Promise<void> {
  appState.bcShowMerged = on;
  const s = bcSession;
  await Promise.all(
    Object.keys(appState.bcGroups).map(async (k) => {
      const idx = Number(k);
      const g = appState.bcGroups[idx];
      if (!g || g.status !== "ready") return;
      try {
        const commits = await fetchPage(g, 0);
        if (s !== bcSession) return;
        patchGroup(idx, { commits, hasMore: commits.length === PAGE_SIZE });
      } catch (e) {
        if (s === bcSession) patchGroup(idx, { status: "error", error: String(e) });
      }
    }),
  );
}

/// Pick a commit: its own diff (parent..commit) shows, inside its repo only.
export function selectBranchCommit(repoIdx: number, commit: Commit): void {
  appState.bcSelected = { repoIdx, commit };
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = {
    repoIdx,
    start: commit.parents[0] ?? EMPTY_TREE,
    target: commit.sha,
  };
  void loadSelectedDetail(repoIdx, commit.sha);
  void compare();
}

/// Drop the picked commit and show all changes again.
export function showAllChanges(): void {
  appState.bcSelected = null;
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = null;
  void compare();
}

/// How the picked commit reached base (the introducing merge), for the Files
/// header.
async function loadSelectedDetail(repoIdx: number, sha: string): Promise<void> {
  const g = appState.bcGroups[repoIdx];
  if (!g) return;
  const s = bcSession;
  try {
    const d = await commitContainmentDetail(g.path, sha, g.base);
    if (s !== bcSession || appState.bcSelected?.commit.sha !== sha) return;
    appState.bcSelectedDetail = d;
  } catch {
    /* the header falls back to the row's own mark */
  }
}

/// Reset the commit table (leaving compare mode, switching repo).
export function clearBranchContainment(): void {
  bcSession++;
  appState.bcGroups = {};
  appState.bcSelected = null;
  appState.bcSelectedDetail = null;
  appState.bcDiffRange = null;
}
```

- [ ] **Step 10: Run the data-layer tests to verify they pass**

Run: `npx vitest run src/lib/branchContainment.test.ts src/lib/commitTableText.test.ts`
Expected: PASS.

- [ ] **Step 11: Create the commit table component**

Create `src/lib/ui/CommitTable.svelte`:

```svelte
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    PAGE_SIZE,
    groupCounts,
    isRepoVisible,
    loadBranchContainment,
    loadMoreGroup,
    rowMark,
    selectBranchCommit,
    setShowMerged,
    showAllChanges,
    summarize,
    type VisibleGroup,
  } from "$lib/branchContainment";
  import { rangeLabel, rangeTooltip, sideNames } from "$lib/rangeText";
  import {
    groupCountsText,
    shortDate,
    statusText,
    summaryText,
    type RowMark,
  } from "$lib/commitTableText";
  import type { BcGroup, Commit, RepoEntry } from "$lib/types";

  // Rebuild when the compared refs or the repo change — including when the
  // repo moves under us (refsRefresh: fetch, checkout, rebase, push, another
  // tool). Focus and tabs only filter what is shown, so they reload nothing.
  $effect(() => {
    void appState.startBranch;
    void appState.targetBranch;
    void appState.repoPath;
    void appState.refsRefresh;
    void appState.repos;
    if (appState.appMode === "compare") void loadBranchContainment();
  });

  const pair = $derived({
    base: appState.startBranch,
    compare: appState.targetBranch,
  });
  const superName = $derived(appState.repos[0]?.displayName ?? "");
  const multi = $derived(appState.repos.length > 1);

  // Every repo on screen, in workspace order: those with a group, and those
  // whose range did not resolve (a dimmed header that says why).
  const rows = $derived.by(() => {
    const out: { idx: number; repo: RepoEntry; group: BcGroup | null }[] = [];
    appState.repos.forEach((repo, idx) => {
      if (!isRepoVisible(idx) || !appState.repoRanges[idx]) return;
      out.push({ idx, repo, group: appState.bcGroups[idx] ?? null });
    });
    return out;
  });

  const visible = $derived<VisibleGroup[]>(
    rows.flatMap((r) => {
      const range = appState.repoRanges[r.idx];
      return r.group && range?.ok
        ? [{ idx: r.idx, group: r.group, names: sideNames(range, pair) }]
        : [];
    }),
  );
  const summary = $derived(summaryText(summarize(visible, pair)));

  // O(1) marks per row.
  const sets = $derived.by(() => {
    const m = new Map<number, { notIn: Set<string>; equiv: Set<string> }>();
    for (const [k, g] of Object.entries(appState.bcGroups)) {
      m.set(Number(k), {
        notIn: new Set(g.marks?.not_in_target ?? []),
        equiv: new Set(g.marks?.equivalent ?? []),
      });
    }
    return m;
  });
  function markOf(idx: number, sha: string): RowMark {
    const s = sets.get(idx);
    return s ? rowMark(sha, s.notIn, s.equiv) : "in";
  }
  const glyph: Record<RowMark, string> = { out: "●", patch: "◐", in: "✓" };

  let collapsed = $state(new Set<number>());
  function toggleGroup(idx: number) {
    const next = new Set(collapsed);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    collapsed = next;
  }

  function isPicked(idx: number, sha: string): boolean {
    const sel = appState.bcSelected;
    return !!sel && sel.repoIdx === idx && sel.commit.sha === sha;
  }
  function clickRow(idx: number, c: Commit) {
    if (isPicked(idx, c.sha)) showAllChanges();
    else selectBranchCommit(idx, c);
  }

  // How many unmerged rows are still unloaded (default list only).
  function leftCount(g: BcGroup): number | null {
    if (appState.bcShowMerged || !g.marks) return null;
    return Math.max(0, g.marks.ahead - g.commits.length);
  }
</script>

<div class="ct">
  <div class="ct-summary">
    <span class="text" title={summary}>{summary}</span>
    <label class="toggle" title="Also list the commits already in base">
      <input
        type="checkbox"
        checked={appState.bcShowMerged}
        onchange={(e) => void setShowMerged(e.currentTarget.checked)}
      />
      Show merged commits
    </label>
    <button
      type="button"
      class="collapse"
      title={appState.commitTableCollapsed ? "Show the commits" : "Hide the commits"}
      onclick={() => (appState.commitTableCollapsed = !appState.commitTableCollapsed)}
    >
      {appState.commitTableCollapsed ? "▾ show commits" : "▴"}
    </button>
  </div>

  {#if !appState.commitTableCollapsed}
    <div class="ct-head" aria-hidden="true">
      <span></span><span>SHA</span><span>Summary</span><span>Author</span><span>Date</span><span>Status</span>
    </div>
    <div class="ct-body">
      {#each rows as r (r.idx)}
        {@const range = appState.repoRanges[r.idx]}
        {@const g = r.group}
        {#if multi}
          <div class="ct-group" class:dim={!g}>
            <button
              type="button"
              class="g-toggle"
              disabled={!g}
              onclick={() => toggleGroup(r.idx)}
            >
              <span class="caret">{!g || collapsed.has(r.idx) ? "▸" : "▾"}</span>
              <span class="g-name">{r.repo.displayName}</span>
            </button>
            <span class="kind" data-kind={r.repo.kind}>
              {r.repo.kind === "main" ? "super" : r.repo.kind}
            </span>
            <span class="g-range" title={rangeTooltip(range, pair)}>
              {rangeLabel(range, superName, pair)}
            </span>
            {#if g && range.ok}
              <span class="g-counts">
                {#if g.status === "loading"}
                  …
                {:else if g.status === "error"}
                  couldn't read commits
                {:else}
                  {groupCountsText(groupCounts(g), sideNames(range, pair), { mergedBy: g.mergedBy })}
                {/if}
              </span>
            {/if}
          </div>
        {/if}
        {#if g && range.ok && !collapsed.has(r.idx)}
          {@const names = sideNames(range, pair)}
          {#if g.status === "error"}
            <div class="ct-note error">Couldn't read commits: {g.error}</div>
          {:else}
            {#if appState.bcShowMerged && g.mergedBy}
              <div class="ct-sub">brought in by {g.mergedBy.short_sha}</div>
            {/if}
            {#each g.commits as c (c.sha)}
              {@const mark = markOf(r.idx, c.sha)}
              <button
                type="button"
                class="ct-row"
                class:sel={isPicked(r.idx, c.sha)}
                class:dim={mark === "in"}
                onclick={() => clickRow(r.idx, c)}
                title={c.summary}
              >
                <span class="mark {mark}">{glyph[mark]}</span>
                <span class="sha">{c.short_sha}</span>
                <span class="sum">
                  {#if c.parents.length > 1}<span class="mtag">merge</span>{/if}{c.summary}
                </span>
                <span class="author">{c.author}</span>
                <span class="date">{shortDate(c.time)}</span>
                <span class="status {mark}">{statusText(mark, names)}</span>
              </button>
            {/each}
            {#if g.hasMore}
              {@const left = leftCount(g)}
              <button
                type="button"
                class="ct-more"
                disabled={g.loadingMore}
                onclick={() => void loadMoreGroup(r.idx)}
              >
                {g.loadingMore
                  ? "Loading…"
                  : left !== null
                    ? `Load ${PAGE_SIZE} more (${left} left)`
                    : `Load ${PAGE_SIZE} more`}
              </button>
            {/if}
          {/if}
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .ct {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
    font-size: 0.84em;
  }
  .ct-summary {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .ct-summary .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }
  .collapse {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--muted);
    cursor: pointer;
    padding: 1px 8px;
    font: inherit;
  }
  .ct-head,
  .ct-row {
    display: grid;
    grid-template-columns: 16px 64px minmax(0, 1fr) 110px 64px minmax(120px, 190px);
    gap: 8px;
    align-items: center;
    padding: 3px 10px;
  }
  .ct-head {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 0.85em;
    border-bottom: 1px solid var(--border);
  }
  .ct-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .ct-group {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 10px;
    background: var(--sidebar-bg);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
  }
  .ct-group.dim {
    opacity: 0.6;
  }
  .g-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 0;
  }
  .g-toggle:disabled {
    cursor: default;
  }
  .kind {
    font-size: 0.72em;
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .kind[data-kind="submodule"] {
    color: var(--accent);
    border-color: var(--accent);
  }
  .g-range {
    font-family: var(--mono);
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .g-counts {
    margin-left: auto;
    flex-shrink: 0;
    font-family: var(--mono);
  }
  .ct-row {
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .ct-row:hover {
    background: var(--hover);
  }
  .ct-row.sel {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .ct-row.dim .sum,
  .ct-row.dim .author,
  .ct-row.dim .date {
    opacity: 0.6;
  }
  .ct-row > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .mark {
    font-family: var(--mono);
    text-align: center;
  }
  .mark.out,
  .status.out {
    color: var(--error-fg, #f85149);
  }
  .mark.patch,
  .status.patch {
    color: var(--accent);
  }
  .mark.in,
  .status.in {
    color: var(--ok-fg, #3fb950);
  }
  .sha {
    font-family: var(--mono);
    color: var(--accent);
  }
  .mtag {
    font-size: 0.8em;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 4px;
    margin-right: 5px;
    color: var(--muted);
  }
  .author,
  .date {
    color: var(--muted);
  }
  .ct-sub,
  .ct-note {
    padding: 3px 10px 3px 34px;
    color: var(--muted);
    font-style: italic;
    border-bottom: 1px solid var(--border);
  }
  .ct-note.error {
    color: var(--error-fg, #f85149);
    font-style: normal;
  }
  .ct-more {
    width: 100%;
    padding: 4px 10px 4px 34px;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--accent);
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .ct-more:disabled {
    color: var(--muted);
    cursor: default;
  }
</style>
```

- [ ] **Step 12: Create the Files scope line**

Create `src/lib/ui/FilesScope.svelte`:

```svelte
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { isRepoVisible, rowMark, showAllChanges } from "$lib/branchContainment";
  import { shortRef, sideNames } from "$lib/rangeText";
  import { allChangesText, commitStateText } from "$lib/commitTableText";

  // The line above the file list: what the list holds — every change of the
  // range on screen, or one picked commit and how it stands against base.
  const pair = $derived({
    base: appState.startBranch,
    compare: appState.targetBranch,
  });
  const visibleOk = $derived(
    appState.repoRanges.flatMap((r, i) => (r.ok && isRepoVisible(i) ? [r] : [])),
  );
  const allNames = $derived(
    visibleOk.length === 1
      ? sideNames(visibleOk[0], pair)
      : { base: shortRef(pair.base), compare: shortRef(pair.compare) },
  );

  const picked = $derived.by(() => {
    const sel = appState.bcSelected;
    if (!sel) return null;
    const g = appState.bcGroups[sel.repoIdx];
    const range = appState.repoRanges[sel.repoIdx];
    if (!g || !range?.ok) return null;
    const mark = rowMark(
      sel.commit.sha,
      new Set(g.marks?.not_in_target ?? []),
      new Set(g.marks?.equivalent ?? []),
    );
    return {
      sha: sel.commit.short_sha,
      repo: appState.repos[sel.repoIdx]?.displayName ?? "",
      state: commitStateText(mark, sideNames(range, pair), appState.bcSelectedDetail),
    };
  });
</script>

{#if visibleOk.length > 0}
  <div class="files-scope">
    {#if picked}
      <span class="what">
        <b>Commit {picked.sha}</b> · {picked.repo} — {picked.state}
      </span>
      <button type="button" onclick={showAllChanges}>× All changes</button>
    {:else}
      <span class="what">{allChangesText(allNames)}</span>
    {/if}
  </div>
{/if}

<style>
  .files-scope {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    font-size: 0.8em;
    white-space: nowrap;
  }
  .what {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
  }
  button {
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    padding: 1px 6px;
    font: inherit;
  }
  button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
```

- [ ] **Step 13: Lay Branch mode out in three rows**

In `src/routes/+page.svelte`:

1. Replace `import BranchContainment from "$lib/ui/BranchContainment.svelte";` with

```ts
  import CommitTable from "$lib/ui/CommitTable.svelte";
  import FilesScope from "$lib/ui/FilesScope.svelte";
```

2. Add to the script, after `onGraphPanelResize`:

```ts
  // Branch mode: drag the boundary between the commit table (top) and the file
  // list + diff below. Session-only; the table keeps a few rows and the diff at
  // least 160px.
  let branchColEl = $state<HTMLDivElement | null>(null);
  function onCommitTableResize(e: PointerEvent) {
    if (e.button !== 0 || !branchColEl) return;
    e.preventDefault();
    const rect = branchColEl.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      appState.commitTableHeight = Math.max(
        80,
        Math.min(rect.height - 160, ev.clientY - rect.top),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
```

3. Replace the final `{:else}` arm of the body (the `branch-col` div, the `picker-resizer` after it and the `{@render diffPane()}`) with:

```svelte
    {:else}
      <div
        class="branch-col"
        class:collapsed={appState.commitTableCollapsed}
        bind:this={branchColEl}
        style="--ct-h: {appState.commitTableHeight}px;"
      >
        <div class="ct-pane"><CommitTable /></div>
        {#if !appState.commitTableCollapsed}
          <div
            class="ct-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize commit table"
            onpointerdown={onCommitTableResize}
          ></div>
        {/if}
        <div class="ct-bottom">
          <div class="bc-files">
            <FilesScope />
            <div class="bc-filelist"><FileList /></div>
          </div>
          <div
            class="picker-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file list"
            onpointerdown={onResizeStart}
          ></div>
          {@render diffPane()}
        </div>
      </div>
    {/if}
```

4. In `<style>`, replace the `.branch-col`, `.bc-pane` and `.bc-files` rules (under the comment `/* Branch (compare) mode left column: … */`) with:

```css
  /* Branch (compare) mode: the commit table spans the full width on top; the
     file list and the diff share the rest below, split like the other modes. */
  .branch-col {
    grid-column: 1 / -1;
    display: grid;
    grid-template-rows: var(--ct-h, 260px) 7px minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
  }
  .branch-col.collapsed {
    grid-template-rows: auto minmax(0, 1fr);
  }
  .ct-pane {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
  }
  .ct-resizer {
    z-index: 5;
    cursor: row-resize;
    background: transparent;
    position: relative;
  }
  .ct-resizer::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 0;
    height: 1px;
    width: 100%;
    background: var(--border);
    transition: background 0.1s ease;
  }
  .ct-resizer:hover::after {
    background: var(--accent);
  }
  .ct-bottom {
    position: relative;
    display: grid;
    grid-template-columns: var(--picker-width, 300px) 1fr;
    grid-template-rows: minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
  }
  .bc-files {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .bc-filelist {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
```

- [ ] **Step 14: The Compare button, and the drill summary in the pane labels**

In `src/lib/ui/InputBar.svelte`, replace the Compare button's `onclick` body

```ts
        // "Compare" shows the aggregate start↔target diff — clear any
        // per-commit drill from the containment list first.
        appState.bcSelectedSha = null;
        appState.bcDiffRange = null;
        void compare();
```

with

```ts
        // "Compare" shows the aggregate base↔compare diff — drop a commit
        // picked in the commit table first.
        appState.bcSelected = null;
        appState.bcSelectedDetail = null;
        appState.bcDiffRange = null;
        void compare();
```

In `src/lib/ui/DiffView.svelte`, in the `labels` derived (Task 5), replace

```ts
    const drill = d && d.repoIdx === idx ? { target: d.target } : null;
```

with

```ts
    const drill =
      d && d.repoIdx === idx
        ? { target: d.target, summary: appState.bcSelected?.commit.summary }
        : null;
```

- [ ] **Step 15: Delete the old pane**

```bash
git rm src/lib/ui/BranchContainment.svelte
```

- [ ] **Step 16: Check types and tests**

Run: `npm run check`
Expected: 0 errors. (Any remaining reference to `bcCommits`, `bcSelectedSha`, `bcRefs`, `containment`, `containmentDetail`, `loadingContainment`, `bcHasMore` or `bcLoadingCommits` is a leftover to remove — search with `grep -rn "bcSelectedSha\|bcCommits\|bcRefs\|loadingContainment\|bcHasMore\|bcLoadingCommits\|appState.containment" src`.)

Run: `npm test`
Expected: PASS.

- [ ] **Step 17: Commit**

```bash
git add -A src/lib src/routes
git commit -m "feat(branch): a full-width commit table that lists unmerged commits first"
```

Body: the containment pane listed the start branch's whole history in half of a 300px column, and asked the opposite question from the diff beside it. The table now spans the width above the file list and diff, asks which of compare's commits base lacks (the diff's own direction), groups them per repo with each range named, summarizes the answer in one line, names the merge that brought a merged branch in, and can list the merged commits on request.

---

### Task 7: `squash_check` in the backend

**Files:**
- Modify: `src-tauri/src/git/mod.rs` (types after `ContainmentDetail`; trait method after `commit_containment_detail`)
- Modify: `src-tauri/src/git/cli.rs` (import list; constants after `SUBMODULE_LOG_CAP`; helpers after `parse_cherry_equivalent`; method after `commit_containment_detail` in `impl GitLayer for GitCli`; tests)
- Modify: `src-tauri/src/lib.rs` (import, command, registration)
- Modify: `src/lib/types.ts`, `src/lib/git.ts` (TS mirror + binding)

**Interfaces:**
- Produces:
  - Rust `pub enum SquashVerdict { None, NoNetChange, Squash, Content }` (serde kebab-case: `"none" | "no-net-change" | "squash" | "content"`)
  - Rust `pub struct SquashCheck { pub verdict: SquashVerdict, pub squash_commit: Option<Commit> }`
  - `GitLayer::squash_check(&self, path: &Path, source: &str, target: &str) -> Result<SquashCheck, GitError>`
  - Tauri command `squash_check(path, source, target)`
  - TS `type SquashVerdict`, `interface SquashCheck { verdict: SquashVerdict; squash_commit: Commit | null }`, `squashCheck(path: string, source: string, target: string): Promise<SquashCheck>`

- [ ] **Step 1: Add the types and the trait method**

In `src-tauri/src/git/mod.rs`, after the `ContainmentDetail` struct:

```rust
/// Whether a branch's changes already reached the base without ancestry — the
/// squash-merge case `containment` cannot see. See `GitLayer::squash_check`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SquashVerdict {
    /// Not detected: the branch's changes are not (visibly) in the base.
    None,
    /// The branch makes no net change against its merge-base with the base.
    NoNetChange,
    /// One base commit carries exactly the branch's net change.
    Squash,
    /// Merging the branch would change nothing, but no single commit matches.
    Content,
}

/// Result of `squash_check`. `squash_commit` is set for `Squash` only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SquashCheck {
    pub verdict: SquashVerdict,
    pub squash_commit: Option<Commit>,
}
```

and in `trait GitLayer`, after `commit_containment_detail`:

```rust
    /// Whether `source`'s changes since its merge-base with `target` already
    /// landed in `target` without ancestry: as one commit whose patch-id equals
    /// the branch's net change (`Squash`), or as content only — merging would
    /// change nothing (`Content`, needs git 2.38's `merge-tree --write-tree`).
    /// Read-only.
    fn squash_check(
        &self,
        path: &Path,
        source: &str,
        target: &str,
    ) -> Result<SquashCheck, GitError>;
```

- [ ] **Step 2: Write the failing tests**

In `src-tauri/src/git/cli.rs`, add `SquashCheck, SquashVerdict,` to the `use super::{…}` list (alphabetical: after `RepoStatus,`). Then add inside `mod tests`, after `current_branch`:

```rust
    /// The squash fixtures' ten-line file, with the given 1-based lines replaced.
    fn ten_lines(edits: &[(usize, &str)]) -> String {
        (1..=10)
            .map(|n| {
                let text = edits
                    .iter()
                    .find(|(at, _)| *at == n)
                    .map(|(_, t)| t.to_string())
                    .unwrap_or(format!("l{n}"));
                format!("{text}\n")
            })
            .collect()
    }

    /// `base` holding the ten-line file, and `feat` off it changing lines 5 and
    /// 6 in two commits — the branch every squash test merges. Leaves `base`
    /// checked out.
    fn squash_fixture(name: &str) -> PathBuf {
        let repo = temp_repo(name);
        git_in(&repo, &["config", "core.autocrlf", "false"]);
        git_in(&repo, &["checkout", "-q", "-b", "base"]);
        commit_file(&repo, "f.txt", &ten_lines(&[]), "ten lines");
        git_in(&repo, &["checkout", "-q", "-b", "feat"]);
        commit_file(&repo, "f.txt", &ten_lines(&[(5, "L5")]), "a");
        commit_file(&repo, "f.txt", &ten_lines(&[(5, "L5"), (6, "L6")]), "b");
        git_in(&repo, &["checkout", "-q", "base"]);
        repo
    }

    /// Squash-merge `feat` into the checked-out branch as one commit.
    fn squash_merge(repo: &Path) {
        git_in(repo, &["merge", "--squash", "-q", "feat"]);
        git_in(repo, &["commit", "-qm", "squash feat (#1)"]);
    }

    #[test]
    fn squash_check_names_the_squash_commit() {
        let repo = squash_fixture("squash-plain");
        squash_merge(&repo);
        let squash = rev_parse(&repo, "base");
        let r = GitCli::new().squash_check(&repo, "feat", "base").unwrap();
        assert_eq!(r.verdict, SquashVerdict::Squash);
        assert_eq!(r.squash_commit.map(|c| c.sha), Some(squash));
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn squash_check_finds_the_squash_after_base_edits_the_same_line() {
        // The patch-id half: merge-tree conflicts here, but S's own patch is
        // fixed in history.
        let repo = squash_fixture("squash-later-edit");
        squash_merge(&repo);
        let squash = rev_parse(&repo, "base");
        commit_file(&repo, "f.txt", &ten_lines(&[(5, "X5"), (6, "L6")]), "later");
        let r = GitCli::new().squash_check(&repo, "feat", "base").unwrap();
        assert_eq!(r.verdict, SquashVerdict::Squash);
        assert_eq!(r.squash_commit.map(|c| c.sha), Some(squash));
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn squash_check_falls_back_to_content_after_a_context_edit() {
        // The merge-tree half: base changed line 2 — inside the hunk's context,
        // not adjacent, so the squash still merges cleanly — before the squash.
        // S's patch-id then differs from the branch's, but merging the branch
        // would change nothing.
        let repo = squash_fixture("squash-context");
        commit_file(&repo, "f.txt", &ten_lines(&[(2, "M2")]), "context");
        squash_merge(&repo);
        let r = GitCli::new().squash_check(&repo, "feat", "base").unwrap();
        assert_eq!(r.verdict, SquashVerdict::Content);
        assert!(r.squash_commit.is_none());
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn squash_check_reports_no_net_change_once_base_is_merged_back() {
        let repo = squash_fixture("squash-merged-back");
        squash_merge(&repo);
        git_in(&repo, &["checkout", "-q", "feat"]);
        git_in(&repo, &["merge", "-q", "--no-edit", "base"]);
        git_in(&repo, &["checkout", "-q", "base"]);
        let r = GitCli::new().squash_check(&repo, "feat", "base").unwrap();
        assert_eq!(r.verdict, SquashVerdict::NoNetChange);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn squash_check_misses_a_branch_that_kept_going() {
        // Pins the documented limit: the net change is S plus new work.
        let repo = squash_fixture("squash-kept-going");
        squash_merge(&repo);
        git_in(&repo, &["checkout", "-q", "feat"]);
        commit_file(&repo, "f.txt", &ten_lines(&[(5, "L5"), (6, "L6"), (8, "L8")]), "c");
        git_in(&repo, &["checkout", "-q", "base"]);
        let r = GitCli::new().squash_check(&repo, "feat", "base").unwrap();
        assert_eq!(r.verdict, SquashVerdict::None);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn squash_check_ignores_an_unmerged_branch() {
        let repo = squash_fixture("squash-unmerged");
        commit_file(&repo, "f.txt", &ten_lines(&[(10, "M10")]), "other");
        let r = GitCli::new().squash_check(&repo, "feat", "base").unwrap();
        assert_eq!(r.verdict, SquashVerdict::None);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn squash_check_stops_when_base_has_nothing_since_the_fork() {
        let repo = squash_fixture("squash-ahead");
        let r = GitCli::new().squash_check(&repo, "feat", "base").unwrap();
        assert_eq!(r.verdict, SquashVerdict::None);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn squash_check_scans_without_pathspecs_for_a_wide_branch() {
        // Review focus: more changed paths than fit on one command line. The
        // scan drops the path filter and still finds the squash among the
        // newest base commits.
        let repo = squash_fixture("squash-wide");
        git_in(&repo, &["checkout", "-q", "feat"]);
        for i in 0..(SQUASH_MAX_PATHSPECS + 5) {
            fs::write(repo.join(format!("w{i}.txt")), format!("{i}\n")).unwrap();
        }
        git_in(&repo, &["add", "-A"]);
        git_in(&repo, &["commit", "-qm", "wide"]);
        git_in(&repo, &["checkout", "-q", "base"]);
        squash_merge(&repo);
        let squash = rev_parse(&repo, "base");
        let r = GitCli::new().squash_check(&repo, "feat", "base").unwrap();
        assert_eq!(r.verdict, SquashVerdict::Squash);
        assert_eq!(r.squash_commit.map(|c| c.sha), Some(squash));
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn parse_patch_ids_reads_pairs_in_order() {
        assert_eq!(
            parse_patch_ids("aaa 111\nbbb 222\n\n"),
            vec![
                ("aaa".to_string(), "111".to_string()),
                ("bbb".to_string(), "222".to_string())
            ]
        );
        assert!(parse_patch_ids("").is_empty());
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml squash`
Expected: FAIL to compile — `no method named squash_check`, `cannot find function parse_patch_ids`, `cannot find value SQUASH_MAX_PATHSPECS`.

- [ ] **Step 4: Implement**

In `src-tauri/src/git/cli.rs`:

1. After the `SUBMODULE_LOG_CAP` constant:

```rust
/// Above this many changed paths, `squash_check` stops passing them as
/// pathspecs — a Windows command line holds at most 32K characters — and scans
/// the newest `SQUASH_SCAN_CAP` base commits since the fork instead.
const SQUASH_MAX_PATHSPECS: usize = 200;
const SQUASH_SCAN_CAP: &str = "300";
```

2. After `parse_cherry_equivalent`:

```rust
/// Run `git patch-id --stable` over `patches` — a bare diff, or `log -p` output
/// whose commits start with `commit <sha>` lines — and return the
/// (patch-id, commit) pairs in input order. A bare diff pairs with the all-zero
/// commit id.
fn patch_ids(path: &Path, patches: &[u8]) -> Result<Vec<(String, String)>, GitError> {
    let mut child = git_command()
        .arg("-C")
        .arg(path)
        .args(["patch-id", "--stable"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let input = patches.to_vec();
    // patch-id prints as it reads: feed it from a thread so a full stdout pipe
    // can never stall the write.
    let feeder = std::thread::spawn(move || stdin.write_all(&input));
    let out = child.wait_with_output()?;
    let _ = feeder.join();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(GitError::CommandFailed(stderr));
    }
    Ok(parse_patch_ids(&String::from_utf8_lossy(&out.stdout)))
}

/// Parse `git patch-id` output: one `<patch-id> <commit>` pair per line.
fn parse_patch_ids(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?.to_string(), parts.next()?.to_string()))
        })
        .collect()
}
```

3. In `impl GitLayer for GitCli`, after `commit_containment_detail`:

```rust
    fn squash_check(
        &self,
        path: &Path,
        source: &str,
        target: &str,
    ) -> Result<SquashCheck, GitError> {
        let source = validate_ref(source)?;
        let target = validate_ref(target)?;
        let verdict = |v: SquashVerdict| SquashCheck {
            verdict: v,
            squash_commit: None,
        };

        // Unrelated histories have no merge-base and nothing to compare.
        let mb = match self.run(path, &["merge-base", target, source]) {
            Ok(out) => String::from_utf8_lossy(&out).trim().to_string(),
            Err(_) => return Ok(verdict(SquashVerdict::None)),
        };

        // No net change since the fork — e.g. the base merged back in after a
        // squash. `diff --quiet` exits 1 when the trees differ.
        let quiet = git_command()
            .arg("-C")
            .arg(path)
            .args(["diff", "--quiet", "--no-ext-diff", "--no-textconv", &mb, source])
            .output()?;
        match quiet.status.code() {
            Some(0) => return Ok(verdict(SquashVerdict::NoNetChange)),
            Some(1) => {}
            _ => {
                let stderr = String::from_utf8_lossy(&quiet.stderr).trim().to_string();
                return Err(GitError::CommandFailed(stderr));
            }
        }

        // The base has nothing since the fork, so it cannot hold a squash —
        // the common "branch is simply ahead" case.
        let target_sha = self.run(
            path,
            &["rev-parse", "--verify", &format!("{target}^{{commit}}")],
        )?;
        if mb == String::from_utf8_lossy(&target_sha).trim() {
            return Ok(verdict(SquashVerdict::None));
        }

        // Candidates: non-merge base commits since the fork that touch the
        // branch's paths, or the newest few hundred when the paths would not
        // fit on one command line. Renames are off on every diff here so both
        // sides describe a rename the same way (delete + add).
        let names = self.run(
            path,
            &["diff", "--name-only", "-z", "--no-renames", &mb, source],
        )?;
        let paths: Vec<String> = names
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect();
        let range = format!("{mb}..{target}");
        let mut log: Vec<&str> = vec![
            "--literal-pathspecs",
            "log",
            "--no-merges",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "-p",
            "--binary",
            "--format=commit %H",
            &range,
        ];
        if paths.len() > SQUASH_MAX_PATHSPECS {
            log.extend(["-n", SQUASH_SCAN_CAP]);
        } else {
            log.push("--");
            log.extend(paths.iter().map(String::as_str));
        }
        let candidates = self.run(path, &log)?;
        if candidates.is_empty() {
            return Ok(verdict(SquashVerdict::None));
        }

        // A base commit whose patch is exactly the branch's net change.
        let net = self.run(
            path,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--binary",
                &mb,
                source,
            ],
        )?;
        if let Some((want, _)) = patch_ids(path, &net)?.into_iter().next() {
            // `git log` lists newest first; the oldest match is where it landed.
            let found = patch_ids(path, &candidates)?
                .into_iter()
                .filter(|(id, _)| *id == want)
                .last();
            if let Some((_, sha)) = found {
                let one = self.run(path, &["log", "-1", "-z", COMMIT_LOG_FORMAT, &sha])?;
                let squash_commit = parse_commit_log(&String::from_utf8_lossy(&one))
                    .into_iter()
                    .next();
                return Ok(SquashCheck {
                    verdict: SquashVerdict::Squash,
                    squash_commit,
                });
            }
        }

        // Content check (git 2.38+): merging would change nothing. A conflict
        // exits non-zero, and so does an older git without --write-tree — both
        // read as "not detected".
        let merged = git_command()
            .arg("-C")
            .arg(path)
            .args(["merge-tree", "--write-tree", target, source])
            .output()?;
        if merged.status.success() {
            let tree = String::from_utf8_lossy(&merged.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            let target_tree = self.run(path, &["rev-parse", &format!("{target}^{{tree}}")])?;
            if !tree.is_empty() && tree == String::from_utf8_lossy(&target_tree).trim() {
                return Ok(verdict(SquashVerdict::Content));
            }
        }
        Ok(verdict(SquashVerdict::None))
    }
```

4. In `src-tauri/src/lib.rs`: add `SquashCheck` to the `use git::{…}` list (after `RepoStatus,`); add the command after `commit_containment_detail`:

```rust
#[tauri::command]
async fn squash_check(
    state: tauri::State<'_, GitCli>,
    path: String,
    source: String,
    target: String,
) -> Result<SquashCheck, GitError> {
    state.squash_check(Path::new(&path), &source, &target)
}
```

and register it in `generate_handler![…]` after `commit_containment_detail,`:

```rust
            squash_check,
```

- [ ] **Step 5: Run the Rust tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml squash`
Expected: PASS (8 `squash_check_*` tests).

Run: `cargo test --manifest-path src-tauri/Cargo.toml parse_patch_ids`
Expected: PASS.

- [ ] **Step 6: The TypeScript mirror and binding**

Append to `src/lib/types.ts`:

```ts
/// Mirrors Rust `SquashVerdict` (serde kebab-case).
export type SquashVerdict = "none" | "no-net-change" | "squash" | "content";

/// Mirrors Rust `SquashCheck`: whether a branch's changes reached the base
/// without ancestry. `squash_commit` is set for `squash` only.
export interface SquashCheck {
  verdict: SquashVerdict;
  squash_commit: Commit | null;
}
```

In `src/lib/git.ts`, add `SquashCheck,` to the type import list and, after `commitContainmentDetail`:

```ts
/**
 * Whether `source`'s changes already reached `target` without ancestry: one
 * squash commit (`squash`, named) or content only (`content`). Read-only.
 */
export function squashCheck(
  path: string,
  source: string,
  target: string,
): Promise<SquashCheck> {
  return share(`squash_check|${path}|${source}|${target}`, () =>
    invoke("squash_check", { path, source, target }),
  );
}
```

- [ ] **Step 7: Check the frontend still builds**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/git/mod.rs src-tauri/src/git/cli.rs src-tauri/src/lib.rs src/lib/types.ts src/lib/git.ts
git commit -m "feat(git): tell when a branch landed as a squash merge"
```

Body: containment only sees ancestry and per-commit patches, so a squash-merged branch reads as never merged. squash_check matches the branch's net change against base commits by patch-id (naming the squash, and surviving later edits of the same lines) and falls back to a merge-tree content check (surviving context edits made before the squash). Read-only, and the merge-tree step simply reads as "not detected" on git older than 2.38.

---

### Task 8: Squash detection in the commit table

**Files:**
- Modify: `src/lib/types.ts` (`BcGroup.squash`)
- Modify: `src/lib/branchContainment.ts`
- Modify: `src/lib/commitTableText.ts`
- Modify: `src/lib/ui/CommitTable.svelte`, `src/lib/ui/FilesScope.svelte`
- Test: `src/lib/branchContainment.test.ts`, `src/lib/commitTableText.test.ts` (extend)

**Interfaces:**
- Consumes: `squashCheck` binding and `SquashCheck` type (Task 7); everything Task 6 produces.
- Produces:
  - `BcGroup.squash: SquashCheck | "checking" | null`
  - `squashLanded(g: BcGroup): SquashCheck | null`
  - `rowMark(sha, notIn, equiv, squashed = false): RowMark` where `RowMark` gains `"squash"`
  - `Summary` gains `{ kind: "squash"; names; commit: Commit }`, `{ kind: "content"; names }`, `{ kind: "no-net-change"; names }`
  - `GroupNotes` gains `landed?: SquashCheck | null; checking?: boolean`
  - `statusText(mark, names, landed?)`, `commitStateText(mark, names, detail, landed?)`, `allChangesText(names, landed?)`

- [ ] **Step 1: Add the group field**

In `src/lib/types.ts`, add to `BcGroup` after `mergedBy`:

```ts
  /// Squash detection for a group that still has ● rows: "checking" while
  /// squash_check runs, its answer once back, null when not run or failed.
  squash: SquashCheck | "checking" | null;
```

(`SquashCheck` is declared later in the same file; TypeScript allows the forward reference.)

- [ ] **Step 2: Write the failing tests**

In `src/lib/commitTableText.test.ts`, change the type import at the top to `import type { Commit, SquashCheck } from "./types";`, then append:

```ts
const squashed: SquashCheck = {
  verdict: "squash",
  squash_commit: { ...merge, sha: "7f3a2c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", short_sha: "7f3a2c1", parents: ["x"], summary: "Add MCP import (#1677)" },
};
const content: SquashCheck = { verdict: "content", squash_commit: null };

describe("squash wording", () => {
  it("summarizes a squash, a content match and no net change", () => {
    expect(summaryText({ kind: "squash", names, commit: squashed.squash_commit! })).toMatch(
      /^✓ All changes on feature\/x are in main — squash-merged as 7f3a2c1 "Add MCP import \(#1677\)" · /,
    );
    expect(summaryText({ kind: "content", names })).toBe(
      "✓ All changes on feature/x are already in main (content matches; no single squash commit found)",
    );
    expect(summaryText({ kind: "no-net-change", names })).toBe(
      "feature/x makes no net change against main",
    );
  });

  it("marks a squashed group's header", () => {
    expect(groupCountsText({ out: 0, patch: 3, behind: 0 }, names, { mergedBy: undefined, landed: squashed })).toBe(
      "◐ 3 · squash-merged as 7f3a2c1",
    );
    expect(groupCountsText({ out: 0, patch: 3, behind: 0 }, names, { mergedBy: undefined, landed: content })).toBe(
      "◐ 3 · content already in main",
    );
    expect(groupCountsText({ out: 5, patch: 0, behind: 0 }, names, { mergedBy: undefined, checking: true })).toBe(
      "● 5 · checking for squash…",
    );
  });

  it("names how a squashed row and a picked squashed commit got in", () => {
    expect(statusText("squash", names, squashed)).toBe("squashed into 7f3a2c1");
    expect(statusText("squash", names, content)).toBe("changes already in main");
    expect(commitStateText("squash", names, null, squashed)).toMatch(/^squashed into main as 7f3a2c1 \(/);
    expect(commitStateText("squash", names, null, content)).toBe("its changes are already in main");
  });

  it("says all changes already landed", () => {
    expect(allChangesText(names, squashed)).toBe(
      "All changes · main ← feature/x — already in main (squash-merged as 7f3a2c1)",
    );
    expect(allChangesText(names, content)).toBe("All changes · main ← feature/x — already in main");
  });
});
```

Append to `src/lib/branchContainment.test.ts`:

1. Add `squashCheck: vi.fn(),` to the `vi.mock("./git", …)` factory, `squashCheck` to the `./git` import, `squashLanded` to the `./branchContainment` import, and `squashCheck` to the `beforeEach` reset list.
2. Add `squash: null,` to the `group()` helper's defaults.
3. Add:

```ts
describe("squash detection", () => {
  const sq = (verdict: "none" | "no-net-change" | "squash" | "content") => ({
    verdict,
    squash_commit: verdict === "squash" ? commit("s1") : null,
  });

  it("asks only for groups that still have unmerged commits", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([
      range("/main", "main", "feature"),
      range("/main/sub", "aaa", "bbb"),
    ]);
    vi.mocked(containment).mockImplementation((path) =>
      Promise.resolve(path === "/main" ? marks({ ahead: 0 }) : marks({ not_in_target: ["c1"], ahead: 1 })),
    );
    vi.mocked(commitContainmentDetail).mockResolvedValue({ in_target: true, introduced_by: null });
    vi.mocked(commitLogExcluding).mockResolvedValue([]);
    vi.mocked(squashCheck).mockResolvedValue(sq("squash"));
    await loadBranchContainment();
    expect(squashCheck).toHaveBeenCalledTimes(1);
    expect(squashCheck).toHaveBeenCalledWith("/main/sub", "bbb", "aaa");
    expect(appState.bcGroups[1].squash).toEqual(sq("squash"));
    expect(appState.bcGroups[0].squash).toBeNull();
  });

  it("counts squashed commits as in base", () => {
    const g = group({ marks: marks({ ahead: 3, equivalent: ["e"] }), squash: sq("squash") });
    expect(squashLanded(g)?.verdict).toBe("squash");
    expect(groupCounts(g)).toEqual({ out: 0, patch: 3, behind: 0 });
    expect(rowMark("x", new Set(["x"]), new Set(), true)).toBe("squash");
    expect(rowMark("x", new Set(["x"]), new Set(), false)).toBe("out");
    expect(squashLanded(group({ squash: sq("no-net-change") }))).toBeNull();
    expect(squashLanded(group({ squash: "checking" }))).toBeNull();
  });

  it("summarizes a squash, a content match and no net change", () => {
    const pair = { base: "main", compare: "feature" };
    const one = (g: BcGroup) => summarize([{ idx: 0, group: g, names }], pair);
    expect(one(group({ marks: marks({ ahead: 2 }), squash: sq("squash") }))).toEqual({
      kind: "squash",
      names,
      commit: commit("s1"),
    });
    expect(one(group({ marks: marks({ ahead: 2 }), squash: sq("content") }))).toEqual({ kind: "content", names });
    expect(one(group({ marks: marks({ ahead: 2 }), squash: sq("no-net-change") }))).toEqual({
      kind: "no-net-change",
      names,
    });
  });

  it("leaves the rows alone when the check fails", async () => {
    vi.mocked(resolveRepoRanges).mockResolvedValue([range("/main", "main", "feature")]);
    vi.mocked(containment).mockResolvedValue(marks({ not_in_target: ["c1"], ahead: 1 }));
    vi.mocked(commitLogExcluding).mockResolvedValue([commit("c1")]);
    vi.mocked(squashCheck).mockRejectedValue("no git");
    await loadBranchContainment();
    expect(appState.bcGroups[0].squash).toBeNull();
    expect(groupCounts(appState.bcGroups[0])).toEqual({ out: 1, patch: 0, behind: 0 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/branchContainment.test.ts src/lib/commitTableText.test.ts`
Expected: FAIL — `squashLanded` is not exported; `rowMark` ignores its fourth argument; the text functions lack the squash forms.

- [ ] **Step 4: Squash in the data layer**

In `src/lib/branchContainment.ts`:

1. Add `squashCheck` to the `./git` import and `SquashCheck` to the `./types` type import.
2. In `emptyGroup`, add `squash: null,` after `mergedBy: undefined,`.
3. Add after `isRepoVisible`:

```ts
/// The group's squash answer when it puts the ● commits in base.
export function squashLanded(g: BcGroup): SquashCheck | null {
  const sq = g.squash;
  return sq && sq !== "checking" && (sq.verdict === "squash" || sq.verdict === "content")
    ? sq
    : null;
}
```

4. Replace `groupCounts` with:

```ts
/// ● (not in base), ◐ (in base as a patch, or by a squash) and behind counts.
export function groupCounts(g: BcGroup): Counts {
  if (!g.marks) return { out: 0, patch: 0, behind: 0 };
  const patch = g.marks.equivalent.length;
  const out = Math.max(0, g.marks.ahead - patch);
  // A detected squash puts the ● commits in base too, by content.
  if (squashLanded(g)) return { out: 0, patch: patch + out, behind: g.marks.behind };
  return { out, patch, behind: g.marks.behind };
}
```

5. Replace `rowMark` with (the new parameter defaults to `false`, so Task 6's three-argument calls and tests stay valid):

```ts
/// A row's mark from its group's ● and ◐ sets; `squashed` when the group's
/// squash check put its ● commits in base.
export function rowMark(
  sha: string,
  notIn: Set<string>,
  equiv: Set<string>,
  squashed = false,
): RowMark {
  if (equiv.has(sha)) return "patch";
  if (notIn.has(sha)) return squashed ? "squash" : "out";
  return "in";
}
```

6. In `summarize`, replace the single-group branch (`if (groups.length === 1) { … }`) with:

```ts
  if (groups.length === 1) {
    const { group: g, names } = groups[0];
    const landed = squashLanded(g);
    if (landed) {
      return landed.verdict === "squash" && landed.squash_commit
        ? { kind: "squash", names, commit: landed.squash_commit }
        : { kind: "content", names };
    }
    if (g.squash && g.squash !== "checking" && g.squash.verdict === "no-net-change") {
      return { kind: "no-net-change", names };
    }
    const c = groupCounts(g);
    if (c.out > 0) {
      return { kind: "unmerged", names, out: c.out, patch: c.patch, behind: c.behind, repos: 1 };
    }
    if (c.patch > 0) return { kind: "patches", names, patch: c.patch };
    return { kind: "merged", names, mergedBy: g.mergedBy ?? null };
  }
```

7. In `loadGroup`, after the `patchGroup(idx, { status: "ready", … })` call, add:

```ts
    if (groupCounts(appState.bcGroups[idx]).out > 0) await checkSquash(idx, s);
```

8. Add after `loadGroup`:

```ts
/// Ask whether a group's unmerged commits landed as a squash. The group is
/// already on screen; only its marks and wording change when the answer comes.
async function checkSquash(idx: number, s: number): Promise<void> {
  const g = appState.bcGroups[idx];
  if (!g) return;
  patchGroup(idx, { squash: "checking" });
  try {
    const result = await squashCheck(g.path, g.compare, g.base);
    if (s === bcSession) patchGroup(idx, { squash: result });
  } catch {
    if (s === bcSession) patchGroup(idx, { squash: null });
  }
}
```

- [ ] **Step 5: Squash in the wording**

In `src/lib/commitTableText.ts`:

1. Change the type import to `import type { Commit, ContainmentDetail, SquashCheck } from "./types";`.
2. `export type RowMark = "out" | "patch" | "squash" | "in";` (update its comment: `◐ also for a commit a squash put in base`).
3. Extend `GroupNotes`:

```ts
export interface GroupNotes {
  mergedBy: Commit | null | undefined;
  /// The group's squash answer when it put the ● commits in base.
  landed?: SquashCheck | null;
  /// squash_check is still running.
  checking?: boolean;
}
```

4. Add to the `Summary` union:

```ts
  | { kind: "squash"; names: SideNames; commit: Commit }
  | { kind: "content"; names: SideNames }
  | { kind: "no-net-change"; names: SideNames }
```

5. Add these cases to `summaryText`'s switch:

```ts
    case "squash":
      return `✓ All changes on ${s.names.compare} are in ${s.names.base} — squash-merged as ${s.commit.short_sha} "${s.commit.summary}" · ${shortDate(s.commit.time)}`;
    case "content":
      return `✓ All changes on ${s.names.compare} are already in ${s.names.base} (content matches; no single squash commit found)`;
    case "no-net-change":
      return `${s.names.compare} makes no net change against ${s.names.base}`;
```

6. Replace `groupCountsText` with:

```ts
/// The counts on a group header.
export function groupCountsText(c: Counts, names: SideNames, n: GroupNotes): string {
  let text: string;
  if (n.landed) {
    text =
      n.landed.verdict === "squash" && n.landed.squash_commit
        ? `◐ ${c.patch} · squash-merged as ${n.landed.squash_commit.short_sha}`
        : `◐ ${c.patch} · content already in ${names.base}`;
  } else if (c.out === 0 && c.patch === 0) {
    text = n.mergedBy
      ? `✓ all in ${names.base} · merged by ${n.mergedBy.short_sha}`
      : `✓ all in ${names.base}`;
  } else {
    const parts: string[] = [];
    if (c.out > 0) parts.push(`● ${c.out}`);
    if (c.patch > 0) parts.push(`◐ ${c.patch}`);
    text = parts.join(" ");
    if (c.behind > 0) text += ` · ${names.compare} is ${c.behind} behind`;
  }
  return n.checking ? `${text} · checking for squash…` : text;
}
```

7. Replace `statusText`, `commitStateText` and `allChangesText` with:

```ts
/// A row's status column. `landed` is the group's squash answer.
export function statusText(
  mark: RowMark,
  names: SideNames,
  landed: SquashCheck | null = null,
): string {
  switch (mark) {
    case "out":
      return `not in ${names.base}`;
    case "patch":
      return "applied as patch";
    case "squash":
      return landed?.squash_commit
        ? `squashed into ${landed.squash_commit.short_sha}`
        : `changes already in ${names.base}`;
    case "in":
      return `in ${names.base}`;
  }
}

/// The Files header's account of the picked commit.
export function commitStateText(
  mark: RowMark,
  names: SideNames,
  detail: ContainmentDetail | null,
  landed: SquashCheck | null = null,
): string {
  switch (mark) {
    case "out":
      return `not in ${names.base}`;
    case "patch":
      return `applied to ${names.base} as a patch`;
    case "squash": {
      const s = landed?.squash_commit;
      return s
        ? `squashed into ${names.base} as ${s.short_sha} (${shortDate(s.time)})`
        : `its changes are already in ${names.base}`;
    }
    case "in": {
      const m = detail?.introduced_by;
      return m
        ? `merged by ${m.short_sha} (${shortDate(m.time)})`
        : `in ${names.base}`;
    }
  }
}

/// The Files header while nothing is picked; says so when a squash (or a
/// content match) already put every change in base.
export function allChangesText(
  names: SideNames,
  landed: SquashCheck | null = null,
): string {
  const line = `All changes · ${names.base} ← ${names.compare}`;
  if (!landed) return line;
  return landed.squash_commit
    ? `${line} — already in ${names.base} (squash-merged as ${landed.squash_commit.short_sha})`
    : `${line} — already in ${names.base}`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/branchContainment.test.ts src/lib/commitTableText.test.ts`
Expected: PASS.

- [ ] **Step 7: Squash in the components**

In `src/lib/ui/CommitTable.svelte`:

1. Add `squashLanded` to the `$lib/branchContainment` import.
2. Replace `markOf` and `glyph` with:

```ts
  function markOf(idx: number, sha: string): RowMark {
    const s = sets.get(idx);
    const g = appState.bcGroups[idx];
    return s ? rowMark(sha, s.notIn, s.equiv, !!g && !!squashLanded(g)) : "in";
  }
  const glyph: Record<RowMark, string> = { out: "●", patch: "◐", squash: "◐", in: "✓" };
```

3. Replace the group-counts expression

```svelte
                  {groupCountsText(groupCounts(g), sideNames(range, pair), { mergedBy: g.mergedBy })}
```

with

```svelte
                  {groupCountsText(groupCounts(g), sideNames(range, pair), {
                    mergedBy: g.mergedBy,
                    landed: squashLanded(g),
                    checking: g.squash === "checking",
                  })}
```

4. Replace the row's status span with

```svelte
                <span class="status {mark}">{statusText(mark, names, squashLanded(g))}</span>
```

5. Add to `<style>` after the `.mark.patch, .status.patch` rule:

```css
  .mark.squash,
  .status.squash {
    color: var(--accent);
  }
```

In `src/lib/ui/FilesScope.svelte`:

1. Add `squashLanded` to the `$lib/branchContainment` import.
2. Add after `allNames`:

```ts
  // One visible group whose squash check put everything in base: say so on the
  // all-changes line, since the three-dot diff still lists every change.
  const allLanded = $derived.by(() => {
    const idx = appState.repoRanges.findIndex((r, i) => r.ok && isRepoVisible(i));
    const g = visibleOk.length === 1 && idx >= 0 ? appState.bcGroups[idx] : undefined;
    return g ? squashLanded(g) : null;
  });
```

3. In `picked`, replace the `rowMark(…)` call and the `state:` line with:

```ts
    const landed = squashLanded(g);
    const mark = rowMark(
      sel.commit.sha,
      new Set(g.marks?.not_in_target ?? []),
      new Set(g.marks?.equivalent ?? []),
      !!landed,
    );
```

```ts
      state: commitStateText(mark, sideNames(range, pair), appState.bcSelectedDetail, landed),
```

4. Replace `{allChangesText(allNames)}` with `{allChangesText(allNames, allLanded)}`.

- [ ] **Step 8: Check types and tests**

Run: `npm run check`
Expected: 0 errors.

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/branchContainment.ts src/lib/commitTableText.ts src/lib/ui/CommitTable.svelte src/lib/ui/FilesScope.svelte src/lib/branchContainment.test.ts src/lib/commitTableText.test.ts
git commit -m "feat(branch): show squash-merged commits as landed"
```

Body: sbx-idl merges every PR by squash, so the commit table reported merged branches as never merged. Groups that still have unmerged commits now ask squash_check in the background; a squash or a content match turns those rows into ◐ with how they landed, and the summary, the group header and the Files line say so.

---

### Task 9: Docs, and the manual check

**Files:**
- Modify: `README.md` (Branch-mode passages, multi-root table, Tabs bullet, git requirement)
- Modify: `CHANGELOG.md` (new top section)

- [ ] **Step 1: Update the README**

In `README.md`:

1. In `#### 멀티 루트에서의 비교 의미`, replace the table's header row and first two body rows' Branch-mode cells so the table reads:

```markdown
| Repo 종류 | Branch 모드 | Working Copy 모드 |
|---|---|---|
| **main** | 툴바의 base ← compare 그대로 | `git diff HEAD` |
| **submodule** | main의 base / compare가 고정한 gitlink SHA 두 개를 비교 (GitHub PR과 동일 의미). 그룹 헤더에 `pinned by <main>: <sha> ← <sha>` 로 표시 | submodule 자체의 `git diff HEAD` |
| **manual** | main과 같은 이름의 branch를 자동 매칭 (`same names: …`). 없으면 그 그룹에 오류 표시 | 해당 repo의 `git diff HEAD` |
```

2. In `#### Tabs 레이아웃`, replace the bullet

```markdown
- 탭마다 **refs는 독립** (§13 `override` 활용) — submodule 탭이 active일 때 상단 BranchPicker는 그 repo의 override를 편집합니다.
```

with

```markdown
- 툴바의 base / compare는 **항상 main의 쌍**입니다. submodule·manual 탭이 active면 툴바 아래 **scope 줄**이 그 repo가 무엇을 따라가는지 보여주고, **Compare own branches…** 로 그 repo만의 base / compare를 고를 수 있습니다.
```

3. Replace the `### 사용 흐름` list under `## 2. Branch 모드 — 두 ref 비교` with:

```markdown
### 사용 흐름
1. 좌측 모드 토글에서 **Branch** 선택.
2. **base** (기준, 머지될 쪽 — diff 왼쪽) 와 **compare** (리뷰할 브랜치 — diff 오른쪽) 선택. 브랜치명/태그/커밋 해시 모두 가능. `base ← compare` 는 "compare가 base로 들어간다"는 뜻입니다.
3. **since fork (...)** vs **direct (..)** 선택:
    - `since fork`: GitHub PR과 동일. `merge-base(base, compare)` 부터 `compare` 까지의 변경 (= compare가 갈라진 뒤 바꾼 것).
    - `direct`: `base..compare` 직접 diff.
4. **`ws`** 체크박스로 공백 무시(`-w`) 토글.
5. **Compare** 클릭.

툴바의 두 피커는 항상 **super(main) repo의 쌍**입니다. 멀티 루트에서 한 repo에 Focus해도 피커의 의미는 바뀌지 않고, 툴바 아래 scope 줄에 그 repo의 범위가 표시됩니다.

### 커밋 표 (상단)
- **compare에만 있는 커밋**을 repo별로 묶어 보여줍니다: ● base에 없음 · ◐ 다른 방식으로 들어감 (rebase / cherry-pick / squash) · ✓ 이미 들어감(**Show merged commits** 켰을 때).
- 맨 위 요약 줄이 답을 한 문장으로 말합니다 (예: `main ← feature/x: ● 8 not merged · ◐ 1 applied as patch`). 전부 들어갔으면 **어떤 머지로 들어왔는지**를 보여줍니다.
- **squash merge 감지**: squash로 합친 브랜치의 커밋도 `squashed into <sha>` 로 표시합니다. 내용 비교(`merge-tree --write-tree`)는 **git 2.38 이상**에서 동작하고, 그보다 낮으면 patch-id 일치만 찾습니다.
- 커밋을 클릭하면 아래 파일 목록과 diff가 그 커밋(`parent..commit`)만 보여주고, 파일 목록 위 줄에 그 커밋이 base에 들어갔는지가 나옵니다. 같은 행을 다시 누르거나 **× All changes** 로 전체 변경으로 돌아갑니다.
- 경계선을 드래그해 높이 조절, `▴` 로 요약 줄만 남기고 접기.
```

4. Under `### 우측 Diff 패널`, add as the first bullet:

```markdown
- 헤더에 파일이 속한 **repo와 비교 범위**, 창 위에 **각 창이 무엇인지**(`base · main (merge-base)` / `compare · feature/x`) 표시.
```

- [ ] **Step 2: Add the changelog section**

Insert at the top of `CHANGELOG.md`, directly above `## v2.1.2`:

```markdown
## v2.2.0

**Branch 모드가 "어느 repo의, 어느 두 ref를, 어느 방향으로" 비교하는지 화면에서 바로 읽히게** 바꿨습니다.

### ✨ 하이라이트

- **base ← compare 한 가지 의미** — 툴바 피커가 `base`(기준, diff 왼쪽)와 `compare`(리뷰할 브랜치, diff 오른쪽)로 바뀌었습니다. 예전에는 파일 diff와 커밋 포함 여부 패널이 **같은 두 피커를 반대 역할로** 읽어서, 한쪽을 맞추면 다른 쪽이 거꾸로 나왔습니다. 이제 두 패널 모두 "compare가 base에 대해 무엇을 바꿨나 / compare의 커밋이 base에 들어갔나"를 묻습니다.
- **툴바는 항상 super repo** — submodule에 Focus해도 툴바 피커의 의미가 바뀌지 않습니다. Focus한 repo는 툴바 아래 **scope 줄**에 무엇을 따라가는지(`following sandbox: main pins 5e1c0aa ← feature/x pins b93f7d2`) 표시되고, **Compare own branches…** 로 그 repo만의 쌍을 고릅니다.
- **범위와 출처를 모든 곳에** — 그룹 헤더마다 비교 범위(`pinned by sandbox: …`, `own branches: …`, `same names: …`)나 비교할 수 없는 이유(`unchanged: both pin …`)를, diff 헤더에 repo와 범위를, diff 창 위에 각 창이 무엇인지를 표시합니다.
- **전폭 커밋 표** — 좁은 좌측 칸 대신 파일 목록·diff 위에 넓게 펼쳐집니다. **아직 안 들어간 커밋부터** repo별로 보여주고, 한 줄 요약으로 답합니다. 전부 들어갔으면 들어온 머지를, **Show merged commits** 로 그 머지가 들고 온 커밋들을 보여줍니다. 높이 조절·접기가 됩니다.
- **squash merge 감지** — squash로 합친 브랜치는 예전엔 영원히 "안 들어감"으로 보였습니다. 이제 `squash-merged as <sha>` 로 표시합니다(내용 비교는 git 2.38 이상).

### 🐛 수정

- **submodule 커밋을 누르면 파일 목록이 비던 문제** — Focus가 submodule일 때 커밋 포함 여부 패널에서 커밋을 클릭하면 아무 파일도 나오지 않았습니다.
- **패널마다 다른 범위를 보던 문제** — 비교 범위 계산이 세 군데에 복제돼 어긋나 있었습니다(수동 추가 repo는 포함 여부 패널이 비었고, 포인터가 같은 submodule은 diff만 범위를 갖는 식). 이제 한 곳에서 계산합니다.

### 📦 설치 / 업그레이드

- 자동 업데이터가 다음 실행 시 배너를 띄웁니다 → **Install and restart**.
```

- [ ] **Step 3: Full verification**

Run: `npm test`
Expected: PASS (all suites).

Run: `npm run check`
Expected: 0 errors.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 4: Manual check with the user**

Run `npm run tauri dev`, open `C:\workspace\sandbox`, enter Branch mode, and walk the spec's list with the user:

1. A branch that changes only the super repo: toolbar `sandbox [base main] ← [compare feature/x]`; group header `main ← feature/x`; commit table lists only compare's commits; diff panes labeled `base · main (merge-base)` / `compare · feature/x`.
2. A branch that bumps a submodule pointer: the submodule's header reads `pinned by sandbox: <sha> ← <sha>` with the tooltip; its commits appear as their own group.
3. Focus the submodule: the scope bar appears; **Compare own branches…** keeps the screen as it was; picking a ref changes only that repo; **Follow sandbox** returns to the pins.
4. A merged branch: summary `✓ All commits … merged by …`; **Show merged commits** lists what that merge brought in.
5. A cherry-picked commit: ◐ `applied as patch`.
6. Tabs layout: switch to a submodule tab; the scope bar shows (without `× All repos`); the table shows only that tab's group.
7. With Focus on a submodule, click one of its commits: its files list (the drill bug).
8. A squash-merged sbx-idl branch, compared on its own branches and through a super branch that pinned its pre-squash commit: rows read `squashed into <sha>`.

Record anything that differs from the spec before committing; fix it in the task that owns the behavior.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe the clearer branch mode"
```

Body: the README still described start/target and a toolbar that edits a focused tab's override; it now describes base/compare, the scope bar, the commit table and squash detection (with its git 2.38 note), and the changelog gains the v2.2.0 section.
