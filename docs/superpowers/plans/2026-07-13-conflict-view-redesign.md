# Conflict-view redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `ConflictView.svelte` into a structured 3-pane merge editor —
Current | Incoming (+ Base toggle) over a marker-free Result — with per-hunk
accept, intra-hunk diff highlight, Current/Incoming labels, and legible next-step
guidance.

**Architecture:** A new **pure** module `conflictModel.ts` parses git's merged
markers into an editable segment model and re-assembles the resolved file
(unit-tested — riff's standard test surface). `ConflictView.svelte` holds the
segments as state, renders the two reference panes + a Result whose unresolved
conflicts are block widgets (no raw `<<<<` ASCII), routes accept actions into the
model, highlights what differs per hunk via `@codemirror/merge`'s `diff`, and
auto-advances to the next conflicted file on resolve. **Frontend only — no backend
change.**

**Tech Stack:** SvelteKit + Svelte 5 runes, TypeScript, CodeMirror 6
(`@codemirror/view`, `@codemirror/state`, `@codemirror/merge`), Vitest, existing
riff bindings in `src/lib/git.ts`.

## Global Constraints

Every task's requirements implicitly include this section.

- **Frontend only. No backend change.** Use existing bindings unchanged:
  `conflictVersions(path, filePath)` → `ConflictVersions { base, ours, theirs, merged, binary }`,
  `resolveConflict(path, filePath, content)` (writes + stages),
  `checkoutConflictSide(path, filePath, "ours"|"theirs")`.
- **Side mapping:** UI **Current → git `"ours"`** (stage-2), **Incoming → git
  `"theirs"`** (stage-3). `checkoutConflictSide` keeps its `"ours"|"theirs"`
  argument; only presentation is renamed.
- **Labels view-wide:** "Current" / "Incoming" on pane headers, whole-file buttons,
  per-hunk buttons, inline toolbar, tooltips. Current label enriched with
  `appState.currentBranch` when set; Incoming uses the op-aware role. The op-aware
  **role sublabel** is kept for both.
- **Colors (reuse existing palette):** Current green `#4a9d5b`, Incoming blue
  `#5a9bd4`, Base grey `#8c8c8c`.
- **No raw `<<<<<<<` / `=======` / `>>>>>>>` / `|||||||` ASCII** visible in the
  default (structured) Result.
- **Intra-hunk diff highlight:** diff3 (base present) → highlight base→Current and
  base→Incoming; no base → Current↔Incoming. Computed on the frontend via
  `@codemirror/merge`'s `diff` (hunks are small — the `scanLimit` that forces
  backend diffs for large whole files does not apply). Reuse token-highlight CSS.
- **Auto-advance** to the next conflicted file on Mark resolved — v1: always on, no
  setting.
- **Binary conflicts:** unchanged behavior (Take Current / Take Incoming).
- **Manual-edit escape hatch:** seed a plain editable editor from
  `assembleResult(segments)` (unresolved hunks render as canonical markers); also the
  automatic fallback when `parseConflicts` can't cleanly parse.
- **Testing posture:** only `conflictModel.ts` is unit-tested (vitest). The Svelte
  component is a manual checklist (riff does not unit-test Svelte / git ops).
- **Gates per task:** `npm test` (vitest) and `npm run check` (svelte-check; 1
  pre-existing benign `@types/node` warning is expected). No cargo (no backend
  change).

**Note on spec deviation (intentional, DRY):** the spec listed both
`assembleResult` and `assembleResultWithMarkers`. They collapse into a single
`assembleResult` — an unresolved (null-choice) hunk renders as canonical markers, so
the one function serves both the final-resolve path (no nulls → pure resolved text)
and the manual-seed path (nulls → markers).

---

## Task 1: conflictModel — types + `parseConflicts`

