# Operation Error Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When checkout / pull / merge are refused by local changes, classify the failure and offer one-click stash-and-retry (or discard/commit-first) recovery instead of dumping raw git stderr.

**Architecture:** Reactive + backend-atomic. Run the op; on a clean git refusal, a pure frontend classifier (`gitError.ts`) tags the stderr; a recoverable tag opens `OpRecoveryDialog`, whose actions call atomic backend commands (`stash_pull` / `stash_merge`, mirroring the existing `stash_checkout` / `stash_rebase`). Unknown errors fall through to the existing banner, now dismissable.

**Tech Stack:** Tauri (Rust) backend, SvelteKit + Svelte 5 runes frontend, vitest for unit tests.

**Design spec:** `docs/superpowers/specs/2026-07-13-op-error-recovery-design.md`

**Branch:** `feat/op-error-recovery` (already created; spec already committed as `b688729`).

## Global Constraints

- **No git `--autostash`.** Recovery stashes manually (stash → op → pop-on-clean / keep-stash-on-conflict), matching the existing `stash_checkout` / `stash_rebase` — a conflicting `--autostash` reapply wedges the op.
- **Stash with `--include-untracked`** so untracked-file collisions are also cleared.
- **Frontend classification only** for v1 — no change to `GitError` or its string serialization.
- **Match locale-English git substrings**; any unrecognized stderr → `unknown` → raw banner (no regression).
- **Discard offered for checkout only** in v1 (pull/merge discard is phase-2).
- **Destructive actions confirm first** via `confirmAction` (Tauri dialog).
- **Conventional-commit** messages; one commit per task on `feat/op-error-recovery`.

---

## File Structure

**New files:**
- `src/lib/gitError.ts` — pure stderr classifier (no store dependency, unit-tested)
- `src/lib/gitError.test.ts` — classifier vitest suite
- `src/lib/recovery.ts` — `offerRecovery()` helper: classify + populate `appState.recovery` (imports store + classifier; shared by checkout & source-control wiring, so it lives apart to avoid an import cycle)
- `src/lib/ui/OpRecoveryDialog.svelte` — the recovery modal (modeled on `CheckoutDialog.svelte`)

**Modified files:**
- `src-tauri/src/git/mod.rs` — 2 `GitLayer` trait signatures
- `src-tauri/src/git/cli.rs` — `stash_pull` / `stash_merge` impls
- `src-tauri/src/lib.rs` — 2 `#[tauri::command]` wrappers + invoke_handler registration
- `src/lib/git.ts` — `stashPull` / `stashMerge` bindings
- `src/lib/store.svelte.ts` — `recovery` state field
- `src/lib/checkout.ts` — route `requestCheckout` failures through `offerRecovery`
- `src/lib/sourceControl.ts` — route `doPull` / `doMergeBranch` failures through `offerRecovery`
- `src/lib/ui/InputBar.svelte` — dismiss (×) on the error banner
- `src/routes/+page.svelte` — mount `OpRecoveryDialog`

---

## Task 1: Error classifier

