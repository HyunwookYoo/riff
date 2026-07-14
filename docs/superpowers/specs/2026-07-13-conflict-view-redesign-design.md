# Conflict-view redesign — structured 3-pane merge editor — design

## Problem
riff already ships a capable conflict resolver (`ConflictView.svelte`), but users
find it confusing on every axis (confirmed in brainstorming — all four pain points
selected):

1. **Layout overload** — four panes (Ours / Base / Theirs / Result) appear at once;
   unclear where to look.
2. **Resolution method unclear** — the Result pane shows raw git markers
   (`<<<<<<<`, `=======`, `>>>>>>>`); it's ambiguous whether you click a button or
   type to resolve.
3. **Next step unclear** — the per-file *Mark resolved → stage → banner Continue*
   progression isn't legible.
4. **Ours/Theirs confusing** — git jargon whose meaning flips between merge and
   rebase.

This is the "conflict view is confusing" half of the Fork-parity VCS initiative
(Track B). The reference point is Fork / VS Code's structured merge editor.

## Scope
Redesign `ConflictView.svelte` into a **structured 3-pane merge editor**:
two side panes (**Current** | **Incoming**) plus a **Result** pane, with Base on a
toggle; conflicts resolved by **structured per-hunk accept** (no raw markers in the
default view); manual editing preserved as an escape hatch. **Highlight what
actually differs within each conflict** (line/token-level). Relabel all Ours/Theirs
wording to **Current/Incoming** view-wide. Add legible next-step guidance.

**Frontend-only. No backend changes.** The existing bindings already suffice:
`conflictVersions(repo, path)` → `{ ours, base, theirs, merged, binary }`,
`resolveConflict(repo, path, content)` (writes + stages), and
`checkoutConflictSide(repo, path, side)` ("ours"|"theirs" whole-file). The Result is
assembled on the frontend and handed to `resolveConflict`.

## Locked design decisions
| Item | Decision |
|---|---|
| Layout | Top: **Current \| Incoming** (2 read-only panes). **Base** hidden by default, toolbar toggle. Bottom: **Result**. |
| Resolution | Parse `merged` into structured segments; Result shows **no raw markers**. Per-hunk **[Use Current] / [Use Incoming] / [Both]**; manual-edit escape hatch. |
| Labels | **Current / Incoming**, applied view-wide (headers, side-pane buttons, whole-file buttons, inline toolbar, tooltips). Current enriched with the real branch name; Incoming shows the op-aware role. Op-role sublabel kept for both. |
| Next step | Per-file progress ("N of M resolved"); on **Mark resolved** → stage + **auto-advance to the next conflicted file** (v1: always on). Banner reworded as ① resolve → ② stage → ③ continue. |
| Highlighting | Region shading per side + **intra-hunk diff highlight**: base→each side when diff3, else Current↔Incoming. Reuses `@codemirror/merge` line/token highlighting; frontend-only (hunks are small — no `scanLimit` concern). |
| Non-goals (v1) | Smarter auto-merge; real Incoming ref name (needs backend read). Binary conflicts keep today's take-a-side flow. |