**Files:**
- Create: `src/lib/conflictModel.ts`
- Test: `src/lib/conflictModel.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `ConflictOp`, `ConflictChoice`, `ConflictHunk`, `Segment`,
  `parseConflicts(merged: string): Segment[]`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/conflictModel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseConflicts, type Segment } from "./conflictModel";

const MERGE = `line 1
<<<<<<< HEAD
current A
=======
incoming A
>>>>>>> feature
line 2
`;

const DIFF3 = `<<<<<<< HEAD
current A
||||||| base
base A
=======
incoming A
>>>>>>> feature
`;

function conflicts(segs: Segment[]) {
  return segs.filter((s) => s.type === "conflict");
}

describe("parseConflicts", () => {
  it("returns a single text segment when there are no conflicts", () => {
    const segs = parseConflicts("a\nb\n");
    expect(segs).toEqual([{ type: "text", content: "a\nb\n" }]);
  });

  it("splits leading/trailing text around a conflict", () => {
    const segs = parseConflicts(MERGE);
    expect(segs[0]).toEqual({ type: "text", content: "line 1\n" });
    expect(segs[2]).toEqual({ type: "text", content: "line 2\n" });
    expect(conflicts(segs)).toHaveLength(1);
  });

  it("captures current/incoming with no base for a plain merge", () => {
    const h = conflicts(parseConflicts(MERGE))[0];
    if (h.type !== "conflict") throw new Error("expected conflict");
    expect(h.hunk.current).toBe("current A\n");
    expect(h.hunk.incoming).toBe("incoming A\n");
    expect(h.hunk.base).toBe("");
    expect(h.hunk.choice).toBeNull();
  });

  it("captures base for a diff3 conflict", () => {
    const h = conflicts(parseConflicts(DIFF3))[0];
    if (h.type !== "conflict") throw new Error("expected conflict");
    expect(h.hunk.base).toBe("base A\n");
    expect(h.hunk.current).toBe("current A\n");
    expect(h.hunk.incoming).toBe("incoming A\n");
  });

  it("parses multiple conflicts", () => {
    const doc = MERGE + MERGE;
    expect(conflicts(parseConflicts(doc))).toHaveLength(2);
  });

  it("ignores marker words that are not at line start", () => {
    const segs = parseConflicts("a <<<<<<< not a marker\nb\n");
    expect(segs).toEqual([{ type: "text", content: "a <<<<<<< not a marker\nb\n" }]);
  });

  it("round-trips content: concatenating raw pieces reproduces the input", () => {
    const segs = parseConflicts(DIFF3);
    const raw = segs
      .map((s) =>
        s.type === "text"
          ? s.content
          : `<<<<<<< HEAD\n${s.hunk.current}||||||| base\n${s.hunk.base}=======\n${s.hunk.incoming}>>>>>>> feature\n`,
      )
      .join("");
    expect(raw).toBe(DIFF3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- conflictModel`
Expected: FAIL — `conflictModel.ts` does not exist / `parseConflicts` undefined.

- [ ] **Step 3: Write `conflictModel.ts` (types + parseConflicts)**

Create `src/lib/conflictModel.ts`:

```ts
// Pure model for git conflict resolution: parse the working-tree `merged`
// document (with <<<<<<< markers) into an editable segment list, and reassemble
// the resolved file. No CodeMirror / Svelte imports — unit-tested standalone.

export type ConflictOp = "merge" | "rebase" | "cherry-pick" | "revert" | "none";
export type ConflictChoice = "current" | "incoming" | "both" | null;

export interface ConflictHunk {
  current: string; // stage-2 ("ours") content, verbatim incl. line terminators
  base: string; // stage-1 base content (diff3); "" when absent
  incoming: string; // stage-3 ("theirs") content
  choice: ConflictChoice; // null = unresolved
}

export type Segment =
  | { type: "text"; content: string } // verbatim non-conflict text
  | { type: "conflict"; hunk: ConflictHunk };

// Split into lines that KEEP their trailing "\n", so concatenation is lossless.
function rawLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Parse a merged doc into ordered segments. Recognizes diff3 (|||||||) and plain
 * markers; only markers at line start count. Best-effort: a doc without a clean
 * closing marker still returns whatever was collected (callers fall back to
 * manual mode on anomalies).
 */
export function parseConflicts(merged: string): Segment[] {
  const lines = rawLines(merged);
  const segments: Segment[] = [];
  let text = "";
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      if (text) {
        segments.push({ type: "text", content: text });
        text = "";
      }
      i++; // consume <<<<<<<
      let current = "";
      let base = "";
      let incoming = "";
      let hasBase = false;
      while (
        i < lines.length &&
        !lines[i].startsWith("|||||||") &&
        !lines[i].startsWith("=======")
      )
        current += lines[i++];
      if (i < lines.length && lines[i].startsWith("|||||||")) {
        hasBase = true;
        i++; // consume |||||||
        while (i < lines.length && !lines[i].startsWith("======="))
          base += lines[i++];
      }
      if (i < lines.length && lines[i].startsWith("=======")) i++; // consume =======
      while (i < lines.length && !lines[i].startsWith(">>>>>>>"))
        incoming += lines[i++];
      if (i < lines.length && lines[i].startsWith(">>>>>>>")) i++; // consume >>>>>>>
      segments.push({
        type: "conflict",
        hunk: { current, base: hasBase ? base : "", incoming, choice: null },
      });
    } else {
      text += lines[i++];
    }
  }
  if (text) segments.push({ type: "text", content: text });
  return segments;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- conflictModel`