**Files:**
- Create: `src/lib/gitError.ts`
- Test: `src/lib/gitError.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type GitFailureKind = "local-changes-blocked" | "untracked-collision" | "unknown"`
  - `interface GitFailure { kind: GitFailureKind; paths: string[]; raw: string }`
  - `function classifyGitError(stderr: string): GitFailure`
  - `function parseBlockedPaths(stderr: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/gitError.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyGitError, parseBlockedPaths } from "./gitError";

// Real git stderr shapes. Lines are real newlines; path lines are tab-indented
// (the `\t` escape is an actual tab, which is what git emits).
const CHECKOUT_LOCAL = `error: Your local changes to the following files would be overwritten by checkout:
\tsrc/foo.rs
\tsrc/bar.rs
Please commit your changes or stash them before you switch branches.
Aborting`;

const CHECKOUT_UNTRACKED = `error: The following untracked working tree files would be overwritten by checkout:
\tnotes.txt
Please move or remove them before you switch branches.
Aborting`;

const MERGE_DIRTY = `error: Your local changes to the following files would be overwritten by merge:
\tREADME.md
Please commit your changes or stash them before you merge.
Aborting`;

const PULL_REBASE_DIRTY = `error: cannot pull with rebase: You have unstaged changes.
error: Please commit or stash them.`;

const AUTH_FAIL = `fatal: Authentication failed for 'https://example.com/repo.git/'`;
const DIVERGENT = `fatal: Need to specify how to reconcile divergent branches.`;

describe("classifyGitError", () => {
  it("classifies checkout blocked by tracked local changes", () => {
    const f = classifyGitError(CHECKOUT_LOCAL);
    expect(f.kind).toBe("local-changes-blocked");
    expect(f.paths).toEqual(["src/foo.rs", "src/bar.rs"]);
  });

  it("classifies an untracked-file collision distinctly", () => {
    const f = classifyGitError(CHECKOUT_UNTRACKED);
    expect(f.kind).toBe("untracked-collision");
    expect(f.paths).toEqual(["notes.txt"]);
  });

  it("classifies a dirty merge as local-changes-blocked", () => {
    expect(classifyGitError(MERGE_DIRTY).kind).toBe("local-changes-blocked");
  });

  it("classifies a dirty rebase-pull as local-changes-blocked", () => {
    expect(classifyGitError(PULL_REBASE_DIRTY).kind).toBe("local-changes-blocked");
  });

  it("leaves auth failures unknown (no false recovery)", () => {
    expect(classifyGitError(AUTH_FAIL).kind).toBe("unknown");
  });

  it("leaves divergent-branch pull unknown (out of case-A scope)", () => {
    expect(classifyGitError(DIVERGENT).kind).toBe("unknown");
  });

  it("returns unknown with empty paths for empty input", () => {
    expect(classifyGitError("")).toEqual({ kind: "unknown", paths: [], raw: "" });
  });
});

describe("parseBlockedPaths", () => {
  it("collects tab-indented path lines only", () => {
    expect(parseBlockedPaths(CHECKOUT_LOCAL)).toEqual(["src/foo.rs", "src/bar.rs"]);
  });

  it("returns [] when there are no indented lines", () => {
    expect(parseBlockedPaths(PULL_REBASE_DIRTY)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- gitError`