## Architecture
The redesign splits the conflict logic into a **pure, testable model** plus a
reworked **view**. The model does the parsing and result assembly (unit-tested,
riff's standard testing surface — like `gitError.ts`); the view renders panes,
routes accept actions into the model, and re-derives the Result.

```
conflictVersions() ──▶ merged (with markers)
                          │
        parseConflicts(merged) ──▶ Segment[]   (pure, tested)
                          │
        user picks per hunk  ──▶ mutate Segment[].choice
                          │
        assembleResult(segments) ──▶ final text  (pure, tested)
                          │
        resolveConflict(repo, path, finalText)   (existing binding, stages it)
```

## Components
| Piece | Location | Role |
|---|---|---|
| Conflict model | `src/lib/conflictModel.ts` (new, pure) | parse markers → segments; assemble result; count unresolved; side descriptors |
| Model tests | `src/lib/conflictModel.test.ts` (new, vitest) | parse/assemble/count/labels over sample docs |
| Conflict view | `src/lib/ui/ConflictView.svelte` (major rework) | 2-pane + Base toggle; structured Result; per-hunk accept; **intra-hunk diff highlight**; manual escape hatch; auto-advance |
| Conflict banner | `src/lib/ui/ConflictBanner.svelte` (copy) | clearer ①→②→③ step wording (behavior unchanged) |
| Next-conflict nav | `src/lib/sourceControl.ts` | `openNextConflict()` helper for auto-advance |

No `store.svelte.ts` change: Base-toggle and manual-mode are component-local
`$state`.

## Conflict model (pure)
```ts
export type ConflictOp = "merge" | "rebase" | "cherry-pick" | "revert" | "none";
export type ConflictChoice = "current" | "incoming" | "both" | null;

export interface ConflictHunk {
  current: string;   // stage-2 ("ours") lines, joined with \n
  base: string;      // stage-1 base lines (diff3); "" when absent
  incoming: string;  // stage-3 ("theirs") lines
  choice: ConflictChoice;   // null = unresolved
}
export type Segment =
  | { type: "text"; content: string }         // verbatim non-conflict text
  | { type: "conflict"; hunk: ConflictHunk };

// Split a merged doc into ordered segments. Recognizes diff3 (|||||||) and
// plain markers. On malformed/unparseable markers, callers fall back to manual
// (marker) mode (see escape hatch) — the parser itself is best-effort.
export function parseConflicts(merged: string): Segment[];

// Concatenate: text verbatim; conflict → chosen side ("both" = current then
// incoming). Callers gate on unresolvedCount === 0 first; defensively, a hunk
// left null re-emits its standard markers (degrades to conflicted, never drops
// content).
export function assembleResult(segments: Segment[]): string;

// Flatten back to a standard-marker doc (unresolved hunks re-emit <<<< ==== >>>>).
// Seeds the manual-edit escape hatch so nothing is lost switching modes.
export function assembleResultWithMarkers(segments: Segment[]): string;

export function unresolvedCount(segments: Segment[]): number;

// Presentation labels. current gets the real branch name; incoming gets the
// op-aware role (real incoming ref name is out of scope in v1).
export interface SideDescriptor { label: string; role: string }
export function sideDescriptors(
  op: ConflictOp,
  currentBranch: string | null,
): { current: SideDescriptor; incoming: SideDescriptor };
```

`sideDescriptors` maps the git stage semantics to Current/Incoming:

| op | Current (stage-2 "ours") | Incoming (stage-3 "theirs") |
|---|---|---|
| merge | `currentBranch ?? "current branch"` · "current branch" | "Incoming" · "incoming branch" |
| rebase | `currentBranch ?? "rebase target"` · "rebase target (onto)" | "Incoming" · "your commit (replayed)" |
| cherry-pick | `currentBranch ?? "current branch"` · "current branch" | "Incoming" · "picked commit" |
| revert | `currentBranch ?? "current branch"` · "current branch" | "Incoming" · "being reverted" |

**Backend arg mapping (unchanged):** UI **Current → backend `"ours"`**, **Incoming
→ backend `"theirs"`**. `checkoutConflictSide` keeps its `"ours"|"theirs"` argument;
only the presentation is renamed. This preserves the frontend-only guarantee and is
consistent with git's stage-2/stage-3 (VS Code uses the same Current/Incoming
mapping).

## View: layout & interaction
**Panes.** Two read-only reference panes side by side — **Current** (green,
stage-2) and **Incoming** (blue, stage-3) — over the **Result** pane. A
toolbar **Base** toggle reveals a third read-only Base pane (disabled when the
merge is non-diff3 / base is empty). Colors reuse today's palette (Current green
`#4a9d5b`, Incoming blue `#5a9bd4`, base grey).

