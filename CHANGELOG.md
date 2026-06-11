# Changelog

All notable changes to Riff are documented here. The top section is published
as the GitHub Release body by `.github/workflows/release.yml`.

## v1.0.0

Riff grows from a two-branch diff viewer into a full Git client. Everything
from the 0.x line is still here; 1.0.0 adds a complete source-control
workspace alongside it.

### Source control (Changes)
- A dedicated **Changes** workspace driven by `git status --porcelain=v2`.
- **Changelists** (Perforce / JetBrains style): group changed files into named
  buckets and commit each independently. Drag files between lists or use the
  right-click menu; assignments persist per repo.
- Commit box with subject/body, sign-off, and co-author trailers.
- Unreal `.uasset` / `.umap` property views derived via the bundled UAssetGUI,
  right in the Changes diff.

### Branches & graph history
- A **Graph** history workspace with a commit graph, branch/tag badges, and
  per-commit actions.
- Refs sidebar with checkout, create, rename, delete, and Fork-style
  Working Copy / Graph navigation.
- Co-located local + remote branches merge into one badge; adjustable row
  density and a reset-to-all-branches control.
- **Drag-and-drop merge / rebase** between branch badges.
- A **WIP node** surfaces uncommitted changes above HEAD; the graph refreshes
  on window-focus regain.

### Sync, merge & stash
- Toolbar **fetch / pull / push** with ahead/behind counts.
- **Merge** with an in-app **3-way conflict resolver**, plus abort / continue.
- Checkout with local changes (stash-and-reapply / leave / discard), and
  remote checkout with fast-forward.
- **Stash** save / apply / pop / drop.

### Diff & navigation
- **Image diff**: side-by-side / swipe / onion modes with zoom and pan.
- Diff falls back to inline when the pane is narrow.
- **Command palette** (`Ctrl+Shift+P`).
- Filter box in the file picker.

### Blame
- **File timelapse**: play or scrub through every revision of a file, with a
  hybrid view (content anchored, changed lines highlighted), a VS-style minimap
  with add/delete bars, and syntax highlighting on settled frames.

### Packaging
- A self-contained, single-file **UAssetGUI** is bundled at release time, so
  Unreal asset previews work with zero setup.

---

Earlier releases (0.x) are tracked in the
[GitHub releases](https://github.com/HyunwookYoo/riff/releases) history.