Expected: PASS (all `parseConflicts` cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/conflictModel.ts src/lib/conflictModel.test.ts
git commit -m "feat(conflict): pure conflict-model parser + tests"
```

---

## Task 2: conflictModel — `assembleResult`, `unresolvedCount`, `sideDescriptors`

**Files:**
- Modify: `src/lib/conflictModel.ts`
- Test: `src/lib/conflictModel.test.ts` (append)

**Interfaces:**
- Consumes: `Segment`, `ConflictHunk`, `ConflictOp` (Task 1).
- Produces: `assembleResult(segments): string`, `unresolvedCount(segments): number`,
  `SideDescriptor`, `sideDescriptors(op, currentBranch): { current, incoming }`.

- [ ] **Step 1: Write the failing tests (append)**

Append to `src/lib/conflictModel.test.ts`:

```ts
import {
  assembleResult,
  unresolvedCount,
  sideDescriptors,
} from "./conflictModel";

const MERGE2 = `pre
<<<<<<< HEAD
current A
=======
incoming A
>>>>>>> feature
post
`;

describe("assembleResult", () => {
  it("keeps text verbatim and picks the chosen side", () => {
    const segs = parseConflicts(MERGE2);
    const c = segs.find((s) => s.type === "conflict")!;
    if (c.type !== "conflict") throw new Error();
    c.hunk.choice = "incoming";
    expect(assembleResult(segs)).toBe("pre\nincoming A\npost\n");
  });

  it("'both' is current then incoming", () => {
    const segs = parseConflicts(MERGE2);
    const c = segs.find((s) => s.type === "conflict")!;
    if (c.type !== "conflict") throw new Error();
    c.hunk.choice = "both";
    expect(assembleResult(segs)).toBe("pre\ncurrent A\nincoming A\npost\n");
  });

  it("renders canonical markers for an unresolved hunk", () => {
    const out = assembleResult(parseConflicts(MERGE2));
    expect(out).toContain("<<<<<<< Current");
    expect(out).toContain("=======");
    expect(out).toContain(">>>>>>> Incoming");
  });
});

describe("unresolvedCount", () => {
  it("counts null-choice hunks", () => {
    const segs = parseConflicts(MERGE2 + MERGE2);
    expect(unresolvedCount(segs)).toBe(2);
    const c = segs.find((s) => s.type === "conflict")!;
    if (c.type !== "conflict") throw new Error();
    c.hunk.choice = "current";
    expect(unresolvedCount(segs)).toBe(1);
  });
});

describe("sideDescriptors", () => {
  it("merge uses the current branch name and incoming role", () => {
    const d = sideDescriptors("merge", "main");
    expect(d.current.label).toBe("main");
    expect(d.incoming.label).toBe("Incoming");
    expect(d.incoming.role).toBe("incoming branch");
  });

  it("rebase flips the roles", () => {
    const d = sideDescriptors("rebase", "main");
    expect(d.current.role).toBe("rebase target (onto)");
    expect(d.incoming.role).toBe("your commit (replayed)");
  });

  it("falls back to a generic label with no known branch", () => {
    expect(sideDescriptors("merge", null).current.label).toBe("current branch");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- conflictModel`
Expected: FAIL — `assembleResult` / `unresolvedCount` / `sideDescriptors` undefined.

- [ ] **Step 3: Append the implementations to `conflictModel.ts`**

```ts
function renderMarkers(h: ConflictHunk): string {
  const base = h.base ? `||||||| Base\n${h.base}` : "";
  return `<<<<<<< Current\n${h.current}${base}=======\n${h.incoming}>>>>>>> Incoming\n`;
}

/**
 * Reassemble the file: text verbatim; a conflict → its chosen side ("both" =
 * current then incoming). An unresolved (null) hunk renders as canonical
 * markers, so this serves both the final resolve (callers gate on
 * unresolvedCount === 0 → no markers emitted) and the manual-edit seed.
 */
export function assembleResult(segments: Segment[]): string {
  let out = "";
  for (const s of segments) {
    if (s.type === "text") {
      out += s.content;
      continue;
    }
    const h = s.hunk;
    out +=
      h.choice === "current"
        ? h.current
        : h.choice === "incoming"
          ? h.incoming
          : h.choice === "both"
            ? h.current + h.incoming
            : renderMarkers(h);
  }
  return out;
}

export function unresolvedCount(segments: Segment[]): number {
  return segments.filter((s) => s.type === "conflict" && s.hunk.choice === null)
    .length;
}

export interface SideDescriptor {
  label: string;
  role: string;
}

/**
 * Presentation labels. Current takes the real branch name when known; Incoming
 * takes the op-aware role (real incoming ref name is out of scope in v1). The
 * role sublabel is kept for both.
 */
export function sideDescriptors(
  op: ConflictOp,
  currentBranch: string | null,
): { current: SideDescriptor; incoming: SideDescriptor } {
  const cur = currentBranch ?? null;
  switch (op) {
    case "rebase":
      return {
        current: { label: cur ?? "rebase target", role: "rebase target (onto)" },
        incoming: { label: "Incoming", role: "your commit (replayed)" },
      };
    case "cherry-pick":
      return {
        current: { label: cur ?? "current branch", role: "current branch" },
        incoming: { label: "Incoming", role: "picked commit" },
      };
    case "revert":
      return {
        current: { label: cur ?? "current branch", role: "current branch" },
        incoming: { label: "Incoming", role: "being reverted" },
      };
    default: // merge / none
      return {
        current: { label: cur ?? "current branch", role: "current branch" },
        incoming: { label: "Incoming", role: "incoming branch" },
      };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- conflictModel`
Expected: PASS (all Task 1 + Task 2 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/conflictModel.ts src/lib/conflictModel.test.ts
git commit -m "feat(conflict): result assembly, unresolved count, side labels"
```

---

## Task 3: next-step plumbing — `openNextConflict` + banner copy

**Files:**
- Modify: `src/lib/sourceControl.ts` (add `openNextConflict`, near
  `enterConflictResolution` ~line 118)
- Modify: `src/lib/ui/ConflictBanner.svelte` (message copy only)

**Interfaces:**
- Consumes: `conflictedEntries()`, `openChange()`, `appState.selectedFile` (existing).
- Produces: `openNextConflict(): void`.

- [ ] **Step 1: Add `openNextConflict` to `sourceControl.ts`**

After `enterConflictResolution` (ends ~line 122), add:

```ts
/// Open the next still-conflicted file (the first unmerged entry that isn't the
/// one already selected), used to auto-advance after a file is resolved. No-op
/// when none remain.
export function openNextConflict(): void {
  const conflicts = conflictedEntries();
  if (conflicts.length === 0) return;
  const cur = appState.selectedFile?.path;
  const next = conflicts.find((e) => e.path !== cur) ?? conflicts[0];
  openChange(next, "unstaged");
}
```

- [ ] **Step 2: Reword `ConflictBanner.svelte` to a legible ①→②→③ progression**

In `src/lib/ui/ConflictBanner.svelte`, replace the message block (lines ~27-33):

```svelte
      {#if unresolved > 0}
        ⚠ {label} paused on a conflict — Step 1 of 3: resolve {unresolved}
        file{unresolved === 1 ? "" : "s"}, then stage &amp; Continue.
      {:else}
        ✓ {label}: all conflicts resolved — Step 3 of 3: Continue to finish.
      {/if}
```

Leave the buttons (Resolve / Continue / Abort) and all logic unchanged.

- [ ] **Step 3: Verify build**

Run: `npm run check`
Expected: 0 errors (1 pre-existing `@types/node` warning is fine).

- [ ] **Step 4: Commit**

```bash
git add src/lib/sourceControl.ts src/lib/ui/ConflictBanner.svelte
git commit -m "feat(conflict): openNextConflict helper + clearer banner steps"
```

---

## Task 4: ConflictView — 2-pane + Base toggle + Current/Incoming labels

Relabel the whole view and collapse the reference panes to **Current | Incoming**
with **Base** behind a toggle. The Result mechanism is untouched in this task (still
the existing marker editor) so the change is a self-contained, visually reviewable
slice.

**Files:**
- Modify: `src/lib/ui/ConflictView.svelte`

**Interfaces:**
- Consumes: `sideDescriptors` (Task 2), `appState.currentBranch`, `appState.pendingOp`.
- Produces: nothing downstream (UI).

- [ ] **Step 1: Replace `sideLabels` with `sideDescriptors`**

Import from the model and derive descriptors:

```ts
import { sideDescriptors } from "$lib/conflictModel";
// ...
const sides = $derived(
  sideDescriptors(appState.pendingOp as any, appState.currentBranch),
);
```

Remove the old `const sideLabels = $derived.by(...)` block (lines ~51-62). Update the
`AcceptWidget` construction and its `oursLabel`/`theirsLabel` args to pass
`sides.current.role` / `sides.incoming.role`, and rename the button text produced by
`AcceptWidget.toDOM` from `Ours`/`Theirs` to **Use Current** / **Use Incoming**
(keep **Both**). The insert strings are unchanged (Current = ours content).

- [ ] **Step 2: Add a Base-toggle state and relabel the toolbar**

```ts
let showBase = $state(false);
```

In the toolbar, rename `Take ours` → **Take Current** (tooltip
`Use the whole Current side — {sides.current.role}`), `Take theirs` → **Take
Incoming**; `takeSide("ours"|"theirs")` calls are unchanged. Add a Base toggle
button, shown only when `hasBase`:

```svelte
{#if !binary && hasBase}
  <button type="button" class:active={showBase}
    title="Show the common ancestor (base)"
    onclick={() => (showBase = !showBase)}>Base</button>
{/if}
```

- [ ] **Step 3: Rework the panes to Current | Incoming (+ optional Base)**

Replace the `.cv-panes` block (lines ~483-496) so it shows **two** columns by
default and inserts Base only when toggled:

```svelte
<div class="cv-panes">
  <div class="cv-col">
    <header class="cv-h current">Current · {sides.current.label}</header>
    <div class="cv-host" bind:this={oursHost}></div>
  </div>
  {#if showBase && hasBase}
    <div class="cv-col">
      <header class="cv-h base">Base</header>
      <div class="cv-host" bind:this={baseHost}></div>
    </div>
  {/if}
  <div class="cv-col">
    <header class="cv-h incoming">Incoming · {sides.incoming.role}</header>
    <div class="cv-host" bind:this={theirsHost}></div>
  </div>
</div>
```

Guard the `baseView` construction in `load()` so it only builds when the Base host is
present (it now renders conditionally). Rename CSS classes `.cv-h.ours` → `.cv-h.current`
(green `#4a9d5b`) and `.cv-h.theirs` → `.cv-h.incoming` (blue `#5a9bd4`); keep
`.cv-h.base` grey.

- [ ] **Step 4: Verify build + manual smoke**

Run: `npm run check`
Expected: 0 errors.
Manual (implementer notes for the controller's later E2E): headers read
"Current · <branch>" / "Incoming · <role>"; Base hidden until toggled; Take
Current/Incoming and the per-hunk Use Current/Use Incoming/Both still resolve.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/ConflictView.svelte
git commit -m "feat(conflict): Current/Incoming labels, 2-pane + Base toggle"
```

---

## Task 5: ConflictView — structured marker-free Result

Swap the Result from an editable marker doc to a **segment-driven** view: text and
resolved hunks render as real (highlighted) code; each **unresolved** hunk renders
as a block widget carrying **Use Current / Use Incoming / Both** and no raw ASCII.
Accepting mutates the segment model and rebuilds. Add the **manual-edit escape
hatch** and **auto-advance**.

**Files:**
- Modify: `src/lib/ui/ConflictView.svelte`

**Interfaces:**
- Consumes: `parseConflicts`, `assembleResult`, `unresolvedCount` (Tasks 1-2),
  `openNextConflict` (Task 3), `Segment`/`ConflictHunk` types.
- Produces: nothing downstream.

- [ ] **Step 1: Hold segments as state; build them on load**

```ts
import {
  parseConflicts,
  assembleResult,
  unresolvedCount,
  type Segment,
} from "$lib/conflictModel";

let segments = $state<Segment[]>([]);
let manualMode = $state(false); // escape hatch: plain editable markers
const remaining = $derived(
  manualMode ? countConflicts(resultDoc()) : unresolvedCount(segments),
);
```

In `load()`, after fetching `vers`, set `segments = parseConflicts(vers.merged)` and
`manualMode = false`. If `parseConflicts` throws or yields a conflict whose
reassembly (`assembleResult` with current choices) doesn't equal `vers.merged`, set
`manualMode = true` (safety fallback). Keep `binary` handling as-is.

- [ ] **Step 2: Render the structured Result from segments**

Replace the Result editor construction. In **structured mode** the Result editor is
read-only; resolution happens through accept buttons. Build the doc + decorations
from segments:

```ts
// Doc text = resolved/text inline; each unresolved hunk = one sentinel newline
// carrying a replace block widget. Returns the doc plus widget placements.
function buildResult(segs: Segment[]): { doc: string; blocks: { pos: number; idx: number }[] } {
  let doc = "";
  const blocks: { pos: number; idx: number }[] = [];
  segs.forEach((s, idx) => {
    if (s.type === "text") { doc += s.content; return; }
    const h = s.hunk;
    if (h.choice === null) {
      blocks.push({ pos: doc.length, idx });
      doc += "\n"; // sentinel line the widget replaces
    } else {
      doc += h.choice === "current" ? h.current
           : h.choice === "incoming" ? h.incoming
           : h.current + h.incoming;
    }
  });
  return { doc, blocks };
}
```

Render each `blocks[]` entry with a `Decoration.replace({ block: true, widget:
new ConflictBlockWidget(idx) })` over the sentinel line, and rebuild the editor
state whenever `segments` changes (a full `EditorState.create` is fine — accepts are
low-frequency). Non-sentinel text keeps the shiki highlight extension.

- [ ] **Step 3: Implement `ConflictBlockWidget`**

A block widget showing the two sides stacked with side colors and an accept toolbar
(diff highlight is added in Task 6):

```ts
class ConflictBlockWidget extends WidgetType {
  constructor(readonly idx: number) { super(); }
  eq(o: ConflictBlockWidget) { return o.idx === this.idx; }
  toDOM() {
    const seg = segments[this.idx];
    const h = seg.type === "conflict" ? seg.hunk : null;
    const wrap = document.createElement("div");
    wrap.className = "cv-block";
    if (!h) return wrap;
    const side = (cls: string, label: string, text: string) => {
      const box = document.createElement("div");
      box.className = `cv-side ${cls}`;
      const hd = document.createElement("div");
      hd.className = "cv-side-h";
      hd.textContent = label;
      const pre = document.createElement("pre");
      pre.className = "cv-side-body";
      pre.textContent = text.replace(/\n$/, "");
      box.append(hd, pre);
      return box;
    };
    wrap.appendChild(side("current", `Current · ${sides.current.label}`, h.current));
    wrap.appendChild(side("incoming", `Incoming · ${sides.incoming.role}`, h.incoming));
    const bar = document.createElement("div");
    bar.className = "cv-block-bar";
    const btn = (txt: string, choice: "current" | "incoming" | "both") => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = txt;
      b.onclick = () => choose(this.idx, choice);
      return b;
    };
    bar.append(btn("Use Current", "current"), btn("Use Incoming", "incoming"), btn("Both", "both"));
    wrap.appendChild(bar);
    return wrap;
  }
  ignoreEvent() { return false; }
}
```

- [ ] **Step 4: Accept handler + reactive rebuild**

```ts
function choose(idx: number, choice: "current" | "incoming" | "both") {
  const seg = segments[idx];
  if (seg.type !== "conflict") return;
  seg.hunk.choice = choice;
  segments = [...segments]; // trigger the $effect that rebuilds the editor
}
```

Drive the editor rebuild from a `$effect` on `segments` + `manualMode` (mirroring the
existing theme/file effect). The top **Use Current/Use Incoming** buttons in the side
panes call the same `choose(idx, ...)` (Task 6 wires per-hunk pane buttons; in this
task the block toolbar is the accept locus).

- [ ] **Step 5: Manual-edit escape hatch**

Add a toolbar **Edit manually** toggle:

```svelte
<button type="button" class:active={manualMode}
  title="Edit the file directly with conflict markers"
  onclick={() => (manualMode = !manualMode)}>Edit manually</button>
```

When `manualMode` is true, build the Result as a **plain editable** CodeMirror seeded
with `assembleResult(segments)` (unresolved → markers), exactly the pre-redesign
editor (lineWrapping, shiki, search, `countConflicts` update listener). `markResolved`
reads the live doc in manual mode; in structured mode it uses
`assembleResult(segments)`.

- [ ] **Step 6: `markResolved` → resolve + auto-advance**

```ts
async function markResolved() {
  const file = appState.selectedFile;
  if (!file || busy) return;
  const content = manualMode
    ? (resultView?.state.doc.toString() ?? "")
    : assembleResult(segments);
  if (countConflicts(content) > 0) return; // guard: markers remain
  busy = true; error = null;
  try {
    await resolveConflict(changesRepoPath(), file.path, content);
    await loadStatus();
    openNextConflict(); // v1: always advance
  } catch (e) { error = String(e); }
  finally { busy = false; }
}
```

Gate the toolbar **Mark resolved** button on `remaining === 0`. Keep `takeSide`
(whole-file Take Current/Incoming) and `binary` handling unchanged.

- [ ] **Step 7: Verify build**

Run: `npm run check` and `npm test`
Expected: check 0 errors; vitest still green (model unaffected).

- [ ] **Step 8: Commit**

```bash
git add src/lib/ui/ConflictView.svelte
git commit -m "feat(conflict): structured marker-free Result + manual escape + auto-advance"
```

---

## Task 6: ConflictView — intra-hunk diff highlight

Highlight *what differs* inside each conflict block (and the reference panes), so a
big hunk with a one-line change is obvious.

**Files:**
- Modify: `src/lib/ui/ConflictView.svelte`

**Interfaces:**
- Consumes: `diff` from `@codemirror/merge`; `segments`, `sides` (Task 5),
  `ConflictHunk`.
- Produces: nothing downstream.

- [ ] **Step 1: Add the diff helper**

```ts
import { diff } from "@codemirror/merge";

// Character ranges within `b` that differ from `a` (added/changed parts of b).
function changedInB(a: string, b: string): [number, number][] {
  return diff(a, b)
    .map((c) => [c.fromB, c.toB] as [number, number])
    .filter(([f, t]) => t > f);
}

// For a hunk: which ranges to highlight on each side.
// diff3 → base→current, base→incoming; else current↔incoming.
function hunkHighlights(h: ConflictHunk): { current: [number, number][]; incoming: [number, number][] } {
  if (h.base)
    return { current: changedInB(h.base, h.current), incoming: changedInB(h.base, h.incoming) };
  return { current: changedInB(h.incoming, h.current), incoming: changedInB(h.current, h.incoming) };
}
```

- [ ] **Step 2: Render highlighted text in the block widget**

Replace the plain `pre.textContent = text` in `ConflictBlockWidget.side` with a
range-aware renderer that wraps changed spans:

```ts
function renderRanges(text: string, ranges: [number, number][]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const body = text.replace(/\n$/, "");
  let pos = 0;
  for (const [f, t] of ranges) {
    const a = Math.min(f, body.length), b = Math.min(t, body.length);
    if (a > pos) frag.appendChild(document.createTextNode(body.slice(pos, a)));
    if (b > a) {
      const span = document.createElement("span");
      span.className = "cv-tok";
      span.textContent = body.slice(a, b);
      frag.appendChild(span);
    }
    pos = b;
  }
  if (pos < body.length) frag.appendChild(document.createTextNode(body.slice(pos)));
  return frag;
}
```

In `toDOM`, compute `const hl = hunkHighlights(h)` once and pass
`hl.current` / `hl.incoming` to the respective side's `pre` via `renderRanges`.

- [ ] **Step 3: Add token-highlight CSS (reuse diff palette)**

```css
.cv-block { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; }
.cv-side { border-left: 3px solid; border-radius: 3px; overflow: auto; }
.cv-side.current { border-color: #4a9d5b; background: rgba(74,157,91,0.10); }
.cv-side.incoming { border-color: #5a9bd4; background: rgba(90,155,212,0.10); }
.cv-side-h { font-size: 0.72em; text-transform: uppercase; letter-spacing: .03em; padding: 2px 6px; color: var(--muted); }
.cv-side-body { margin: 0; padding: 2px 6px; font-family: var(--mono); white-space: pre-wrap; }
.cv-side-body .cv-tok { background: var(--diff-add-token, rgba(74,157,91,0.35)); border-radius: 2px; }
.cv-side.incoming .cv-side-body .cv-tok { background: var(--diff-del-token, rgba(90,155,212,0.35)); }
.cv-block-bar { display: flex; gap: 6px; }
.cv-block-bar button { font-family: var(--mono); font-size: 0.75em; padding: 2px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--input-bg); color: inherit; cursor: pointer; }
```

- [ ] **Step 4: Verify build**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/ConflictView.svelte
git commit -m "feat(conflict): intra-hunk diff highlight in conflict blocks"
```

---

## Task 7: Manual end-to-end verification

No code. The controller performs (or asks the user to perform) the GUI checklist,
since riff does not unit-test Svelte / git ops.

- [ ] **Step 1: Run the app**

Run: `npm run tauri dev`

- [ ] **Step 2: Walk the checklist** (create real conflicts in a scratch repo)

- Merge conflict: headers read "Current · <branch>" / "Incoming · incoming branch";
  no raw `<<<<` visible in the Result; **Use Current / Use Incoming / Both** resolve
  a hunk; status counts down; **Mark resolved** stages and **auto-advances** to the
  next conflicted file.
- Rebase conflict: Incoming role reads "your commit (replayed)", Current "rebase
  target (onto)".
- Multi-conflict file: each block resolves independently; Prev/Next navigation works.
- diff3 vs non-diff3: **Base** toggle appears only for diff3; intra-hunk highlight
  shows base→sides (diff3) vs Current↔Incoming (2-way).
- Binary conflict: falls back to Take Current / Take Incoming.
- **Edit manually**: toggles to a marker editor seeded from current picks; resolving
  there and Mark resolved works.
- Malformed markers: view falls back to manual mode (no crash).
- Banner: shows Step 1/3 while unresolved, Step 3/3 when clear; Continue gates on 0
  unresolved.

- [ ] **Step 3: Confirm automated gates once more**

Run: `npm test` (35+ passing incl. new `conflictModel` cases) and `npm run check`
(0 errors).

---

## Self-Review

- **Spec coverage:** layout 2-pane+Base toggle (T4) ✓; marker-free structured Result
  (T5) ✓; Current/Incoming labels view-wide (T4-T6) ✓; intra-hunk diff highlight
  (T6) ✓; next-step progress + auto-advance + banner (T3, T5) ✓; manual escape hatch
  (T5) ✓; pure model + tests (T1-T2) ✓; binary unchanged ✓; frontend-only ✓.
- **Deviation noted:** `assembleResultWithMarkers` collapsed into `assembleResult`
  (Global Constraints note) — DRY, behavior-equivalent.
- **Type consistency:** `Segment`/`ConflictHunk`/`ConflictChoice`/`ConflictOp` defined
  in T1, consumed unchanged in T2/T4/T5/T6; `sideDescriptors` shape
  (`{current,incoming}` of `{label,role}`) used identically in T4-T6; `choose(idx,
  choice)` and `ConflictBlockWidget(idx)` consistent across T5-T6.
- **Out of scope (v1):** real Incoming ref name (needs backend read), smarter
  auto-merge, per-user auto-advance setting.