**Structured Result (default, marker-free).** The Result renders from the segment
model. Non-conflict text renders as normal (plain) text — the Result pane is not
syntax-highlighted (matching the pre-redesign editor, which had none); the
Current/Incoming reference panes keep their shiki highlighting. Each
**unresolved** conflict renders as a distinct, labeled block — Current content
above Incoming content, each with its side color gutter — carrying an inline
**[Use Current] [Use Incoming] [Both]** toolbar and a one-line hint ("Pick a side
above, or Edit manually"). Picking a choice replaces that block with the chosen
text (now normal code) and clears the highlight. **No `<<<<`/`====`/`>>>>` ASCII is
shown in this mode.**

**Accept routes (all mutate the one segment model):**
- Side panes: each conflict hunk is highlighted with a **[Use Current]** /
  **[Use Incoming]** button.
- Result block: inline **[Use Current] [Use Incoming] [Both]** toolbar.
- Toolbar (whole file): **Take Current** / **Take Incoming** →
  `checkoutConflictSide(..., "ours"|"theirs")` (unchanged).

**Manual-edit escape hatch.** A toolbar **Edit manually** toggle flattens the model
via `assembleResultWithMarkers()` into a plain editable CodeMirror (today's
behavior — standard markers for any still-unresolved hunks). From there resolution
is free-form; the unresolved counter falls back to counting `<<<<<<<`. This is also
the automatic fallback if `parseConflicts` cannot cleanly parse the doc, so the user
is never trapped.

**Navigation & status.** Toolbar shows status: unresolved count / "ready to mark
resolved". Prev/Next jump between remaining conflicts (kept from today). Reveal the
first conflict on load.

**Intra-hunk diff highlighting.** Within each conflict, highlight *what actually
differs* so a large hunk with a one-line change is obvious. Computed on the frontend
per hunk (small texts — the `scanLimit` that forces backend-computed diffs for whole
large files doesn't apply here), reusing `@codemirror/merge`'s line/token diff and
the existing `--diff-add-token` / `--diff-del-token` styling:
- **diff3 (base present):** highlight base→Current in the Current pane and
  base→Incoming in the Incoming pane — each side shows what it changed vs the common
  ancestor.
- **No base (2-way):** highlight Current↔Incoming directly.

The same highlighting carries into the Result's unresolved conflict blocks. Purely
presentational — it does not alter parsing, assembly, or the segment model.

## Next-step guidance
- **Per file.** Status reads "N of M conflicts resolved". When 0 remain, the
  **Mark resolved** button is emphasized.
- **Mark resolved.** Assembles the final text (`assembleResult`, or the editor text
  in manual mode) → `resolveConflict` (stages it) → `loadStatus()` → **auto-advance**
  to the next conflicted file via `openNextConflict()`. v1: always on, no setting.
- **Global banner.** `ConflictBanner` copy reworded to a legible progression:
  while unresolved files remain → "Step 1 of 3 — resolve N file(s), then stage &
  continue"; when all resolved → "All resolved — Continue to finish the <op>."
  Behavior (Resolve / Continue / Abort, Continue gated on 0 unresolved) unchanged.

## Data flow
1. Select a conflicted file → `conflictVersions(repo, path)`.
2. Binary → keep today's "Take Current / Take Incoming" placeholder.
3. Text → `parseConflicts(merged)` → `Segment[]`; render panes + structured Result;
   reveal first conflict.
4. User accepts per hunk (side pane / Result block) → mutate `choice` → re-derive
   Result; `unresolvedCount` drives status.
5. 0 unresolved → **Mark resolved** → `assembleResult` → `resolveConflict` →
   `loadStatus` → `openNextConflict()`.
6. All files resolved & staged → banner **Continue** enabled → `continueOp()`.
7. Escape hatch: **Edit manually** → `assembleResultWithMarkers` → plain editor;
   or **Take Current/Incoming** whole-file at any time.

## Testing
- `conflictModel.test.ts` (vitest) — the primary regression surface, fully pure:
  - `parseConflicts`: 0 conflicts; 1 conflict; N conflicts; diff3 (with base) vs
    plain (no base); leading/trailing text; content that merely *contains* the
    marker words mid-line (only line-start markers count); CRLF.
  - `assembleResult`: each choice (current / incoming / both) and mixed; verbatim
    text preservation.
  - `assembleResultWithMarkers`: round-trips an unresolved doc back to standard
    markers.
  - `unresolvedCount`: matches the number of null-choice hunks.
  - `sideDescriptors`: each op, with and without a known `currentBranch`.
- View — manual checklist (riff does not unit-test Svelte / git ops): a merge
  conflict and a rebase conflict; multi-conflict file; diff3 vs non-diff3 (incl. its
  intra-hunk diff highlight — base→sides vs Current↔Incoming); binary conflict;
  malformed markers → falls back to manual mode; auto-advance lands on the next file;
  Take Current/Incoming whole-file; banner Continue gating.

## Edge cases / limitations
- **Non-diff3 merges** → `base` empty → Base toggle disabled; parser emits
  `base: ""`.
- **Empty-base diff3 conflicts** (diff3/zdiff3 `conflictStyle` where the base section
  is empty — a "both sides added" hunk) → routed to **manual mode**: `parseConflicts`
  collapses the empty base to `base: ""` and `renderMarkers` then omits the `|||||||`
  line, so the `safeParse` round-trip mismatches. Safe (manual mode is lossless), but
  such hunks show markers instead of structured blocks. Only affects users who set
  diff3/zdiff3 (git default is `merge`, no `|||||||`). **Tracked follow-up:** add a
  `hasBase` boolean to `ConflictHunk` and key `renderMarkers` on it before any
  diff3-user-facing push.
- **Malformed / unparseable markers** → automatic fallback to manual (marker) mode;
  never trap the user.
- **Manual edits after structured picks** → escape hatch owns the text; counter
  falls back to marker counting.
- **Binary conflicts** → unchanged (Take Current / Take Incoming).
- **Real Incoming ref name** → not shown in v1 (needs a backend read of
  MERGE_HEAD / rebase state). Current shows its real branch name; Incoming shows the
  op-aware role. Listed below as a future enhancement.
- **Non-English git locale** → markers are locale-independent (`<<<<<<<` etc.), so
  parsing is unaffected; only the banner/labels are English (matching the rest of
  the app).

## Changed files
- `src/lib/conflictModel.ts` (new) — pure parse / assemble / count / labels
- `src/lib/conflictModel.test.ts` (new) — vitest
- `src/lib/ui/ConflictView.svelte` — rework: 2-pane + Base toggle, structured
  marker-free Result, Current/Incoming labels, per-hunk accept, manual escape hatch,
  auto-advance on Mark resolved
- `src/lib/ui/ConflictBanner.svelte` — clearer ①→②→③ step copy
- `src/lib/sourceControl.ts` — `openNextConflict()` helper

## Out of scope (v1) — later
- **Real Incoming ref name** (Current-style enrichment for the incoming side) —
  small backend addition to read MERGE_HEAD / rebase head-name.
- **Smarter 3-way auto-merge** (auto-resolve non-overlapping hunks).
- **Per-user preference** for auto-advance (v1 hardcodes on).