Expected: FAIL — `Cannot find module './gitError'` (file not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/gitError.ts`:

```ts
/// Classify a raw git stderr string (as surfaced by `GitError::CommandFailed`)
/// into a recoverable failure kind. Case A of the error-recovery design:
/// operations blocked by local changes. Matching is on stable English
/// substrings; anything unrecognized (localized git, network/auth, divergent
/// pull, …) returns `unknown` so the caller falls back to the raw error banner.

export type GitFailureKind =
  | "local-changes-blocked"
  | "untracked-collision"
  | "unknown";

export interface GitFailure {
  kind: GitFailureKind;
  paths: string[];
  raw: string;
}

// "Your tracked local changes block this op" — checkout, merge, or pull(-rebase).
const LOCAL_CHANGES_MARKERS = [
  "would be overwritten by checkout",
  "would be overwritten by merge",
  "Please commit your changes or stash them before",
  "cannot pull with rebase: You have unstaged changes",
];

// "An untracked file would be clobbered."
const UNTRACKED_MARKER =
  "The following untracked working tree files would be overwritten by";

export function classifyGitError(stderr: string): GitFailure {
  const raw = stderr ?? "";
  if (raw.includes(UNTRACKED_MARKER)) {
    return { kind: "untracked-collision", paths: parseBlockedPaths(raw), raw };
  }
  if (LOCAL_CHANGES_MARKERS.some((m) => raw.includes(m))) {
    return { kind: "local-changes-blocked", paths: parseBlockedPaths(raw), raw };
  }
  return { kind: "unknown", paths: [], raw };
}

// git lists the offending paths on tab-indented lines beneath the message
// header (e.g. "\tsrc/foo.rs"). Collect them; the surrounding "error:" /
// "Please …" / "Aborting" lines are not tab-indented, so they never match.
// Best-effort — an empty result is fine (the dialog still functions).
export function parseBlockedPaths(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split("\n")) {
    if (line.startsWith("\t")) {
      const p = line.trim();
      if (p) out.push(p);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- gitError`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gitError.ts src/lib/gitError.test.ts
git commit -m "feat(recovery): git stderr classifier for local-change-blocked ops"
```

---

## Task 2: Backend atomic recovery commands

**Files:**
- Modify: `src-tauri/src/git/mod.rs` (trait, after the `stash_checkout` signature ~line 401)
- Modify: `src-tauri/src/git/cli.rs` (impl, after `stash_rebase` ~line 1900)
- Modify: `src-tauri/src/lib.rs` (command wrapper after `stash_checkout` ~line 300; registration in `generate_handler!` after `stash_checkout,` ~line 746)
- Modify: `src/lib/git.ts` (bindings after `stashCheckout` ~line 116)

**Interfaces:**
- Consumes: existing `run` / `run_network` / `write_lock` / `drop_session` / `validate_ref` on `GitCli`.
- Produces:
  - Rust: `fn stash_pull(&self, path: &Path, rebase: bool) -> Result<(), GitError>`, `fn stash_merge(&self, path: &Path, branch: &str) -> Result<(), GitError>`
  - Tauri commands: `stash_pull(path, rebase)`, `stash_merge(path, branch)`
  - JS: `stashPull(path: string, rebase: boolean): Promise<void>`, `stashMerge(path: string, branch: string): Promise<void>`

- [ ] **Step 1: Add the trait signatures**

In `src-tauri/src/git/mod.rs`, immediately after the `stash_checkout` signature (the line `fn stash_checkout(&self, path: &Path, ref_name: &str) -> Result<(), GitError>;`), add:

```rust
    /// Stash local changes (tracked + untracked), pull, then reapply the stash.
    /// Mirrors `stash_checkout`: a clean pull reapplies; a pull that conflicts
    /// leaves the op in progress and keeps the stash for manual reapply. `rebase`
    /// adds `--rebase`.
    fn stash_pull(&self, path: &Path, rebase: bool) -> Result<(), GitError>;
    /// Stash local changes (tracked + untracked), merge `branch`, then reapply.
    /// Same clean/conflict semantics as `stash_pull`.
    fn stash_merge(&self, path: &Path, branch: &str) -> Result<(), GitError>;
```

- [ ] **Step 2: Add the impls**

In `src-tauri/src/git/cli.rs`, immediately after the closing brace of `fn stash_rebase` (~line 1900, before `fn fetch`), add:

```rust
    fn stash_pull(&self, path: &Path, rebase: bool) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        // Stash everything so the pull runs on a clean tree. Manual stash→pull→pop
        // (not `--autostash`) so a conflicting reapply can't wedge the op — same
        // stance as stash_rebase.
        self.run(path, &["stash", "push", "--include-untracked", "-m",
            "riff: auto-stash before pull"])?;
        let mut args = vec!["pull"];
        if rebase {
            args.push("--rebase");
        }
        if let Err(e) = self.run_network(path, &args) {
            // Pull conflicted (or failed) — leave the stash for the user to
            // reapply after resolving; surface the error so the conflict UI (or
            // banner) engages.
            self.drop_session();
            return Err(e);
        }
        // Clean pull → reapply. A pop conflict keeps the stash and writes markers;
        // propagate so the UI reports it (like stash_checkout).
        let reapply = self.run(path, &["stash", "pop"]);
        self.drop_session();
        reapply.map(|_| ())
    }

    fn stash_merge(&self, path: &Path, branch: &str) -> Result<(), GitError> {
        let _w = self.write_lock.lock().unwrap();
        validate_ref(branch)?;
        self.run(path, &["stash", "push", "--include-untracked", "-m",
            "riff: auto-stash before merge"])?;
        if let Err(e) = self.run(path, &["merge", branch]) {
            self.drop_session();
            return Err(e);
        }
        let reapply = self.run(path, &["stash", "pop"]);
        self.drop_session();
        reapply.map(|_| ())
    }
```

- [ ] **Step 3: Add the Tauri command wrappers**

In `src-tauri/src/lib.rs`, immediately after the `stash_checkout` command (the block ending `state.stash_checkout(Path::new(&path), &ref_name)` + its closing `}`), add:

```rust
#[tauri::command]
async fn stash_pull(
    state: tauri::State<'_, GitCli>,
    path: String,
    rebase: bool,
) -> Result<(), GitError> {
    state.stash_pull(Path::new(&path), rebase)
}

#[tauri::command]
async fn stash_merge(
    state: tauri::State<'_, GitCli>,
    path: String,
    branch: String,
) -> Result<(), GitError> {
    state.stash_merge(Path::new(&path), &branch)
}
```

- [ ] **Step 4: Register the commands**

In `src-tauri/src/lib.rs`, in the `tauri::generate_handler![...]` list, find the line `            stash_checkout,` and add directly below it:

```rust
            stash_pull,
            stash_merge,
```

- [ ] **Step 5: Add the JS bindings**

In `src/lib/git.ts`, immediately after the `stashCheckout` function (~line 116), add:

```ts
/** Stash local changes, pull, then reapply — recovery for a pull blocked by local changes. */
export function stashPull(path: string, rebase: boolean): Promise<void> {
  return invoke("stash_pull", { path, rebase });
}

/** Stash local changes, merge `branch`, then reapply — recovery for a merge blocked by local changes. */
export function stashMerge(path: string, branch: string): Promise<void> {
  return invoke("stash_merge", { path, branch });
}
```

- [ ] **Step 6: Verify it compiles (both sides)**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS — no errors (a missing trait impl or unregistered command would fail here).

Run: `npm run check`
Expected: PASS — no TypeScript/Svelte errors.

- [ ] **Step 7 (optional manual smoke): call from devtools**

With the app running (`npm run tauri dev`), in a repo with a dirty tracked file, open devtools console and run
`await window.__TAURI__.core.invoke("stash_pull", { path: "<repo path>", rebase: false })`.
Expected: no throw; the working-tree change is preserved (stashed, pulled, popped).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/git/mod.rs src-tauri/src/git/cli.rs src-tauri/src/lib.rs src/lib/git.ts
git commit -m "feat(recovery): atomic stash_pull/stash_merge backend commands"
```

---

## Task 3: Recovery state, dialog, mount, and banner dismiss

**Files:**
- Modify: `src/lib/store.svelte.ts` (after `checkoutPrompt` ~line 180)
- Create: `src/lib/ui/OpRecoveryDialog.svelte`
- Modify: `src/routes/+page.svelte` (import ~line 17; render ~line 427)
- Modify: `src/lib/ui/InputBar.svelte` (banner ~lines 218-220 + `.error` CSS ~line 249)

**Interfaces:**
- Consumes: `appState`, `enterChangesMode` (`sourceControl.ts`), `confirmAction` (`dialogs.ts`).
- Produces:
  - `appState.recovery` — shape:
    ```ts
    {
      op: "checkout" | "pull" | "merge";
      title: string;
      reason: string;
      paths: string[];
      offerDiscard: boolean;
      retry: (strategy: "stash" | "discard") => Promise<void>;
    } | null
    ```
  - `OpRecoveryDialog` mounted globally; renders only when `appState.recovery` is set.

- [ ] **Step 1: Add the `recovery` state field**

In `src/lib/store.svelte.ts`, immediately after the `checkoutPrompt` declaration (the block ending `} | null>(null);` at ~line 180), add:

```ts
  // Reactive recovery prompt for an op refused by local changes (error-recovery
  // design, case A). Set by the op wrappers via offerRecovery() when
  // classifyGitError flags a recoverable failure; read by OpRecoveryDialog.
  // `retry` re-runs the op with a strategy ("stash" always; "discard" only when
  // offerDiscard). null = closed. Session-only.
  recovery = $state<{
    op: "checkout" | "pull" | "merge";
    title: string;
    reason: string;
    paths: string[];
    offerDiscard: boolean;
    retry: (strategy: "stash" | "discard") => Promise<void>;
  } | null>(null);
```

- [ ] **Step 2: Create the recovery dialog**

Create `src/lib/ui/OpRecoveryDialog.svelte`:

```svelte
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { enterChangesMode } from "$lib/sourceControl";
  import { confirmAction } from "$lib/dialogs";

  let busy = $state(false);

  function close() {
    if (busy) return;
    // The caller restored the raw message into appState.error on the failure
    // path, so cancelling hides nothing.
    appState.recovery = null;
  }

  async function run(strategy: "stash" | "discard") {
    const r = appState.recovery;
    if (!r || busy) return;
    if (strategy === "discard") {
      const ok = await confirmAction(
        "Discard local changes to tracked files, then continue? This cannot be undone.",
        { title: "Discard changes" },
      );
      if (!ok) return;
    }
    busy = true;
    try {
      await r.retry(strategy);
      appState.recovery = null;
    } catch (e) {
      // The retry's own wrapper already surfaces failures; clear the dialog and
      // make sure the message is visible.
      appState.recovery = null;
      appState.error = String(e);
    } finally {
      busy = false;
    }
  }

  function commitFirst() {
    if (busy) return;
    appState.recovery = null;
    void enterChangesMode();
  }

  function onKey(e: KeyboardEvent) {
    if (appState.recovery && e.key === "Escape") {
      e.stopImmediatePropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if appState.recovery}
  {@const r = appState.recovery}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={close} role="presentation">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={r.title}
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <h2>{r.title}</h2>
      <p>{r.reason}</p>

      {#if r.paths.length > 0}
        <ul class="paths">
          {#each r.paths as p (p)}
            <li><code>{p}</code></li>
          {/each}
        </ul>
      {/if}

      <div class="opts">
        <button
          type="button"
          class="opt"
          disabled={busy}
          onclick={() => run("stash")}
        >
          <span class="opt-title">Stash &amp; continue</span>
          <span class="opt-desc">
            Stash your changes, run the operation, then restore them. Reversible.
          </span>
        </button>
        {#if r.offerDiscard}
          <button
            type="button"
            class="opt danger"
            disabled={busy}
            onclick={() => run("discard")}
          >
            <span class="opt-title">Discard changes</span>
            <span class="opt-desc">
              Throw away local changes to tracked files, then continue.
              <strong>Cannot be undone.</strong>
            </span>
          </button>
        {/if}
        <button type="button" class="opt" disabled={busy} onclick={commitFirst}>
          <span class="opt-title">Commit first</span>
          <span class="opt-desc">Go to the Working view to commit, then retry.</span>
        </button>
      </div>

      <div class="actions">
        <button type="button" class="cancel" disabled={busy} onclick={close}>
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  .dialog {
    width: 440px;
    max-width: calc(100vw - 32px);
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
    padding: 16px 18px;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 1.05em;
    font-weight: 600;
  }
  p {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .paths {
    margin: 0 0 12px;
    padding-left: 18px;
    max-height: 140px;
    overflow: auto;
  }
  .paths li {
    font-size: 0.82em;
  }
  .paths code {
    font-family: var(--mono);
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .opt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
  }
  .opt:hover:not(:disabled) {
    background: var(--hover);
    border-color: var(--accent);
  }
  .opt:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .opt-title {
    font-weight: 600;
    font-size: 0.92em;
  }
  .opt-desc {
    font-size: 0.8em;
    color: var(--muted);
  }
  .opt.danger:hover:not(:disabled) {
    border-color: var(--error-fg, #d33);
  }
  .opt.danger .opt-title {
    color: var(--error-fg, #d33);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 14px;
  }
  .cancel {
    padding: 5px 14px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
  }
  .cancel:hover:not(:disabled) {
    background: var(--hover);
  }
</style>
```

- [ ] **Step 3: Mount the dialog**

In `src/routes/+page.svelte`, after the import `import CheckoutDialog from "$lib/ui/CheckoutDialog.svelte";` (~line 17), add:

```svelte
  import OpRecoveryDialog from "$lib/ui/OpRecoveryDialog.svelte";
```

Then, after the `<CheckoutDialog />` line (~line 427), add:

```svelte
  <OpRecoveryDialog />
```

- [ ] **Step 4: Add the banner dismiss**

In `src/lib/ui/InputBar.svelte`, replace the error block (~lines 218-220):

```svelte
{#if appState.error}
  <div class="error">{appState.error}</div>
{/if}
```

with:

```svelte
{#if appState.error}
  <div class="error">
    <span class="error-msg">{appState.error}</span>
    <button
      type="button"
      class="error-x"
      aria-label="Dismiss error"
      onclick={() => (appState.error = null)}
    >
      ×
    </button>
  </div>
{/if}
```

Then replace the `.error` rule in the `<style>` block (~line 249):

```css
  .error {
    padding: 6px 10px;
    background: var(--error-bg);
    color: var(--error-fg);
    font-size: 0.85em;
    white-space: pre-wrap;
  }
```

with:

```css
  .error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 10px;
    background: var(--error-bg);
    color: var(--error-fg);
    font-size: 0.85em;
  }
  .error-msg {
    flex: 1;
    white-space: pre-wrap;
  }
  .error-x {
    flex: 0 0 auto;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
    padding: 0 2px;
    opacity: 0.8;
  }
  .error-x:hover {
    opacity: 1;
  }
```

- [ ] **Step 5: Verify it compiles**

Run: `npm run check`
Expected: PASS — no TypeScript/Svelte errors.

- [ ] **Step 6 (manual): dialog renders and dismiss works**

With `npm run tauri dev` running: trigger any error (e.g. dismiss test — cause a failing op) and confirm the banner now shows an `×` that clears it. The recovery dialog itself is exercised end-to-end in Task 4.

- [ ] **Step 7: Commit**

```bash
git add src/lib/store.svelte.ts src/lib/ui/OpRecoveryDialog.svelte src/routes/+page.svelte src/lib/ui/InputBar.svelte
git commit -m "feat(recovery): recovery dialog, state, and dismissable error banner"
```

---

## Task 4: Wire classification into checkout / pull / merge

**Files:**
- Create: `src/lib/recovery.ts`
- Modify: `src/lib/checkout.ts` (`requestCheckout` catch ~lines 109-114)
- Modify: `src/lib/sourceControl.ts` (`runSync` ~line 342, `doPull` ~line 487, `doMergeBranch` ~line 379)

**Interfaces:**
- Consumes: `classifyGitError` (Task 1); `stashPull` / `stashMerge` (Task 2); `appState.recovery` (Task 3); existing `runCheckout` (`checkout.ts`), `runSync` / `refreshActiveView` / `loadPendingOp` / `loadStashes` (`sourceControl.ts`).
- Produces: `offerRecovery(raw, op, title, offerDiscard, retry): boolean` in `src/lib/recovery.ts`.

- [ ] **Step 1: Create the `offerRecovery` helper**

Create `src/lib/recovery.ts`:

```ts
import { appState } from "./store.svelte";
import { classifyGitError } from "./gitError";

type BlockedOp = "checkout" | "pull" | "merge";

const REASON: Record<"local-changes-blocked" | "untracked-collision", string> = {
  "local-changes-blocked": "Your local changes would be overwritten.",
  "untracked-collision": "Untracked files would be overwritten.",
};

/// If `raw` is a "blocked by local changes" failure, open the recovery dialog
/// (returns true). Otherwise returns false so the caller surfaces the raw error.
/// `retry` re-runs the op with the chosen strategy ("stash" always; "discard"
/// only when offerDiscard).
export function offerRecovery(
  raw: string,
  op: BlockedOp,
  title: string,
  offerDiscard: boolean,
  retry: (strategy: "stash" | "discard") => Promise<void>,
): boolean {
  const f = classifyGitError(raw);
  if (f.kind !== "local-changes-blocked" && f.kind !== "untracked-collision") {
    return false;
  }
  appState.recovery = {
    op,
    title,
    reason: REASON[f.kind],
    paths: f.paths,
    offerDiscard,
    retry,
  };
  return true;
}
```

- [ ] **Step 2: Wire checkout**

In `src/lib/checkout.ts`, add the import near the top (below the existing `./workspace` import):

```ts
import { offerRecovery } from "./recovery";
```

Then replace the `requestCheckout` catch body (~lines 109-114):

```ts
  try {
    await runCheckout(repoPath, target, "bring", ffTo);
  } catch (e) {
    appState.error = String(e);
    void loadPendingOp();
  }
```

with:

```ts
  try {
    await runCheckout(repoPath, target, "bring", ffTo);
  } catch (e) {
    const raw = String(e);
    const handled = offerRecovery(
      raw,
      "checkout",
      `Switch to ${target}`,
      true, // discard is free for checkout (force_checkout exists)
      (strategy) =>
        runCheckout(repoPath, target, strategy === "discard" ? "discard" : "stash", ffTo),
    );
    if (!handled) {
      appState.error = raw;
      void loadPendingOp();
    }
  }
```

- [ ] **Step 3: Wire pull**

In `src/lib/sourceControl.ts`, add to the imports from `./git` (the existing block) `stashPull` and `stashMerge`, and add a new import line:

```ts
import { offerRecovery } from "./recovery";
```

Give `runSync` an optional error hook — replace its signature and catch:

```ts
async function runSync(op: Promise<void>, label: string): Promise<void> {
```

with:

```ts
async function runSync(
  op: Promise<void>,
  label: string,
  onError?: (raw: string) => boolean,
): Promise<void> {
```

and replace the catch inside `runSync`:

```ts
  } catch (e) {
    appState.error = String(e);
  } finally {
```

with:

```ts
  } catch (e) {
    const raw = String(e);
    // onError returning true means it opened a recovery dialog — don't also
    // show the raw banner.
    if (!onError || !onError(raw)) appState.error = raw;
  } finally {
```

Then replace `doPull` (~line 487):

```ts
export function doPull(rebase: boolean): Promise<void> {
  return runSync(pullCmd(changesRepoPath(), rebase), "Pulling…");
}
```

with:

```ts
export function doPull(rebase: boolean): Promise<void> {
  const repo = changesRepoPath();
  return runSync(pullCmd(repo, rebase), "Pulling…", (raw) =>
    offerRecovery(raw, "pull", "Pull couldn't complete", false, () =>
      runSync(stashPull(repo, rebase), "Stashing & pulling…"),
    ),
  );
}
```

- [ ] **Step 4: Wire merge**

In `src/lib/sourceControl.ts`, replace `doMergeBranch` (~lines 379-393):

```ts
export async function doMergeBranch(branch: string): Promise<void> {
  appState.beginGitOp("Merging…");
  appState.error = null;
  try {
    await mergeCmd(changesRepoPath(), branch);
  } catch (e) {
    appState.error = String(e);
  } finally {
    const err = appState.error;
    await refreshActiveView();
    await loadPendingOp();
    if (err) appState.error = err;
    appState.endGitOp();
  }
}
```

with:

```ts
export async function doMergeBranch(branch: string): Promise<void> {
  const repo = changesRepoPath();
  appState.beginGitOp("Merging…");
  appState.error = null;
  try {
    await mergeCmd(repo, branch);
  } catch (e) {
    const raw = String(e);
    if (!offerRecovery(raw, "merge", `Merge ${branch}`, false, () => doStashMerge(repo, branch))) {
      appState.error = raw;
    }
  } finally {
    const err = appState.error;
    await refreshActiveView();
    await loadPendingOp();
    if (err) appState.error = err;
    appState.endGitOp();
  }
}

// Recovery retry for a merge blocked by local changes: stash → merge → pop.
async function doStashMerge(repo: string, branch: string): Promise<void> {
  appState.beginGitOp("Stashing & merging…");
  appState.error = null;
  try {
    await stashMerge(repo, branch);
  } catch (e) {
    appState.error = String(e);
  } finally {
    const err = appState.error;
    await refreshActiveView();
    await loadPendingOp();
    await loadStashes();
    if (err) appState.error = err;
    appState.endGitOp();
  }
}
```

- [ ] **Step 5: Verify it compiles + unit tests still green**

Run: `npm run check`
Expected: PASS — no TypeScript/Svelte errors.

Run: `npm test`
Expected: PASS — the Task 1 classifier suite (and all existing suites) green.

- [ ] **Step 6: Manual end-to-end verification**

With `npm run tauri dev` running, in a scratch repo (the dogfood repo works):

1. **Untracked collision (checkout, case A-2):** on `main`, commit a file `x.txt`; switch to a branch without it; create an untracked `x.txt` with different content; double-click `main` to switch. → Recovery dialog "Switch to main", reason "Untracked files would be overwritten", `x.txt` listed. Click **Stash & continue** → switches to `main`, your `x.txt` restored (or a stash-pop conflict shown if it clashes).
2. **Pull, dirty tree (case A-3):** modify a tracked file without committing; click **Pull**. → Recovery dialog "Pull couldn't complete". **Stash & continue** → pulls, your change reapplied. (If the pull merges with content conflicts, the ConflictBanner engages — expected.)
3. **Merge, dirty tree:** with a tracked change uncommitted, right-click a branch → **Merge into current**. → Recovery dialog "Merge <branch>". **Stash & continue** → merges, change reapplied.
4. **Discard (checkout only):** repeat (1) but click **Discard changes** → confirm → switches, local change gone.
5. **Unknown passthrough:** trigger an unrelated failure (e.g. pull with no upstream) → no recovery dialog; raw banner appears with a working **×** dismiss.
6. **Cancel:** trigger (2), click **Cancel** → dialog closes, raw git message visible in the banner.

- [ ] **Step 7: Commit**

```bash
git add src/lib/recovery.ts src/lib/checkout.ts src/lib/sourceControl.ts
git commit -m "feat(recovery): route local-change-blocked checkout/pull/merge to recovery"
```

---

## Self-Review

**Spec coverage** (against `2026-07-13-op-error-recovery-design.md`):
- Reactive classification → Task 1 (`gitError.ts`) + Task 4 wiring. ✓
- Atomic `stash_pull` / `stash_merge` mirroring `stash_checkout` → Task 2. ✓
- Recovery dialog (Stash / Discard[checkout] / Commit first / Cancel) → Task 3. ✓
- `appState.recovery` mirroring `checkoutPrompt` → Task 3 Step 1. ✓
- Wiring at `requestCheckout` / `doPull` / `doMergeBranch` → Task 4. ✓
- Classifier unit tests (`gitError.test.ts`) incl. unknown/auth/divergent negatives → Task 1. ✓
- Banner dismiss → Task 3 Step 4. ✓
- Mount in `+page.svelte` → Task 3 Step 3. ✓
- Edge cases (non-English locale → unknown; stash-pop conflict propagates; submodule via `changesRepoPath()`) → covered by classifier fall-through, `stash_*` pop propagation, and existing repo-path routing. ✓
- Out of scope held: pull/merge discard (`offerDiscard: false` for both); cases B–D (classifier returns `unknown`). ✓

**Type consistency:** `GitFailure`/`classifyGitError` (T1) consumed by `offerRecovery` (T4). `stashPull`/`stashMerge` signatures (T2) match call sites (T4). `appState.recovery` shape (T3) matches what `offerRecovery` writes (T4) and what `OpRecoveryDialog` reads (T3). `retry(strategy)` type identical across store, dialog, and helper. ✓

**Placeholder scan:** every code step contains full code; manual-verification steps list concrete repro sequences. No TBD/TODO. ✓

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.
